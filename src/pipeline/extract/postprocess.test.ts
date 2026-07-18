import { describe, expect, it } from "vitest";
import { isPantryStaple, normalizeUnit, postprocess } from "./postprocess.js";
import { SCHEMA_VERSION, type Recipe } from "../schema.js";

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    extraction_version: SCHEMA_VERSION,
    source_url: "https://www.tiktok.com/@someone/video/123",
    result_type: "recipe",
    ingredients: [],
    ...overrides,
  } as Recipe;
}

describe("normalizeUnit", () => {
  it("maps common synonyms onto the closed unit set", () => {
    expect(normalizeUnit("grams")).toBe("g");
    expect(normalizeUnit("Tablespoons")).toBe("tbsp");
    expect(normalizeUnit("ounce")).toBe("oz");
    expect(normalizeUnit("piece")).toBe("count");
  });

  it("leaves null as null", () => {
    expect(normalizeUnit(null)).toBeNull();
  });

  it("leaves unrecognized units unchanged rather than guessing", () => {
    expect(normalizeUnit("glugs")).toBe("glugs");
  });
});

describe("isPantryStaple", () => {
  it("matches whole-word staples", () => {
    expect(isPantryStaple("salt")).toBe(true);
    expect(isPantryStaple("olive oil")).toBe(true);
    expect(isPantryStaple("kosher salt")).toBe(true);
  });

  it("does not false-positive on substrings", () => {
    expect(isPantryStaple("flourless chocolate cake")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPantryStaple(null)).toBe(false);
  });
});

describe("postprocess", () => {
  it("normalizes units and sets is_pantry_staple, then re-validates", () => {
    const recipe = baseRecipe({
      ingredients: [
        {
          canonical_name_en: {
            value: "salt",
            evidence: [{ source_type: "ocr", frame_ref: "f1", snippet: "1 tsp salt" }],
          },
          raw_text: "1 teaspoon salt",
          quantity: { value: 1, unit: "teaspoon", raw_text: "1 teaspoon" },
          is_pantry_staple: false,
        },
        {
          canonical_name_en: {
            value: "chicken thighs",
            evidence: [{ source_type: "caption", snippet: "800g chicken thighs" }],
          },
          raw_text: "800g chicken thighs",
          quantity: { value: 800, unit: "grams", raw_text: "800g" },
          is_pantry_staple: false,
        },
      ],
    });

    const result = postprocess(recipe);
    expect(result.ingredients[0]?.quantity.unit).toBe("tsp");
    expect(result.ingredients[0]?.is_pantry_staple).toBe(true);
    expect(result.ingredients[1]?.quantity.unit).toBe("g");
    expect(result.ingredients[1]?.is_pantry_staple).toBe(false);
    // raw_text untouched
    expect(result.ingredients[0]?.raw_text).toBe("1 teaspoon salt");
  });
});
