// Deterministic P1 ranking (Spec 3 §2.2 step 3): text relevance gate, then
// quantity-to-package fit, then unit-price as a pure tiebreak. No embeddings,
// no external calls — Claude-delegated disambiguation and materiality are
// explicitly deferred to P2 per spec.
import type { Ingredient } from "../pipeline/schema.js";
import type { KrogerProductImage } from "../kroger/types.js";
import { normalizeUnit, parseSizeString, type UnitCategory } from "./units.js";
import { densityForIngredient } from "./density.js";

// src/pipeline/schema.ts (owned by the extraction pipeline agent) doesn't
// export a standalone Quantity type, so derive it from Ingredient rather
// than duplicating the shape or editing that file.
type Quantity = Ingredient["quantity"];

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "with",
  "to",
  "for",
  "fresh",
  "large",
  "small",
  "medium",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Lightweight local token-overlap score between the ingredient's canonical
 * name and a candidate product's description — no embeddings/external call
 * for P1. Returns null when there's no meaningful token overlap at all, so
 * callers can exclude the candidate as a bad match rather than merely
 * penalizing it (per spec). Otherwise returns a score roughly in (0, 1.3]:
 * fraction of ingredient tokens found in the description, plus a bonus when
 * the full ingredient phrase appears verbatim. */
export function textRelevanceScore(ingredientName: string, description: string): number | null {
  const ingredientTokens = tokenize(ingredientName).filter((t) => !STOPWORDS.has(t));
  if (ingredientTokens.length === 0) return null;

  const descTokens = tokenize(description);
  const descTokenSet = new Set(descTokens);

  const matched = ingredientTokens.filter(
    (t) =>
      descTokenSet.has(t) ||
      descTokens.some((d) => d.length > 2 && (d.includes(t) || t.includes(d))),
  );
  if (matched.length === 0) return null;

  let score = matched.length / ingredientTokens.length;
  if (description.toLowerCase().includes(ingredientName.toLowerCase().trim())) {
    score += 0.3;
  }
  return score;
}

// Buying more than this many of the same package to cover one ingredient's
// need is no longer treated as an auto-resolvable "just buy more" case —
// past this point it's flagged for approval instead (still reported, with
// the units-needed math shown, never silently dropped). A judgment call,
// not a validated number: guards against the matcher quietly turning a
// dubious match (or a genuinely huge recipe quantity) into an oddly large
// cart line, which is worth a human glance before it's real money.
const MAX_AUTO_MULTI_UNIT_PURCHASE = 3;

export interface QuantityFit {
  score: number; // higher is better WITHIN a `covers` bucket only — see below
  // Whether buying `unitsNeeded` of this package fully covers the needed
  // quantity AND `unitsNeeded` is within MAX_AUTO_MULTI_UNIT_PURCHASE.
  // `score` alone is NOT a reliable covers-vs-undersized signal: a
  // wildly-oversized covering package (e.g. 20x the need) scores low
  // (1/20), which can be numerically lower than a barely-short package
  // (e.g. 90% of need scores 0.45) — callers that need "fully covers always
  // beats not covering" must bucket on `covers` first and only compare
  // `score` within a bucket.
  covers: boolean;
  // How many of this package to buy to reach (or just exceed) the needed
  // quantity — 1 when a single package already covers it. Spec 3 §2.2 step
  // 3's "closest-over" rule, generalized: buying multiple of a smaller
  // package is a normal, expected outcome (a recipe needing 800g of chicken
  // breast from 1lb packages just means buying 2), not a failure to find a
  // match.
  unitsNeeded: number;
  note: string;
}

/** Converts a base-unit quantity across the volume/weight split using a
 * known per-ingredient density (Spec 3 §2.2 step 4: "standard densities like
 * flour ≈120g/cup") — e.g. teaspoons of salt to grams of salt, so it can be
 * compared against a package sold by weight. Returns null (no guess) when
 * either category is "count" (nothing to bridge with a density) or the
 * ingredient isn't on the explicit density list (density.ts). */
function convertAcrossCategory(
  baseQuantity: number,
  fromCategory: UnitCategory,
  toCategory: UnitCategory,
  canonicalName: string | undefined,
): number | null {
  if (fromCategory === toCategory) return baseQuantity;
  if (fromCategory === "count" || toCategory === "count") return null;
  if (!canonicalName) return null;

  const gramsPerMl = densityForIngredient(canonicalName);
  if (gramsPerMl === null) return null;

  // Base units are always grams (weight) or milliliters (volume) — see
  // units.ts's NormalizedUnit doc.
  return fromCategory === "volume" ? baseQuantity * gramsPerMl : baseQuantity / gramsPerMl;
}

