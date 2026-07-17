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
        quantity: { value: 2, unit: "cup", raw_text: "2 cups" },
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

  it("allows a vague quantity as null value + preserved raw_text (never fabricated)", () => {
    const recipe = validateRecipe(
      baseRecipe({
        ingredients: [
          {
            canonical_name_en: {
              value: "olive oil",
              evidence: [{ source_type: "asr", timestamp: 12.5 }],
            },
            raw_text: "a glug of olive oil",
            quantity: { value: null, unit: null, raw_text: "a glug" },
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
          quantity: { value: 1, unit: "cup", raw_text: "1 cup" },
          is_pantry_staple: false,
        },
      ],
    });
    expect(() => validateRecipe(bad)).toThrow(SchemaValidationError);
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
