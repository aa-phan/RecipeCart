// Ingredient -> Kroger product matcher (Spec 3 §2.2). Entry point is
// `matchRecipe(ingredients, locationId)`, decoupled from DB timing per the
// spec's own recommendation — it takes `Ingredient[]` objects directly.
// `matchRecipeAndPersist` is a thin optional wrapper for callers that do
// want the `product_matches` table populated from an already-persisted
// recipe's ingredient rows.
import { randomUUID } from "node:crypto";
import type { Ingredient } from "../pipeline/schema.js";
import { getAppToken } from "../kroger/auth.js";
import { searchProducts } from "../kroger/client.js";
import type { KrogerProductItem } from "../kroger/types.js";
import { getDb } from "../platform/db.js";
import { logger } from "../platform/logger.js";
import { config } from "../platform/config.js";
import {
  computeUnitPrice,
  quantityFitScore,
  textRelevanceScore,
  type QuantityFit,
} from "./rank.js";
import { isSeasoning } from "./seasonings.js";
import { judgeMateriality, type MaterialityCase } from "./materiality.js";
import type { IngredientMatch, ProductCandidate } from "./types.js";

export type { IngredientMatch, ProductCandidate } from "./types.js";

// Candidates whose rankScore is within this margin of the top candidate are
// considered genuinely ambiguous (P1 stand-in for Claude-delegated
// disambiguation, deferred to P2 — see module doc below).
const AMBIGUITY_MARGIN = 1.5;
// Max candidates surfaced per ingredient (display + storage cleanliness).
const MAX_CANDIDATES = 5;
// Kroger search result page size to scan for candidates per ingredient —
// Kroger's Products API hard-rejects anything above 50 (confirmed live:
// PRODUCT-2013 "limit must be a number between 1 and 50"), so this is the
// real ceiling, not an arbitrary choice. A smaller limit (previously 10)
// silently truncates the response BEFORE ranking ever runs — found via a
// live query: "chicken breast" against a real store returned covering
// packages (3 lb, 2.25 lb) only when queried past position 10, so a
// genuinely-available covering package was invisible to the matcher and
// got wrongly flagged requires_approval as "no package covers the need."
const SEARCH_LIMIT = 50;

/** An item is only a real candidate if it can actually be obtained. Kroger's
 * Products API signals this two ways, BOTH of which have to pass — found
 * live (2026-07-18) that items failing either still get returned by search
 * and were being added to real carts as "unavailable":
 *   - inventory.stockLevel !== TEMPORARILY_OUT_OF_STOCK (when reported at
 *     all; frequently null, which is NOT treated as out-of-stock on its own).
 *   - at least one fulfillment method (curbside/delivery/inStore/shipToHome)
 *     is true. An item with all four false cannot be ordered through ANY
 *     channel — e.g. a "Philadelphia Garlic & Herb Cream Cheese" that
 *     reported stockLevel HIGH but every fulfillment flag false, and showed
 *     up in the cart as unavailable. */
function isOrderable(item: KrogerProductItem): boolean {
  if (item.inventory?.stockLevel === "TEMPORARILY_OUT_OF_STOCK") return false;
  const f = item.fulfillment;
  return f.curbside || f.delivery || f.inStore || f.shipToHome;
}

// Words that mark a product as PREPARED/pre-flavored rather than the plain
// raw ingredient a recipe calls for. When one of these appears in a
// candidate's description but NOT in the ingredient's own name, the
// candidate is penalized (not excluded) so a plain product wins when one
// exists, but a prepared product can still surface (flagged) as a last
// resort. Found live: "El Rey Achiote SEASONED Boneless Chicken Thighs" and
// "Sea Salt & Cracked Black Pepper ROASTED Frozen Redskin Potatoes" were
// winning over plain raw versions purely on package-fit math. "frozen" is
// deliberately NOT here — frozen raw chicken/veg is a fine plain match.
const PREPARED_KEYWORDS = [
  // prepared / pre-flavored
  "seasoned",
  "marinated",
  "roasted",
  "grilled",
  "breaded",
  "fried",
  "smoked",
  "glazed",
  "flavored",
  "achiote",
  "teriyaki",
  "bbq",
  "barbecue",
  "buffalo",
  "rotisserie",
  "cracked black pepper",
  "rinds",
];
// NOTE: deliberately NOT including form words like "ground"/"shaved"/"deli"
// here. They tried to keep whole raw cuts ahead of processed forms (ground
// chicken breast, deli/shaved meat), but that job is already done by the
// soldBy=WEIGHT handling below (whole raw meat/produce is weight-sold and
// competes as a qty-1 covering package) and by text relevance ("shaved
// chicken" lacks the word "breast" and scores low on its own). Worse,
// "ground" misfires on spices — "ground paprika"/"ground cumin" are the
// normal, correct product, not a downgrade — so penalizing it picked a
// pricier non-ground paprika over the right one.
const PREPARED_PENALTY = 0.6;

