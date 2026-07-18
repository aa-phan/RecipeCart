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
import { getDb } from "../platform/db.js";
import { logger } from "../platform/logger.js";
import {
  computeUnitPrice,
  packageSizeMagnitude,
  quantityFitScore,
  textRelevanceScore,
  type QuantityFit,
} from "./rank.js";
import { isSeasoning } from "./seasonings.js";
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

function compareCandidates(a: ProductCandidate, b: ProductCandidate): number {
  const diff = b.rankScore - a.rankScore;
  if (Math.abs(diff) > 0.01) return diff;
  if (a.unitPrice != null && b.unitPrice != null) return a.unitPrice - b.unitPrice;
  return diff;
}

/** No-stated-quantity default ordering (Spec 3 §2.2 step 3a): smallest
 * package first, cheapest price as the tiebreak — an arbitrary but
 * deterministic choice, not a quality judgment (an "organic" or other
 * preference-based tiebreak is a natural P3 extension once Spec 1
 * preferences exist to drive it). */
function compareBySmallestPackage(a: ProductCandidate, b: ProductCandidate): number {
  const diff = packageSizeMagnitude(a.size) - packageSizeMagnitude(b.size);
  if (diff !== 0) return diff;
  if (a.price != null && b.price != null) return a.price - b.price;
  return 0;
}

interface ScoredCandidate {
  candidate: ProductCandidate;
  qFit: QuantityFit | null;
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
  // The word dropped to build `term` — e.g. "cheese" for "garlic & herb
  // cream cheese" -> "garlic & herb cream". Kept separately so callers can
  // still REQUIRE it in a candidate's description (see
  // searchAndBuildCandidates's `requiredWord`): broadening the QUERY sent to
  // Kroger is safe (it only widens what comes back), but without this
  // requirement, a partial-token-overlap candidate that's missing the one
  // word that actually identifies the product type can score just as well
  // as a real match. Confirmed live: dropping "cheese" from "garlic & herb
  // cream cheese" to search "garlic & herb cream" surfaced both a genuine
  // alternative (a garlic & herb spreadable cheese under a different brand)
  // AND "Soules Kitchen Creamy Garlic & Herb CHICKEN" at an IDENTICAL local
  // relevance score (3 of 4 tokens matched either way — "cream" fuzzy-
  // matches "creamy" regardless of whether it's describing a cheese or a
  // meat dish). Requiring "cheese" specifically in the description throws
  // out the chicken while keeping the real cheese alternatives.
  droppedWord: string;
}

/** Drops the last whitespace-separated word of a multi-word ingredient name
 * to build a broader fallback search term (Spec 3 §2.2 step 2) — e.g.
 * "garlic & herb cream cheese" -> "garlic & herb cream". Live-tested: this
 * one-step broadening reliably surfaces genuine near-alternatives Kroger's
 * own search missed on the exact name (a "cream cheese" flavor also sold as
 * a "spreadable cheese"/"gourmet cheese") without pulling in the noise a
 * more aggressive broadening does — dropping to just the flavor words alone
 * (e.g. "garlic herb") returned pasta sauce, seasoning shakers, and pork
 * chops at the exact same text-relevance score as the real matches, with no
 * reliable way to tell them apart locally. Returns null for a single-word
 * name (nothing left to drop) or when the search term didn't actually
 * change (nothing usefully broadened).
 */
