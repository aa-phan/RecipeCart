// Deterministic P1 ranking (Spec 3 §2.2 step 3): text relevance gate, then
// quantity-to-package fit, then unit-price as a pure tiebreak. No embeddings,
// no external calls — Claude-delegated disambiguation and materiality are
// explicitly deferred to P2 per spec.
import type { Ingredient } from "../pipeline/schema.js";
import { normalizeUnit, parseSizeString } from "./units.js";

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

export interface QuantityFit {
  score: number; // higher is better; see comment below for scale
  note: string;
}

/** Quantity-to-package-size fit ("closest-over" rule): prefer the smallest
 * package that covers the needed quantity. Returns null when the
 * ingredient's quantity/unit or the package size string aren't both
 * confidently parseable into the same unit category — per spec, that means
 * "skip the boost," not "penalize the candidate." A bare quantity with no
 * unit (e.g. "2 eggs") is treated as a count. */
export function quantityFitScore(quantity: Quantity, size: string): QuantityFit | null {
  if (quantity.value === null || quantity.value <= 0) return null;

  const ingredientUnit =
    quantity.unit === null
      ? { category: "count" as const, factor: 1 }
      : normalizeUnit(quantity.unit);
  if (!ingredientUnit) return null;

  const parsedSize = parseSizeString(size);
  if (!parsedSize) return null;
  if (parsedSize.category !== ingredientUnit.category) return null;

  const neededBase = quantity.value * ingredientUnit.factor;
  if (neededBase <= 0) return null;
  const ratio = parsedSize.baseQuantity / neededBase;

  if (ratio >= 1) {
    // Smallest package that still covers the need scores highest; score
    // decays toward 0 as the surplus grows, but never excludes.
    return {
      score: 1 / ratio,
      note: `covers needed quantity (${(ratio * 100).toFixed(0)}% of need)`,
    };
  }
  // Undersized package: not excluded (per spec, flagged not excluded when
  // it's the best/only option), but scored below any covering package.
  return {
    score: ratio * 0.5,
    note: `package smaller than needed quantity (${(ratio * 100).toFixed(0)}% of need)`,
  };
}

/** Price per base unit (gram/ml/count) for tiebreak purposes only. Returns
 * undefined when price or size aren't both available/parseable. */
export function computeUnitPrice(price: number, size: string): number | undefined {
  const parsed = parseSizeString(size);
  if (!parsed || parsed.baseQuantity <= 0) return undefined;
  return price / parsed.baseQuantity;
}