/** Penalty to subtract from a candidate's text-relevance score when its
 * description looks like a prepared/pre-flavored product but the ingredient
 * name doesn't ask for that (e.g. plain "chicken breast" vs "achiote
 * seasoned chicken breast"). 0 when the ingredient itself contains the
 * keyword (so "italian seasoning" isn't penalized for the word "seasoned").
 * Deliberately a penalty, not an exclusion — keeps prepared items available
 * as a flagged last resort when nothing plainer exists. */
function preparedPenalty(scoringName: string, description: string): number {
  const desc = description.toLowerCase();
  const name = scoringName.toLowerCase();
  for (const kw of PREPARED_KEYWORDS) {
    if (desc.includes(kw) && !name.includes(kw)) return PREPARED_PENALTY;
  }
  return 0;
}

function compareCandidates(a: ProductCandidate, b: ProductCandidate): number {
  const diff = b.rankScore - a.rankScore;
  if (Math.abs(diff) > 0.01) return diff;
  if (a.unitPrice != null && b.unitPrice != null) return a.unitPrice - b.unitPrice;
  return diff;
}

/** No-stated-quantity / seasoning default ordering (Spec 3 §2.2 step 3a):
 * best NAME match first (a clearly better-matched product always wins —
 * RELEVANCE_GAP_THRESHOLD), then cheapest total price. Replaced an earlier
 * "physically smallest package" rule that, live, picked absurd specialty
 * items — e.g. a tiny 1.75oz "Florida Pure Sea Salt" ($8.99) over "Kroger®
 * Salt" 26oz ($0.99) purely because 1.75oz is a smaller number, and a
 * "Parmigiano Reggiano Rinds" (size "1 ct", magnitude 1) over real grated
 * parmesan because a bare count compared as smaller than any weight. Cheapest
 * price is both more sensible ("I just need some salt") and naturally avoids
 * those specialty-priced outliers. */
function compareByRelevanceThenPrice(a: ScoredCandidate, b: ScoredCandidate): number {
  const relevanceDiff = b.textScore - a.textScore;
  if (Math.abs(relevanceDiff) >= RELEVANCE_GAP_THRESHOLD) return relevanceDiff;
  const pa = a.candidate.price;
  const pb = b.candidate.price;
  if (pa != null && pb != null) return pa - pb;
  if (pa != null) return -1;
  if (pb != null) return 1;
  return 0;
}

interface ScoredCandidate {
  candidate: ProductCandidate;
  qFit: QuantityFit | null;
  textScore: number;
  // True when this candidate only turned up via the broadened fallback
  // search (below), not the ingredient's own specific-name search — always
  // flagged for approval regardless of quantity fit, since dropping a
  // descriptive word to find it means we can no longer be confident it's
  // the same product (Spec 3 §2.2: a different-ingredient stand-in is a
  // *material* substitution, "when in doubt → material" — Claude-delegated
  // materiality judgment is [P2], not something this deterministic ranking
  // can safely decide on its own).
  fromBroadenedSearch: boolean;
}

interface BroadenedSearch {
  term: string;
  // The word dropped to build `term`, when it should be REQUIRED back in a
  // candidate's description (see searchAndBuildCandidates's `requiredWord`)
  // — null when it should NOT be required. These mean different things
  // depending on which word was dropped:
  //   - Dropping the TRAILING word is usually dropping the category noun
  //     ("cheese" in "garlic & herb cream cheese") — broadening the QUERY is
  //     safe, but without requiring that word back, a same-token-overlap
  //     candidate from a completely different category can score just as
  //     well. Confirmed live: dropping "cheese" to search "garlic & herb
  //     cream" surfaced both a genuine alternative AND "Soules Kitchen
  //     Creamy Garlic & Herb CHICKEN" at an identical relevance score
  //     ("cream" fuzzy-matches "creamy" regardless of cheese vs. meat).
  //     Requiring "cheese" back throws out the chicken, keeps the cheese.
  //   - Dropping the LEADING word is usually dropping a descriptive
  //     modifier ("Light" in "Light Garlic & Herb Cream Cheese") — the
  //     whole point is finding the product WITHOUT that modifier, so
  //     requiring it back would defeat the broadening entirely. Confirmed
  //     live: Kroger's search returned 0 results for "Light Garlic & Herb
  //     Cream Cheese" verbatim; dropping "Cheese" (trailing) ALSO returned
  //     0 — "Light" was the actual problem word, not "Cheese". Dropping
  //     "Light" (leading) found the real candidates. No requiredWord here;
  //     ordinary text-relevance scoring against the full original name is
  //     the safety net instead, plus `fromBroadenedSearch` still forces
  //     approval regardless of which strategy found the pick.
  droppedWord: string | null;
}

