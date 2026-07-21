// postprocess stage (Spec 2 §2.1). Deliberately small, P1-scope transforms
// applied after reconcile's Claude call — don't over-engineer any of them:
//   - unit normalization: map common unit synonyms onto the schema's closed
//     unit set. raw_text is NEVER touched (it's the source-of-truth literal
//     text); only the parsed `unit` field is normalized, and only when
//     confidently mappable — anything unrecognized is left as Claude gave it
//     rather than guessed at.
//   - pantry-staple classification: a fixed hardcoded list check, not an ML
//     classifier — P1 scope per Spec 2.
//   - display-name capitalization: Claude returns canonical_name_en mostly
//     lowercase ("chicken thighs", "olive oil") since it's transcribing
//     evidence, not formatting a display string. Title-case it for display —
//     matching code (isSeasoning, densityForIngredient, isPantryAlwaysOwned,
//     isPantryStaple below) all lowercase their input before comparing, so
//     this is display-only and doesn't touch matching. raw_text is untouched
//     for the same reason unit normalization leaves it untouched.
// Re-validates with validateRecipe() afterward since this stage mutates the
// object (reconcile's validation covered the pre-postprocess shape only).
import { validateRecipe, type Recipe } from "../schema.js";

// Closed unit set the Quantity.unit field should use, per Spec 2 §2.1.
const UNIT_SYNONYMS: Record<string, string> = {
  gram: "g",
  grams: "g",
  g: "g",
  kilogram: "kg",
  kilograms: "kg",
  kg: "kg",
  ounce: "oz",
  ounces: "oz",
  oz: "oz",
  pound: "lb",
  pounds: "lb",
  lb: "lb",
  lbs: "lb",
  milliliter: "ml",
  milliliters: "ml",
  ml: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  l: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tsp: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tbsp: "tbsp",
  cup: "cup",
  cups: "cup",
  "fl oz": "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  count: "count",
  piece: "count",
  pieces: "count",
  whole: "count",
};

/** Normalize a unit string onto the closed set. Returns the original string
 * unchanged if it isn't confidently mappable — never guesses. */
export function normalizeUnit(unit: string | null): string | null {
  if (unit === null) return null;
  const key = unit.trim().toLowerCase();
  return UNIT_SYNONYMS[key] ?? unit;
}

/** Title-case a display name: capitalize the first letter of every
 * space/hyphen-separated segment, lowercase the rest ("all-purpose flour" ->
 * "All-Purpose Flour", "GARLIC & herb cream cheese" -> "Garlic & Herb Cream
 * Cheese"). Punctuation-only segments (e.g. "&") pass through unchanged. */
export function titleCase(name: string): string {
  return name
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((seg) => (seg.length === 0 ? seg : seg[0]!.toUpperCase() + seg.slice(1).toLowerCase()))
        .join("-"),
    )
    .join(" ");
}

// P1 scope: fixed list, not a classifier (Spec 2 §2.1 postprocess).
const PANTRY_STAPLES = new Set(["salt", "pepper", "oil", "water", "sugar", "flour"]);

/** True if canonicalName (already lowercased comparison) IS one of the fixed
 * pantry staples, or ends with " oil"/" salt"/etc. (e.g. "olive oil", "black
 * pepper", "kosher salt", "all-purpose flour") — a bare substring match
 * would false-positive on things like "flourless", so this checks token
 * boundaries via a whole-word match against the staple list. */
export function isPantryStaple(canonicalName: string | null): boolean {
  if (!canonicalName) return false;
  const words = canonicalName.toLowerCase().split(/\s+/);
  return words.some((w) => PANTRY_STAPLES.has(w));
}

export function postprocess(recipe: Recipe): Recipe {
  const ingredients = recipe.ingredients.map((ingredient) => {
    const normalizedUnit = normalizeUnit(ingredient.quantity.unit);
    const staple =
      isPantryStaple(ingredient.canonical_name_en.value) || ingredient.is_pantry_staple;
    const rawName = ingredient.canonical_name_en.value;
    return {
      ...ingredient,
      canonical_name_en: {
        ...ingredient.canonical_name_en,
        value: rawName === null ? null : titleCase(rawName),
      },
      quantity: { ...ingredient.quantity, unit: normalizedUnit },
      is_pantry_staple: staple,
    };
  });

  const result: Recipe = { ...recipe, ingredients };
  return validateRecipe(result);
}
