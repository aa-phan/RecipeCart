// Deterministic unit normalization + package-size parsing (Spec 3 §2.2
// steps 1 and quantity-to-package fit). Closed set per spec: weight
// (g/kg/oz/lb), volume (ml/l/tsp/tbsp/cup/fl oz), count. Density-based
// cross-category conversion (flour ~120g/cup etc.) is a P2 nice-to-have —
// deliberately NOT implemented here; when the ingredient's unit category
// doesn't match the package's, callers should skip the quantity-fit boost
// rather than guess.

export type UnitCategory = "weight" | "volume" | "count";

export interface NormalizedUnit {
  category: UnitCategory;
  // Multiplier to convert a quantity in this unit to the category's base
  // unit: grams for weight, milliliters for volume, count (1) for count.
  factor: number;
}

const WEIGHT_UNITS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

const VOLUME_UNITS: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  litres: 1000,
  tsp: 4.92892,
  teaspoon: 4.92892,
  teaspoons: 4.92892,
  tbsp: 14.7868,
  tablespoon: 14.7868,
  tablespoons: 14.7868,
  cup: 236.588,
  cups: 236.588,
  "fl oz": 29.5735,
  floz: 29.5735,
  "fluid ounce": 29.5735,
  "fluid ounces": 29.5735,
  pt: 473.176,
  pint: 473.176,
  pints: 473.176,
  qt: 946.353,
  quart: 946.353,
  quarts: 946.353,
  gal: 3785.41,
  gallon: 3785.41,
  gallons: 3785.41,
};

const COUNT_UNITS: Record<string, number> = {
  count: 1,
  ct: 1,
  each: 1,
  ea: 1,
  unit: 1,
  units: 1,
  piece: 1,
  pieces: 1,
  item: 1,
  items: 1,
  dozen: 12,
};

function normalizeUnitText(raw: string): string {
  return raw.toLowerCase().replace(/\./g, "").trim().replace(/\s+/g, " ");
}

/** Maps a free-text unit string to a closed-set category + base-unit
 * factor. Returns null for units we don't recognize (callers should treat
 * that as "can't confidently convert," not an error) or for an empty/null
 * unit — null unit with no text at all doesn't default to count here, since
 * that's a caller-level judgment call (a bare "2" could mean 2 count or an
 * un-normalized vague quantity); see quantityFitScore for that handling. */
export function normalizeUnit(raw: string | null | undefined): NormalizedUnit | null {
  if (!raw) return null;
  const text = normalizeUnitText(raw);
  if (text in WEIGHT_UNITS) return { category: "weight", factor: WEIGHT_UNITS[text]! };
  if (text in VOLUME_UNITS) return { category: "volume", factor: VOLUME_UNITS[text]! };
  if (text in COUNT_UNITS) return { category: "count", factor: COUNT_UNITS[text]! };
  return null;
}

export interface ParsedSize {
  category: UnitCategory;
  baseQuantity: number; // total quantity expressed in the category's base unit
}

interface SizePart {
  value: number;
  unitText: string;
}

function parsePart(part: string): SizePart | null {
  const match = /^\s*([\d.]+)\s*(.*)$/.exec(part.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unitText = (match[2] ?? "").trim();
  if (!Number.isFinite(value) || unitText.length === 0) return null;
  return { value, unitText };
}

/** Parses Kroger's free-text `size` field pragmatically: "1 lb", "1 pt",
 * "8 fl oz", "24 bottles / 16.9 fl oz". Multi-part sizes (pack count /
 * per-unit size) are collapsed into a single total-quantity figure using
 * whichever part carries a recognized unit; other numeric parts are treated
 * as pack-count multipliers. Returns null when nothing in the string is
 * parseable — callers should keep the raw string and skip the quantity-fit
 * boost rather than blocking the match. */
export function parseSizeString(size: string): ParsedSize | null {
  const parts = size
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const parsedParts = parts.map(parsePart).filter((p): p is SizePart => p !== null);
  if (parsedParts.length === 0) return null;

  const withUnits = parsedParts
    .map((p, index) => ({ ...p, index, normalized: normalizeUnit(p.unitText) }))
    .filter(
      (p): p is SizePart & { index: number; normalized: NormalizedUnit } => p.normalized !== null,
    );
  if (withUnits.length === 0) return null;

  // The last part carrying a recognized unit is treated as the "real" size
  // (e.g. the "16.9 fl oz" in "24 bottles / 16.9 fl oz"); everything else
  // numeric is a pack-count multiplier. Compare by index, not object
  // identity — `withUnits` entries are copies of `parsedParts` entries.
  const sizePart = withUnits[withUnits.length - 1]!;
  let multiplier = 1;
  for (let i = 0; i < parsedParts.length; i++) {
    if (i === sizePart.index) continue;
    multiplier *= parsedParts[i]!.value;
  }

  return {
    category: sizePart.normalized.category,
    baseQuantity: sizePart.value * sizePart.normalized.factor * multiplier,
  };
}