/** Builds up to two broader fallback search terms (Spec 3 §2.2 step 2) by
 * dropping one whitespace-separated word — trailing, then leading — e.g.
 * "garlic & herb cream cheese" -> "garlic & herb cream" (trailing) and
 * "Light Garlic & Herb Cream Cheese" -> "Garlic & Herb Cream Cheese"
 * (leading). Tried in this order by the caller, stopping at the first
 * strategy that returns any candidates. Live-tested: a single direction
 * isn't enough — the "problem word" that makes Kroger's own search return
 * nothing can be at either end of the name, and trying only the trailing
 * drop silently failed on a real recipe where the leading word ("Light")
 * was the actual issue. Deliberately stops at one word dropped per
 * direction — dropping to just the middle flavor words (e.g. "garlic herb")
 * returned pasta sauce, seasoning shakers, and pork chops at the exact same
 * text-relevance score as real matches, with no reliable way to tell them
 * apart locally. Returns [] for a single-word name (nothing left to drop).
 */
function broadenedSearchTerms(canonicalName: string): BroadenedSearch[] {
  const words = canonicalName.trim().split(/\s+/);
  if (words.length < 2) return [];

  const strategies: BroadenedSearch[] = [];
  const dropLast = words.slice(0, -1).join(" ").trim();
  if (dropLast.length > 0) {
    strategies.push({ term: dropLast, droppedWord: words[words.length - 1]!.toLowerCase() });
  }
  const dropFirst = words.slice(1).join(" ").trim();
  if (dropFirst.length > 0 && dropFirst !== dropLast) {
    strategies.push({ term: dropFirst, droppedWord: null });
  }
  return strategies;
}

/** Searches Kroger and builds scored candidates for one query term. Always
 * scores text relevance and quantity fit against `scoringName` (the
 * ingredient's real canonical name) even when `searchTerm` is a broadened
 * fallback query — the broadening only widens what Kroger's own search
 * returns, it never loosens the local relevance/quantity checks.
 * `requiredWord`, when set, additionally excludes any candidate whose
 * description doesn't contain it — see BroadenedSearch.droppedWord's doc for
 * why this matters specifically for broadened-search candidates. */
async function searchAndBuildCandidates(
  searchTerm: string,
  scoringName: string,
  quantity: Ingredient["quantity"],
  useSmallestPackageDefault: boolean,
  locationId: string,
  appToken: string,
  fromBroadenedSearch: boolean,
  requiredWord?: string,
): Promise<ScoredCandidate[]> {
  const response = await searchProducts(searchTerm, locationId, appToken, SEARCH_LIMIT);
  const results: ScoredCandidate[] = [];

  for (const product of response.data) {
    if (requiredWord && !product.description.toLowerCase().includes(requiredWord)) continue;

    const rawTextScore = textRelevanceScore(scoringName, product.description);
    if (rawTextScore === null) continue; // no meaningful overlap — excluded, not just penalized
    // Down-weight prepared/pre-flavored products so a plain raw match wins
    // when one exists (kept, not excluded — see preparedPenalty). Floored
    // just above 0 so a penalized-but-only candidate still survives the
    // null-exclusion gate above rather than vanishing entirely.
    const textScore = Math.max(0.01, rawTextScore - preparedPenalty(scoringName, product.description));

    for (const item of product.items) {
      if (!isOrderable(item)) continue;

      // A WEIGHT-sold item's `size` (e.g. "1 lb") is a price-per-unit basis,
      // NOT the package size — package-count coverage math is meaningless for
      // it (this is what produced the nonsensical "buy 2" of a ~5lb
      // variable-weight chicken breast pack for an 800g need). Model it as
      // what it actually is: one variable-weight package, ordered as
      // quantity 1, which for a normal recipe amount over-covers. Treated as
      // a valid covering fit at qty 1 so plain meat/produce sold by weight
      // competes on equal footing with UNIT-packaged (often more processed)
      // forms, rather than being dropped below them.
      let qFit: QuantityFit | null;
      if (useSmallestPackageDefault) {
        qFit = null;
      } else if (item.soldBy === "WEIGHT") {
        qFit = {
          score: 1,
          covers: true,
          unitsNeeded: 1,
          note: "sold by weight — 1 package (variable weight, set at pickup)",
        };
      } else {
        qFit = quantityFitScore(quantity, item.size, scoringName);
      }
      const price = item.price?.regular ?? null;
      const unitPrice = price != null ? computeUnitPrice(price, item.size) : undefined;
      const rankScore = textScore * 10 + (qFit ? qFit.score * 3 : 0);

      results.push({
        candidate: {
          productId: product.productId,
          upc: product.upc,
          name: product.description,
          brand: product.brand,
          price,
          size: item.size,
          unitPrice,
          rankScore,
          reason: qFit?.note,
          quantityToOrder: qFit?.unitsNeeded ?? 1,
        },
        qFit,
        textScore,
        fromBroadenedSearch,
      });
    }
  }
  return results;
}

