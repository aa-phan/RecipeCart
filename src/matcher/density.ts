// Ingredient density table (Spec 3 §2.2 step 4: "standard densities like flour
// ≈120g/cup") — bridges quantityFitScore across the volume/weight category
// split, but ONLY for "core" bulk ingredients (flour, sugar, oil, dairy,
// etc.) where the stated recipe amount is a real purchasing decision (2 cups
// of flour vs 1 tbsp genuinely changes which bag size to buy). Small-amount
// seasonings/spices (salt, garlic powder, paprika, ...) are deliberately NOT
// here — see seasonings.ts: for those, no reasonable recipe quantity ever
// changes which package to buy, so they skip quantity-fit scoring entirely
// rather than needing a density conversion at all.
//
// Without a per-ingredient density, volume and weight units are genuinely
// not interconvertible (a cup of flour and a cup of honey don't weigh the
// same), so a generic factor would be a fabricated number. Deliberately
// conservative: unknown ingredients get NO conversion (quantityFitScore
// falls back to null, same as before) rather than a guessed density — same
// no-fabrication principle as the rest of the matching/extraction pipeline.
//
// Values are standard culinary approximations (g/mL), not measured — good
// enough for "does this package roughly cover the recipe's amount," not a
// nutrition-label-grade claim.
const DENSITY_G_PER_ML: Record<string, number> = {
  sugar: 0.85,
  "brown sugar": 0.93,
  flour: 0.53,
  "all-purpose flour": 0.53,
  oil: 0.92,
  "olive oil": 0.92,
  "vegetable oil": 0.92,
  butter: 0.96,
  honey: 1.42,
  water: 1.0,
  milk: 1.03,
};

/** Looks up a known culinary density (g/mL) for a core/bulk ingredient by
 * canonical name — exact match first, then a whole-word/phrase match (so
 * "fresh olive oil" still resolves via "olive oil", but "boiled potatoes"
 * does NOT false-positive-match "oil"). Returns null for anything not on the
 * explicit list (including all seasonings — see seasonings.ts); callers
 * must treat that as "can't convert," never fall back to a guess. */
export function densityForIngredient(canonicalName: string): number | null {
  const key = canonicalName.trim().toLowerCase();
  if (key in DENSITY_G_PER_ML) return DENSITY_G_PER_ML[key]!;

  for (const [name, density] of Object.entries(DENSITY_G_PER_ML)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(key)) return density;
  }
  return null;
}