function broadenedSearchTerm(canonicalName: string): BroadenedSearch | null {
  const words = canonicalName.trim().split(/\s+/);
  if (words.length < 2) return null;
  const term = words.slice(0, -1).join(" ").trim();
  if (term.length === 0) return null;
  return { term, droppedWord: words[words.length - 1]!.toLowerCase() };
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

    const textScore = textRelevanceScore(scoringName, product.description);
    if (textScore === null) continue; // no meaningful overlap — excluded, not just penalized

    for (const item of product.items) {
      if (item.inventory?.stockLevel === "TEMPORARILY_OUT_OF_STOCK") continue;

      const qFit = useSmallestPackageDefault
        ? null
        : quantityFitScore(quantity, item.size, scoringName);
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
        },
        qFit,
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

/** "Convert to the package's unit, then pick the smallest size that fully
 * covers the needed quantity" (Spec 3 §2.2 step 3): bucket by coverage
 * first (a covering package always wins over an undersized one, however
 * small the surplus), then within a bucket prefer the closest fit (smallest
 * surplus if covering, largest available if undersized — both are
 * `qFit.score` descending), then cheapest price as the final tiebreak. */
function compareByQuantityCoverage(a: ScoredCandidate, b: ScoredCandidate): number {
  const bucketDiff = coverageBucket(a.qFit) - coverageBucket(b.qFit);
  if (bucketDiff !== 0) return bucketDiff;

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

    // Only reach for a broadened search when it's actually load-bearing: a
    // core (non-seasoning) ingredient with a real quantity, where nothing
    // in the specific-name results covers the need. Cheap to check before
    // spending a second Kroger call.
    const coveredAlready = scored.some((s) => s.qFit?.covers);
    if (!useSmallestPackageDefault && scored.some((s) => s.qFit !== null) && !coveredAlready) {
      const broadened = broadenedSearchTerm(canonicalName);
      if (broadened) {
        broadenedTermUsed = broadened.term;
        const extra = await searchAndBuildCandidates(
          broadened.term,
          canonicalName,
          ingredient.quantity,
          useSmallestPackageDefault,
          locationId,
          appToken,
          true,
          broadened.droppedWord,
        );
        const seenIds = new Set(scored.map((s) => s.candidate.productId));
        for (const e of extra) {
          if (!seenIds.has(e.candidate.productId)) {
            scored.push(e);
            seenIds.add(e.candidate.productId);
          }
        }
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
    scored.sort((a, b) => compareBySmallestPackage(a.candidate, b.candidate));
  } else if (useQuantityCoverage) {
    scored.sort(compareByQuantityCoverage);
  } else {
    scored.sort((a, b) => compareCandidates(a.candidate, b.candidate));
  }
  scored = scored.slice(0, MAX_CANDIDATES);
  const candidates = scored.map((s) => s.candidate);

  let requiresApproval = false;
  let approvalReason: string | undefined;

  if (candidates.length === 0) {
    requiresApproval = true;
    approvalReason = "no in-stock candidates found a relevant text match for this ingredient";
  } else if (useSmallestPackageDefault) {
    // Deterministic by construction (smallest package, cheapest tiebreak) —
    // never flagged as ambiguous just because there was nothing to score.
    candidates[0]!.reason = hasQuantity
      ? "small seasoning amount — smallest package selected regardless of stated quantity"
      : "no quantity stated — smallest package selected";
  } else if (useQuantityCoverage) {
    // "Convert to the package's unit, then pick the smallest size that
    // fully covers the needed quantity" (Spec 3 §2.2 step 3) — deterministic
    // by construction once a real coverage signal exists, EXCEPT when no
    // candidate actually covers the need: buying 1 unit of an undersized
    // package would silently under-shop the recipe (cli.ts's `approve` adds
    // exactly 1 package per ingredient in P1), so that genuinely needs a
    // human, not a spurious "scores were close" flag.
    const top = scored[0]!;
    if (top.qFit && !top.qFit.covers) {
      const broadenedNote = broadenedTermUsed
        ? ` (also tried a broadened search for "${broadenedTermUsed}")`
        : "";
      requiresApproval = true;
      approvalReason = `no single available package covers the needed quantity${broadenedNote} (best available: ${top.qFit.note}) — buying 1 unit will under-shop this ingredient`;
    } else if (top.fromBroadenedSearch) {
      // Found only via the broadened query, not the ingredient's own name —
      // per Spec 3 §2.2, a different-named stand-in is a potential material
      // substitution, which this deterministic ranking can't safely
      // auto-approve on its own (materiality judgment is Claude-delegated,
      // [P2]). Surfacing it is still strictly better than the prior
      // behavior of never finding it at all.
      requiresApproval = true;
      approvalReason = `found via a broadened search ("${broadenedTermUsed}") rather than "${canonicalName}" directly — confirm "${top.candidate.name}" is an acceptable substitute before approving`;
    }
  } else if (candidates.length >= 2) {
    const [top, second] = candidates;
    if (top!.rankScore - second!.rankScore < AMBIGUITY_MARGIN) {
      requiresApproval = true;
      approvalReason = "top candidates are closely matched; no single clearly-best product";
    }
  }

  if (nameUncertain) {
    requiresApproval = true;
    const note = "ingredient name uncertain from extraction (matched on raw text)";
    approvalReason = approvalReason ? `${approvalReason}; ${note}` : note;
  }

  return {
    ingredientId,
    canonicalName,
    candidates,
    requiresApproval,
    approvalReason,
    deprioritized: ingredient.is_pantry_staple,
  };
}

/** Main entry point (Spec 3 §2.2). Matches every ingredient in a recipe
 * against the Kroger catalog for the given store. Gets one app-level token
 * up front and reuses it across all ingredients in the run (tokens last 30
 * min, comfortably longer than a single recipe's worth of calls). Runs
 * sequentially — deliberately, to stay a polite, predictable citizen of
 * Kroger's documented rate limits rather than bursting requests. */
export async function matchRecipe(
  ingredients: Ingredient[],
  locationId: string,
): Promise<IngredientMatch[]> {
  const token = await getAppToken();
  const results: IngredientMatch[] = [];
  for (let i = 0; i < ingredients.length; i++) {
    const ingredient = ingredients[i]!;
    const ingredientId = `ing-${i}`;
    results.push(await matchIngredient(ingredient, ingredientId, locationId, token.access_token));
  }
  return results;
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
    persistMatch(match);
  }
  return results;
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