/** Buckets a candidate: fully-covers-the-need (0) always beats an undersized
 * package (1), which always beats an un-scoreable one (2, unparseable size)
 * — regardless of score magnitude. See QuantityFit.covers's doc for why this
 * can't just be "sort by score." */
function coverageBucket(qFit: QuantityFit | null): 0 | 1 | 2 {
  if (qFit === null) return 2;
  return qFit.covers ? 0 : 1;
}

// A text-relevance gap at least this large is treated as "clearly a better
// name match" and wins outright, before quantity fit even gets a vote.
// Found necessary via live data: without this, "Heritage Farm® Boneless
// Skinless Chicken Breasts" (textScore 1.3 — the ingredient's full name
// literally appears in the description) lost to "Kroger® Shaved Chicken"
// (textScore 0.5 — only "chicken" overlaps, "breast" doesn't) purely
// because 3x the shaved-chicken package landed a couple percentage points
// closer to the exact needed quantity than 2x the real chicken breast.
// 0.2 is comfortably below a genuine full-name match's score (~1.0-1.3) and
// comfortably above the noise floor of a single-token partial overlap
// (~0.3-0.5) — a tunable heuristic, not a validated constant.
const RELEVANCE_GAP_THRESHOLD = 0.2;

/** "Convert to the package's unit, then pick the smallest size (or number
 * of packages) that fully covers the needed quantity" (Spec 3 §2.2 step 3).
 * Bucket by coverage FIRST — a purchase that actually covers the need
 * always wins over one that doesn't, however tight the numeric fit of the
 * non-covering option looks, because a candidate that can't be reasonably
 * purchased to meet the need isn't a real option at all. WITHIN a coverage
 * bucket, text relevance decides next: a candidate whose name clearly
 * matches the ingredient better wins over one that's merely a numerically
 * tighter package-count fit (see RELEVANCE_GAP_THRESHOLD's doc — without
 * this, "Kroger® Shaved Chicken" beat real "chicken breast" purely because
 * 3 of its packages landed a couple percentage points closer to the target
 * than 2 packages of the real thing). Only when relevance is roughly tied
 * does `qFit.score` (closest surplus) and then price decide. Known
 * remaining gap: this can't distinguish "raw potatoes" from "seasoned
 * frozen roasted potatoes" when both literally contain the word
 * "potatoes" — textRelevanceScore has no sense of preparation state, only
 * token overlap, so a single-word ingredient name with no other
 * distinguishing tokens can still tie on relevance between a raw and a
 * prepared product, falling through to fit/price same as before. */
function compareByQuantityCoverage(a: ScoredCandidate, b: ScoredCandidate): number {
  const bucketDiff = coverageBucket(a.qFit) - coverageBucket(b.qFit);
  if (bucketDiff !== 0) return bucketDiff;

  const relevanceDiff = b.textScore - a.textScore;
  if (Math.abs(relevanceDiff) >= RELEVANCE_GAP_THRESHOLD) return relevanceDiff;

  if (a.qFit && b.qFit) {
    const scoreDiff = b.qFit.score - a.qFit.score;
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
  }
  if (a.candidate.price != null && b.candidate.price != null) {
    return a.candidate.price - b.candidate.price;
  }
  return 0;
}

/** Matches a single ingredient against the Kroger catalog and ranks
 * candidates. Exported separately from matchRecipe so callers with their
 * own ingredient ids (e.g. DB rows) can call it directly. */
