import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SchemaValidationError, validateRecipe } from "./schema.js";

function baseRecipe(overrides: Record<string, unknown> = {}) {
  return {
    extraction_version: SCHEMA_VERSION,
    source_url: "https://www.tiktok.com/@someone/video/123",
    result_type: "recipe",
    ingredients: [
      {
        canonical_name_en: {
          value: "flour",
          evidence: [{ source_type: "ocr", frame_ref: "frame-002", snippet: "2 cups flour" }],
        },
        raw_text: "2 cups flour",
        quantity: {
          value: 2,
          unit: "cup",
          raw_text: "2 cups",
          evidence: [{ source_type: "ocr", frame_ref: "frame-002", snippet: "2 cups flour" }],
        },
        is_pantry_staple: true,
      },
    ],
    ...overrides,
  };
}

describe("canonical recipe schema", () => {
  it("accepts a well-formed recipe", () => {
    const recipe = validateRecipe(baseRecipe());
    expect(recipe.ingredients[0]?.quantity.value).toBe(2);
  });

  it("allows a vague quantity as null value + null_reason + preserved raw_text (never fabricated)", () => {
    const recipe = validateRecipe(
      baseRecipe({
        ingredients: [
          {
            canonical_name_en: {
              value: "olive oil",
              evidence: [{ source_type: "asr", timestamp: 12.5 }],
            },
            raw_text: "a glug of olive oil",
            quantity: {
              value: null,
              unit: null,
              raw_text: "a glug",
              null_reason: "amount given only as 'a glug', not a measurable quantity",
            },
            is_pantry_staple: false,
          },
        ],
      }),
    );
    expect(recipe.ingredients[0]?.quantity.value).toBeNull();
    expect(recipe.ingredients[0]?.quantity.raw_text).toBe("a glug");
  });

  it("rejects an evidenced field with a value but zero evidence refs", () => {
    const bad = baseRecipe({
      ingredients: [
        {
          canonical_name_en: { value: "sugar" /* no evidence, no null_reason */ },
          raw_text: "sugar",
          quantity: {
            value: 1,
            unit: "cup",
            raw_text: "1 cup",
            evidence: [{ source_type: "ocr", frame_ref: "f1", snippet: "1 cup sugar" }],
          },
          is_pantry_staple: false,
        },
      ],
    });
    expect(() => validateRecipe(bad)).toThrow(SchemaValidationError);
  });

  it("rejects a quantity with a non-null value and zero evidence refs (the gap this schema closes)", () => {
    const bad = baseRecipe({
      ingredients: [
        {
          canonical_name_en: {
            value: "sugar",
            evidence: [{ source_type: "ocr", frame_ref: "f1", snippet: "1 cup sugar" }],
          },
          raw_text: "1 cup sugar",
          // non-null quantity.value with NO evidence and NO null_reason —
          // previously validated fine with zero evidence of any kind.
          quantity: { value: 1, unit: "cup", raw_text: "1 cup sugar" },
          is_pantry_staple: false,
        },
      ],
    });
    expect(() => validateRecipe(bad)).toThrow(SchemaValidationError);
  });

  it("rejects a null quantity value with no null_reason", () => {
    const bad = baseRecipe({
      ingredients: [
        {
          canonical_name_en: {
            value: "salt",
            evidence: [{ source_type: "caption", snippet: "some salt" }],
          },
          raw_text: "some salt",
          quantity: { value: null, unit: null, raw_text: "some" /* no null_reason */ },
          is_pantry_staple: true,
        },
      ],
    });
    expect(() => validateRecipe(bad)).toThrow(SchemaValidationError);
  });

  it("retains a conflicting quantity between narration and on-screen text as a flagged warning, never silently resolved (PRD C2 §26)", () => {
    const recipe = validateRecipe(
      baseRecipe({
        ingredients: [
          {
            canonical_name_en: {
              value: "sugar",
              evidence: [{ source_type: "ocr", frame_ref: "f1", snippet: "3/4 cup sugar" }],
            },
            raw_text: "3/4 cup sugar",
            quantity: {
              value: 0.75,
              unit: "cup",
              raw_text: "3/4 cup",
              evidence: [{ source_type: "ocr", frame_ref: "f1", snippet: "3/4 cup sugar" }],
              confidence: "high",
              conflict: {
                resolved_source: "ocr",
                alternatives: [{ source_type: "asr", value: "1 cup sugar" }],
              },
            },
            is_pantry_staple: false,
          },
        ],
      }),
    );
    const quantity = recipe.ingredients[0]?.quantity;
    expect(quantity?.value).toBe(0.75);
    expect(quantity?.conflict?.resolved_source).toBe("ocr");
    expect(quantity?.conflict?.alternatives).toEqual([{ source_type: "asr", value: "1 cup sugar" }]);
  });

  it("keeps stated vs inferred dietary attributes separate", () => {
    const recipe = validateRecipe(
      baseRecipe({
        dietary_attributes: { stated: ["vegan"], inferred: ["gluten-free"] },
      }),
    );
    expect(recipe.dietary_attributes?.stated).toEqual(["vegan"]);
    expect(recipe.dietary_attributes?.inferred).toEqual(["gluten-free"]);
  });

  it("rejects a mismatched extraction_version", () => {
    expect(() => validateRecipe(baseRecipe({ extraction_version: "old-version" }))).toThrow();
  });
});
