// Small-quantity seasonings/spices (Spec 3 §2.2 step 3a) — ingredients where
// the stated recipe amount (1 tsp vs 5 tsp) never meaningfully changes which
// package to buy, because virtually any jar/shaker on a store shelf covers
// any reasonable recipe amount. Distinct from "core" bulk ingredients (meats,
// produce, flour, sugar, oil, dairy — see density.ts) where portion size IS
// a real purchasing decision (2 lb of chicken vs 5 lb; 2 cups of oil vs 1
// tbsp). Matched ingredients here are treated the same as a genuinely
// no-stated-quantity ingredient: quantity-fit scoring is skipped entirely,
// and matchIngredient defaults to the smallest available package (cheapest
// price tiebreak) rather than running the ambiguity-margin check.
const SEASONINGS = new Set([
  "salt",
  "kosher salt",
  "table salt",
  "sea salt",
  "pepper",
  "black pepper",
  "white pepper",
  "cayenne pepper",
  "cayenne",
  "garlic powder",
  "onion powder",
  "paprika",
  "ground paprika",
  "smoked paprika",
  "chili powder",
  "chili flakes",
  "chilli flakes",
  "red pepper flakes",
  "italian herbs seasoning",
  "italian seasoning",
  "cinnamon",
  "cumin",
  "oregano",
  "basil",
  "thyme",
  "rosemary",
  "parsley",
  "parsley flakes",
]);

/** True when `canonicalName` matches a known small-quantity seasoning —
 * exact match first, then a whole-word/phrase match (so "dried oregano"
 * still resolves via "oregano" without needing every adjective variant
 * listed explicitly). Anything not on this explicit list is treated as a
 * normal (non-seasoning) ingredient — never a guess either way. */
export function isSeasoning(canonicalName: string): boolean {
  const key = canonicalName.trim().toLowerCase();
  if (SEASONINGS.has(key)) return true;

  for (const name of SEASONINGS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(key)) return true;
  }
  return false;
}