export async function matchIngredient(
  ingredient: Ingredient,
  ingredientId: string,
  locationId: string,
  appToken: string,
): Promise<IngredientMatch> {
  // canonical_name_en.value can be null when extraction couldn't confidently
  // name the ingredient (Spec 2 §evidencedField) — fall back to raw_text
  // rather than skipping the ingredient, and flag it for review below.
  const canonicalName = ingredient.canonical_name_en.value ?? ingredient.raw_text;
  const nameUncertain = ingredient.canonical_name_en.value === null;
  const hasQuantity = ingredient.quantity.value !== null && ingredient.quantity.value > 0;
  // Spec 3 §2.2 step 3a: an ingredient defaults to smallest-package-first
  // (skip quantity-fit scoring and the ambiguity-margin check entirely,
  // cheapest price as the tiebreak) when EITHER there's no stated amount to
  // score (vague quantity, e.g. "a pinch", or genuinely never given — no
  // signal to work with) OR it's a known small-quantity seasoning
  // (seasonings.ts) — a stated "3 tsp of salt" is real, but no reasonable
  // recipe amount of salt ever changes which shaker to buy, so scoring it
  // against package size is a distinction without a purchasing difference.
  // Quantity-fit scoring (with cross-category density conversion,
  // density.ts) is reserved for "core" bulk ingredients — meats, produce,
  // flour, sugar, oil, dairy — where portion size is a real decision (2 lb
  // of chicken vs 5 lb).
  const useSmallestPackageDefault = !hasQuantity || isSeasoning(canonicalName);

  if (!canonicalName || canonicalName.trim().length === 0) {
    return {
      ingredientId,
      canonicalName: ingredient.raw_text,
      candidates: [],
      requiresApproval: true,
      approvalReason: "no ingredient name available to search on",
      deprioritized: ingredient.is_pantry_staple,
    };
  }

  let scored: ScoredCandidate[] = [];
  let broadenedTermUsed: string | null = null;
  try {
    scored = await searchAndBuildCandidates(
      canonicalName,
      canonicalName,
      ingredient.quantity,
      useSmallestPackageDefault,
      locationId,
      appToken,
      false,
    );

    // Reach for a broadened search when it's actually load-bearing:
    //   - the specific-name search returned NOTHING at all — found live:
    //     Kroger's own search API returned zero results for "Light Garlic &
    //     Herb Cream Cheese" (verbatim from a real caption), while dropping
    //     just "Light" returned real candidates for the same underlying
    //     product. This can hit any ingredient category, seasonings and
    //     no-quantity ones included — an empty result set is a query
    //     problem, not a coverage or ambiguity problem, so it isn't gated
    //     behind `!useSmallestPackageDefault` the way the case below is.
    //   - OR (core, non-seasoning ingredients only) candidates came back but
    //     none of them cover the needed quantity.
    // Cheap to check before spending a second Kroger call.
    const foundNothing = scored.length === 0;
    const coveredAlready = scored.some((s) => s.qFit?.covers);
    const coreUncovered =
      !useSmallestPackageDefault && scored.some((s) => s.qFit !== null) && !coveredAlready;
    if (foundNothing || coreUncovered) {
      // Try trailing-drop first, then leading-drop, stopping at the first
      // strategy that actually returns something — no need to spend a third
      // Kroger call once one has already found candidates.
      for (const broadened of broadenedSearchTerms(canonicalName)) {
        const extra = await searchAndBuildCandidates(
          broadened.term,
          canonicalName,
          ingredient.quantity,
          useSmallestPackageDefault,
          locationId,
          appToken,
          true,
          broadened.droppedWord ?? undefined,
        );
        if (extra.length === 0) continue;

        broadenedTermUsed = broadened.term;
        const seenIds = new Set(scored.map((s) => s.candidate.productId));
        for (const e of extra) {
          if (!seenIds.has(e.candidate.productId)) {
            scored.push(e);
            seenIds.add(e.candidate.productId);
          }
        }
        break;
      }
    }
  } catch (err) {
    logger.error("kroger product search failed", {
      ingredientId,
      canonicalName,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ingredientId,
      canonicalName,
      candidates: [],
      requiresApproval: true,
      approvalReason: `product search failed: ${err instanceof Error ? err.message : String(err)}`,
      deprioritized: ingredient.is_pantry_staple,
    };
  }

  // A "core" ingredient (has a real quantity, not a seasoning) only gets the
  // deterministic covers-first ranking when at least one candidate actually
  // produced a usable quantity fit — otherwise there's nothing to convert
  // toward, and it falls back to the old text-score + ambiguity-margin
  // check (e.g. a stated quantity in a genuinely unparseable unit).
  const hasUsableQuantityFit = scored.some((s) => s.qFit !== null);
  const useQuantityCoverage = !useSmallestPackageDefault && hasUsableQuantityFit;

  if (useSmallestPackageDefault) {
    scored.sort(compareByRelevanceThenPrice);
  } else if (useQuantityCoverage) {
    scored.sort(compareByQuantityCoverage);
  } else {
    scored.sort((a, b) => compareCandidates(a.candidate, b.candidate));
  }
  scored = scored.slice(0, MAX_CANDIDATES);
  const candidates = scored.map((s) => s.candidate);

  let requiresApproval = false;
  let approvalReason: string | undefined;
  // Set ONLY at the two materiality-governed sites below (a broadened-search
  // pick, or a close-match ambiguity) — see IngredientMatch.substitutionCase's
  // doc. The recipe-level materiality pass (matchRecipe/matchRecipeAndPersist)
  // collects these across all ingredients and judges safe-vs-material in one
  // batched Claude call; a "safe" verdict clears requiresApproval, a
  // "material" verdict keeps it flagged with Claude's reason instead of this
  // generic one.
  let substitutionCase: IngredientMatch["substitutionCase"];

  if (candidates.length === 0) {
    requiresApproval = true;
    approvalReason = "no in-stock candidates found a relevant text match for this ingredient";
  } else if (useSmallestPackageDefault) {
    // Deterministic by construction (best name match, cheapest tiebreak) —
    // never flagged as ambiguous just because there was nothing to score.
    // EXCEPT when the top pick only turned up via the broadened search
    // (see the materiality note on ScoredCandidate.fromBroadenedSearch
    // above) — same rule as the core-ingredient path below, applied here
    // too now that broadening can fire for seasonings/no-quantity
    // ingredients on a zero-result primary search.
    if (scored[0]!.fromBroadenedSearch) {
      requiresApproval = true;
      approvalReason = `found via a broadened search ("${broadenedTermUsed}") rather than "${canonicalName}" directly — confirm "${candidates[0]!.name}" is an acceptable substitute before approving`;
      substitutionCase = {
        name: candidates[0]!.name,
        brand: candidates[0]!.brand ?? null,
        size: candidates[0]!.size ?? null,
      };
    } else {
      candidates[0]!.reason = hasQuantity
        ? "small seasoning amount — cheapest well-matched product selected regardless of stated quantity"
        : "no quantity stated — cheapest well-matched product selected";
    }
  } else if (useQuantityCoverage) {
    // "Convert to the package's unit, then pick the smallest size (or
    // smallest number of packages) that fully covers the needed quantity"
    // (Spec 3 §2.2 step 3) — deterministic by construction once a real
    // coverage signal exists, including buying multiple of a smaller
    // package (rank.ts's MAX_AUTO_MULTI_UNIT_PURCHASE caps how far that
    // auto-resolves; past that, or when even the largest available package
    // times that cap still can't reach the need, it genuinely needs a
    // human, not a spurious "scores were close" flag.
    const top = scored[0]!;
    if (top.qFit && !top.qFit.covers) {
      const broadenedNote = broadenedTermUsed
        ? ` (also tried a broadened search for "${broadenedTermUsed}")`
        : "";
      requiresApproval = true;
      approvalReason = `no reasonable purchase covers the needed quantity${broadenedNote} (best available: ${top.qFit.note})`;
    } else if (top.fromBroadenedSearch) {
      // Found only via the broadened query, not the ingredient's own name —
      // per Spec 3 §2.2, a different-named stand-in is a potential material
      // substitution, which this deterministic ranking can't safely
      // auto-approve on its own (materiality judgment is Claude-delegated,
      // [P2]). Surfacing it is still strictly better than the prior
      // behavior of never finding it at all.
      requiresApproval = true;
      approvalReason = `found via a broadened search ("${broadenedTermUsed}") rather than "${canonicalName}" directly — confirm "${top.candidate.name}" is an acceptable substitute before approving`;
      substitutionCase = {
        name: top.candidate.name,
        brand: top.candidate.brand ?? null,
        size: top.candidate.size ?? null,
      };
    }
  } else if (candidates.length >= 2) {
    const [top, second] = candidates;
    if (top!.rankScore - second!.rankScore < AMBIGUITY_MARGIN) {
      requiresApproval = true;
      approvalReason = "top candidates are closely matched; no single clearly-best product";
      substitutionCase = { name: top!.name, brand: top!.brand ?? null, size: top!.size ?? null };
    }
  }

  if (nameUncertain) {
    requiresApproval = true;
    const note = "ingredient name uncertain from extraction (matched on raw text)";
    approvalReason = approvalReason ? `${approvalReason}; ${note}` : note;
    // The uncertainty is about the INGREDIENT NAME itself, not about whether
    // a found product is a safe substitute for a known name — that's not a
    // question materiality judgment can answer, so this flag must survive
    // independently of any Claude verdict (see substitutionCase's doc).
    substitutionCase = undefined;
  }

  return {
    ingredientId,
    canonicalName,
    candidates,
    requiresApproval,
    approvalReason,
    deprioritized: ingredient.is_pantry_staple,
    substitutionCase,
  };
}

export interface MatchOptions {
  /** Skip the materiality Claude call entirely, leaving the deterministic
   * substitution flags exactly as matchIngredient set them. Parallels
   * reconcile's --mock passthrough — for zero-cost local testing of the rest
   * of the pipeline. Real runs should NOT set this. */
  skipMateriality?: boolean;
}

/** Recipe-level post-pass (Spec 3 §2.2 "Claude-delegated judgments"): collects
 * every ingredient the deterministic matcher flagged as a substitution case
 * (IngredientMatch.substitutionCase), judges them all in ONE batched Claude
 * call (materiality.ts), and applies the verdicts in place — `material:
 * false` clears requiresApproval with a "confirmed safe" reason, `material:
 * true` keeps it flagged with Claude's own reason. Mutates `results` in
 * place; also returns it for convenience. No-op (no API call) when nothing
 * was flagged, or when `skipMateriality` is set. */
async function applyMateriality(
  results: IngredientMatch[],
  options: MatchOptions,
): Promise<IngredientMatch[]> {
  if (options.skipMateriality) return results;

  const cases: MaterialityCase[] = [];
  for (const r of results) {
    if (r.substitutionCase) {
      cases.push({
        ingredientId: r.ingredientId,
        ingredientName: r.canonicalName,
        candidate: r.substitutionCase,
      });
    }
  }
  if (cases.length === 0) return results;

  const verdicts = await judgeMateriality(cases);
  for (const r of results) {
    const verdict = verdicts.get(r.ingredientId);
    if (!verdict) continue;
    if (verdict.material) {
      r.requiresApproval = true;
      r.approvalReason = verdict.reason;
    } else {
      r.requiresApproval = false;
      r.approvalReason = `confirmed safe brand/size substitution: ${verdict.reason}`;
    }
  }
  return results;
}

/** Main entry point (Spec 3 §2.2). Matches every ingredient in a recipe
 * against the Kroger catalog for the given store. Gets one app-level token
 * up front and reuses it across all ingredients in the run (tokens last 30
 * min, comfortably longer than a single recipe's worth of calls). Runs
 * sequentially — deliberately, to stay a polite, predictable citizen of
 * Kroger's documented rate limits rather than bursting requests. After all
 * ingredients are matched, runs the materiality post-pass (see
 * applyMateriality) unless `options.skipMateriality`. */
export async function matchRecipe(
  ingredients: Ingredient[],
  locationId: string,
  options: MatchOptions = {},
): Promise<IngredientMatch[]> {
  const token = await getAppToken();
  const results: IngredientMatch[] = [];
  for (let i = 0; i < ingredients.length; i++) {
    const ingredient = ingredients[i]!;
    const ingredientId = `ing-${i}`;
    results.push(await matchIngredient(ingredient, ingredientId, locationId, token.access_token));
  }
  return applyMateriality(results, options);
}

interface IngredientRow {
  id: string;
  canonical_name: string | null;
  quantity_value: number | null;
  quantity_unit: string | null;
  raw_text: string | null;
  is_pantry_staple: number;
}

function ingredientFromDbRow(row: IngredientRow): Ingredient {
  const rawText = row.raw_text ?? "";
  return {
    canonical_name_en: row.canonical_name
      ? { value: row.canonical_name, evidence: [] }
      : { value: null, null_reason: "not populated on ingredients row" },
    raw_text: rawText,
    quantity: { value: row.quantity_value, unit: row.quantity_unit, raw_text: rawText },
    is_pantry_staple: row.is_pantry_staple === 1,
  } as Ingredient;
}

/** Optional persistence wrapper: reads a recipe's already-persisted
 * ingredient rows, matches them, and upserts results into `product_matches`.
 * NOTE (db.ts gap): `product_matches.ingredient_id` has an index but no
 * UNIQUE constraint, so this does a manual select-then-update/insert instead
 * of relying on `ON CONFLICT` — see final report for the suggested schema
 * follow-up. */
export async function matchRecipeAndPersist(
  recipeId: string,
  locationId: string,
  options: MatchOptions = {},
): Promise<IngredientMatch[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, canonical_name, quantity_value, quantity_unit, raw_text, is_pantry_staple
       FROM ingredients WHERE recipe_id = ?`,
    )
    .all(recipeId) as unknown as IngredientRow[];

  const token = await getAppToken();
  const results: IngredientMatch[] = [];
  for (const row of rows) {
    const match = await matchIngredient(
      ingredientFromDbRow(row),
      row.id,
      locationId,
      token.access_token,
    );
    results.push(match);
  }
  // Materiality judgment runs AFTER every ingredient is matched (one batched
  // call across the whole recipe) and BEFORE persisting, so the DB reflects
  // the post-judgment state rather than the deterministic-only flags.
  await applyMateriality(results, options);
  for (const match of results) {
    persistMatch(match);
  }
  return results;
}

interface OldestMatchRow {
  oldest: string | null;
}

/** Parses a `datetime('now')`-style sqlite timestamp ("YYYY-MM-DD HH:MM:SS",
 * always UTC) into epoch ms. LIVE-VERIFIED gotcha: `new Date(sqliteString)`
 * WITHOUT this fix parses the string as LOCAL time, not UTC — a real ~5h skew
 * in this environment's timezone. Never parse a sqlite datetime string with a
 * bare `new Date(...)`; always convert to a proper ISO string first. */
function parseSqliteUtcDatetime(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/** Age (ms) since a recipe's Kroger product-match search results were last
 * refreshed — the OLDEST per-ingredient `product_matches.updated_at`, since
 * matchRecipeAndPersist always re-matches every ingredient of a recipe in one
 * pass (a partial per-ingredient staleness signal wouldn't be actionable).
 * Returns null when the recipe has no persisted matches yet (nothing to be
 * stale — a first match is never "stale"). */
function matchAgeMs(recipeId: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MIN(pm.updated_at) as oldest
       FROM product_matches pm JOIN ingredients i ON i.id = pm.ingredient_id
       WHERE i.recipe_id = ?`,
    )
    .get(recipeId) as unknown as OldestMatchRow | undefined;
  if (!row?.oldest) return null;
  return Date.now() - parseSqliteUtcDatetime(row.oldest);
}

