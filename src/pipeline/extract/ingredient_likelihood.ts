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

// Short unit abbreviations that real captions routinely glue directly onto
// the number with no space ("800g", "500ml", "1.5kg") — a plain \b\d+\b
// followed by \b(g|kg|...)\b can never match these, because "0" and "g" are
// both \w characters and no word-boundary exists between them. This matches
// the glued token as one piece and implies both quantity AND unit at once.
const GLUED_QUANTITY_UNIT_PATTERN = /\b\d+(\.\d+)?(g|kg|ml|l|oz|lb|lbs)\b/i;

// Leading numeral, fraction (1/2), or unicode vulgar fraction, optionally
// preceded by a bullet/dash marker. Deliberately excludes spelled-out
// words like "a"/"an"/"one" here — those are common English words
// (articles!) and, unpaired with a unit, are a very weak/noisy signal on
// their own (see ARTICLE_QUANTITY_PATTERN below).
const NUMERIC_QUANTITY_PATTERN = /^[\s•\-*·◦]*(\d+\/\d+|\d+(\.\d+)?|½|¼|¾|⅓|⅔)/;
// Spelled-out quantity words. Only trusted as a quantity signal when paired
// with an explicit unit word ("a pinch of salt") — alone, "a"/"an" is far
// too likely to just be the start of an ordinary sentence.
const ARTICLE_QUANTITY_PATTERN = /^[\s•\-*·◦]*\b(one|two|three|four|five|six|seven|eight|a|an)\b/i;
const BULLET_PATTERN = /^[\s]*[•\-*·◦]\s+\S/;

/** Score a single line's likelihood of being an ingredient entry, 0..1. */
export function scoreLine(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 0;

  const hasGluedQuantityUnit = GLUED_QUANTITY_UNIT_PATTERN.test(trimmed);
  const hasNumericQuantity = NUMERIC_QUANTITY_PATTERN.test(trimmed);
  const hasArticleQuantity = ARTICLE_QUANTITY_PATTERN.test(trimmed);
  const hasUnit = UNIT_PATTERN.test(trimmed);
  const isBullet = BULLET_PATTERN.test(line);

  if (hasGluedQuantityUnit) return 1.0;
  if ((hasNumericQuantity || hasArticleQuantity) && hasUnit) return 1.0;
  if (hasNumericQuantity || (isBullet && hasUnit)) return 0.7;
  if (isBullet) return 0.3;
  return 0;
}

export interface IngredientLikelyLine {
  text: string;
  score: number;
}

// Real-world captions frequently arrive as ONE run-on line with no actual
// newlines — TikTok's API often collapses them — using " - " or a bullet
// character as an inline list separator instead ("...Chicken, cubed - 800g
// Thighs, cubed - 3 Tsp Salt - ..."). A newline-only splitter misses every
// ingredient in a caption like that entirely, so this also splits on a
// dash/bullet with whitespace on both sides. A bare mid-word hyphen
// ("high-protein") has no surrounding whitespace and is left alone.
const SEGMENT_SPLIT_PATTERN = /\r?\n|(?<=[.!])\s+(?=[A-Z0-9])|\s+[-•·◦]\s+/;

/** Split free text into lines/segments and return the ones that look like
 * ingredient entries, sorted by descending score. Threshold is inclusive. */
export function findIngredientLikelyLines(text: string, threshold = 0.5): IngredientLikelyLine[] {
  const segments = text
    .split(SEGMENT_SPLIT_PATTERN)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments
    .map((segmentText) => ({ text: segmentText, score: scoreLine(segmentText) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
