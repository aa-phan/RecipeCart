// Ingredient density table (Spec 3 §2.2 step 4: "standard densities like flour
// ≈120g/cup") — bridges quantityFitScore across the volume/weight category
// split for a small, explicit list of common pantry/spice ingredients.
// Recipes state spices/liquids by volume (tsp, cup) but Kroger sells them by
// weight (oz) far more often than not; without a per-ingredient density,
// those two units are genuinely not interconvertible (a teaspoon of salt and
// a teaspoon of flour don't weigh the same), so a generic factor would be a
// fabricated number. Deliberately conservative: unknown ingredients get NO
// conversion (quantityFitScore falls back to null, same as before) rather
// than a guessed density — same no-fabrication principle as the rest of the
// matching/extraction pipeline.
//
// Values are standard culinary approximations (g/mL), not measured — good
// enough for "does this package roughly cover the recipe's amount," not a
// nutrition-label-grade claim.
const DENSITY_G_PER_ML: Record<string, number> = {
  salt: 1.2,
  "kosher salt": 1.2,
  "table salt": 1.2,
  sugar: 0.85,
  "brown sugar": 0.93,
  flour: 0.53,
  "all-purpose flour": 0.53,
  "garlic powder": 0.45,
  "onion powder": 0.45,
  paprika: 0.45,
  "ground paprika": 0.45,
  "chili flakes": 0.4,
  "chilli flakes": 0.4,
  "red pepper flakes": 0.4,
  "italian herbs seasoning": 0.35,
  "italian seasoning": 0.35,
  "black pepper": 0.5,
  cinnamon: 0.56,
  cumin: 0.48,
  oil: 0.92,
  "olive oil": 0.92,
  "vegetable oil": 0.92,
  butter: 0.96,
  honey: 1.42,
  water: 1.0,
  milk: 1.03,
};

/** Looks up a known culinary density (g/mL) for an ingredient by canonical
 * name — exact match first, then a whole-word/phrase match (so "fresh garlic
 * powder" still resolves via "garlic powder", but "boiled potatoes" does NOT
 * false-positive-match "oil"). Returns null for anything not on the explicit
 * list; callers must treat that as "can't convert," never fall back to a
 * guess. */
export function densityForIngredient(canonicalName: string): number | null {
  const key = canonicalName.trim().toLowerCase();
  if (key in DENSITY_G_PER_ML) return DENSITY_G_PER_ML[key]!;

  for (const [name, density] of Object.entries(DENSITY_G_PER_ML)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(key)) return density;
  }
  return null;
}