/** Spec 3 §2.2 staleness rule (A3-6): "re-run search if the recipe has sat in
 * awaiting_review past a config window... before a cart run uses its
 * prices." True when persisted matches exist AND are older than
 * config.kroger.searchStalenessWindowMs. A recipe with no matches yet is
 * NOT stale (there's nothing to refresh — that's the normal first-match
 * case, not a staleness condition). */
export function isMatchStale(recipeId: string): boolean {
  const age = matchAgeMs(recipeId);
  return age !== null && age > config.kroger.searchStalenessWindowMs;
}

/** Re-runs matching for a recipe ONLY if its persisted matches are stale
 * (isMatchStale) — a no-op returning null otherwise, so a caller in the
 * common case (freshly-matched recipe, approved promptly) doesn't pay for an
 * extra Kroger search pass. Called by `recipecart approve` right before
 * selecting approved items, so a cart run never mutates the cart against
 * prices/availability that might be a day or more stale. */
export async function refreshIfStale(
  recipeId: string,
  locationId: string,
  options: MatchOptions = {},
): Promise<IngredientMatch[] | null> {
  if (!isMatchStale(recipeId)) return null;
  logger.info("matcher: persisted matches are stale, re-running search before cart approval", {
    recipeId,
  });
  return matchRecipeAndPersist(recipeId, locationId, options);
}