/** Quantity-to-package-size fit ("closest-over" rule): prefer the smallest
 * package that covers the needed quantity. Returns null when the
 * ingredient's quantity/unit or the package size string aren't both
 * confidently parseable, or when they're in different unit categories with
 * no known density to bridge them — per spec, that means "skip the boost,"
 * not "penalize the candidate." A bare quantity with no unit (e.g. "2 eggs")
 * is treated as a count. `canonicalName` (optional) enables the
 * volume<->weight density conversion above; omit it to keep the old
 * same-category-only behavior. */
export function quantityFitScore(
  quantity: Quantity,
  size: string,
  canonicalName?: string,
): QuantityFit | null {
  if (quantity.value === null || quantity.value <= 0) return null;

  const ingredientUnit =
    quantity.unit === null
      ? { category: "count" as const, factor: 1 }
      : normalizeUnit(quantity.unit);
  if (!ingredientUnit) return null;

  const parsedSize = parseSizeString(size);
  if (!parsedSize) return null;

  let neededBase = quantity.value * ingredientUnit.factor;
  if (parsedSize.category !== ingredientUnit.category) {
    const converted = convertAcrossCategory(
      neededBase,
      ingredientUnit.category,
      parsedSize.category,
      canonicalName,
    );
    if (converted === null) return null;
    neededBase = converted;
  }

  if (neededBase <= 0) return null;
  const singlePackageRatio = parsedSize.baseQuantity / neededBase;
  // "Closest-over" generalized across N units: a single package might not
  // cover the need on its own, but buying `unitsNeeded` of it (ceil of the
  // ratio, minimum 1) usually does — a recipe needing 800g from 1lb
  // packages just means buying 2, not a failure to find a match. The score
  // formula is identical to before when unitsNeeded is 1 (single-package
  // case unchanged); it now also naturally ranks "fewer units, less total
  // surplus" combinations higher across the multi-unit case.
  const unitsNeeded = Math.max(1, Math.ceil(neededBase / parsedSize.baseQuantity));
  const totalRatio = (parsedSize.baseQuantity * unitsNeeded) / neededBase;
  const withinAutoLimit = unitsNeeded <= MAX_AUTO_MULTI_UNIT_PURCHASE;

  const note =
    unitsNeeded === 1
      ? `covers needed quantity (${(totalRatio * 100).toFixed(0)}% of need)`
      : `${unitsNeeded} x this package covers the needed quantity (${(totalRatio * 100).toFixed(0)}% of need)`;

  if (withinAutoLimit) {
    return { score: 1 / totalRatio, covers: true, unitsNeeded, note };
  }
  // More units than MAX_AUTO_MULTI_UNIT_PURCHASE would technically cover it
  // too, but that's no longer an auto-resolvable "just buy more" case —
  // report it (so a human reviewing sees the real math), but don't let it
  // rank as `covers`.
  return {
    score: singlePackageRatio * 0.5,
    covers: false,
    unitsNeeded,
    note: `would need ${unitsNeeded} of this package to cover the needed quantity (${(totalRatio * 100).toFixed(0)}% of need) — likely a wrong-size match`,
  };
}

/** Price per base unit (gram/ml/count) for tiebreak purposes only. Returns
 * undefined when price or size aren't both available/parseable. */
export function computeUnitPrice(price: number, size: string): number | undefined {
  const parsed = parseSizeString(size);
  if (!parsed || parsed.baseQuantity <= 0) return undefined;
  return price / parsed.baseQuantity;
}

// Smallest-first: a list/dropdown thumbnail should be as small as Kroger
// offers, not a hero-sized image. Fall back down the list if a preferred
// size isn't present for this particular image entry.
const PREFERRED_IMAGE_SIZES = ["thumbnail", "small", "medium", "large", "xlarge"];

/** Picks a thumbnail-appropriate image URL from a Kroger product's `images`
 * array (Spec 3 §2.2 candidate display) — purely additive, display-only
 * data, no effect on ranking/matching. Prefers the "front" perspective
 * (falling back to whatever's marked `default`, then the first entry, since
 * not every product guarantees a "front" shot), then the smallest available
 * size for that image. Returns undefined rather than throwing whenever
 * `images` is missing/empty or no entry has any sizes — many catalog items
 * have no photography at all. */
export function extractImageUrl(images: KrogerProductImage[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;

  const chosenImage =
    images.find((img) => img.perspective === "front") ??
    images.find((img) => img.featured) ??
    images[0]!;

  if (!chosenImage.sizes || chosenImage.sizes.length === 0) return undefined;

  for (const preferred of PREFERRED_IMAGE_SIZES) {
    const match = chosenImage.sizes.find((s) => s.size === preferred);
    if (match) return match.url;
  }
  // Unrecognized size labels only: still return something rather than
  // silently dropping a valid image URL.
  return chosenImage.sizes[0]!.url;
}
