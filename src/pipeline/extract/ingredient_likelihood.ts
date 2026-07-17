// Shared ingredient-likelihood scorer (Spec 2 §2.3a + §2.4).
// Used by both the caption-sufficiency gate (parse_caption.ts) and OCR-block
// escalation scoring — one heuristic, not two drifting implementations.
// Looks for the quantity/unit/food-noun shape of an ingredient line
// ("2 cups flour", "1 tsp salt", "3 eggs") without trying to fully parse it;
// downstream schema validation is the real correctness backstop (§2.3a).

const UNIT_WORDS = [
  "cup",
  "cups",
  "tbsp",
  "tablespoon",
  "tablespoons",
  "tsp",
  "teaspoon",
  "teaspoons",
  "oz",
  "ounce",
  "ounces",
  "g",
  "gram",
  "grams",
  "kg",
  "kilogram",
  "kilograms",
  "ml",
  "milliliter",
  "milliliters",
  "l",
  "liter",
  "liters",
  "lb",
  "lbs",
  "pound",
  "pounds",
  "clove",
  "cloves",
  "pinch",
  "dash",
  "slice",
  "slices",
  "can",
  "cans",
  "packet",
  "packets",
  "stick",
  "sticks",
  "piece",
  "pieces",
];

const UNIT_PATTERN = new RegExp(`\\b(${UNIT_WORDS.join("|")})\\b`, "i");
// Leading numeral, fraction (1/2), unicode vulgar fraction, or spelled-out
// small number, optionally preceded by a bullet/dash marker.
const QUANTITY_PATTERN =
  /^[\s•\-*·◦]*(\d+\/\d+|\d+(\.\d+)?|½|¼|¾|⅓|⅔|one|two|three|four|five|six|seven|eight|a|an)\b/i;
const BULLET_PATTERN = /^[\s]*[•\-*·◦]\s+\S/;

/** Score a single line's likelihood of being an ingredient entry, 0..1. */
export function scoreLine(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 0;

  const hasQuantity = QUANTITY_PATTERN.test(trimmed);
  const hasUnit = UNIT_PATTERN.test(trimmed);
  const isBullet = BULLET_PATTERN.test(line);

  if (hasQuantity && hasUnit) return 1.0;
  if (hasQuantity || (isBullet && hasUnit)) return 0.7;
  if (isBullet) return 0.3;
  return 0;
}

export interface IngredientLikelyLine {
  text: string;
  score: number;
}

/** Split free text into lines/segments and return the ones that look like
 * ingredient entries, sorted by descending score. Threshold is inclusive. */
export function findIngredientLikelyLines(
  text: string,
  threshold = 0.5,
): IngredientLikelyLine[] {
  const segments = text
    .split(/\r?\n|(?<=[.!])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments
    .map((segmentText) => ({ text: segmentText, score: scoreLine(segmentText) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