function persistMatch(match: IngredientMatch): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare(`SELECT id FROM product_matches WHERE ingredient_id = ?`)
    .get(match.ingredientId) as unknown as { id: string } | undefined;

  const candidatesJson = JSON.stringify(match.candidates);
  if (existing) {
    db.prepare(
      `UPDATE product_matches
       SET candidates_json = ?, requires_approval = ?, approval_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      candidatesJson,
      match.requiresApproval ? 1 : 0,
      match.approvalReason ?? null,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO product_matches
         (id, ingredient_id, candidates_json, selected_product_id, requires_approval, approval_reason, is_approved, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)`,
    ).run(
      randomUUID(),
      match.ingredientId,
      candidatesJson,
      match.requiresApproval ? 1 : 0,
      match.approvalReason ?? null,
      now,
      now,
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Formats a readable terminal table: one row per ingredient, showing its
 * top candidate, price, and approval flag. Exported for the CLI to call
 * directly — not wired into cli.ts here. */
export function renderMatchesTable(matches: IngredientMatch[]): string {
  const columns = ["Ingredient", "Top Match", "Price", "Needs Approval", "Note"];
  const rows = matches.map((m) => {
    const top = m.candidates[0];
    const ingredientCol = truncate(m.canonicalName + (m.deprioritized ? " (pantry)" : ""), 28);
    const matchCol = top
      ? truncate(`${top.brand ? top.brand + " " : ""}${top.name}`, 36)
      : "(no match)";
    const priceCol = top?.price != null ? `$${top.price.toFixed(2)}` : "-";
    const approvalCol = m.requiresApproval ? "yes" : "no";
    const noteCol = truncate(m.approvalReason ?? top?.reason ?? "", 40);
    return [ingredientCol, matchCol, priceCol, approvalCol, noteCol];
  });

  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));

  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => padRight(c, widths[i]!)).join("  ");

  const lines = [
    formatRow(columns),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(formatRow),
  ];
  return lines.join("\n");
}
