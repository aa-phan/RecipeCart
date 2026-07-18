import { describe, expect, it } from "vitest";
import { mockReconcile } from "./mock_reconcile.js";
import { validateRecipe } from "../schema.js";
import type { ReconcileInput } from "./reconcile.js";

function baseInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    sourceUrl: "https://www.tiktok.com/@someone/video/123",
    caption: null,
    asrSegments: [],
    ocrBlocks: [],
    escalationFramePaths: [],
    ...overrides,
  };
}

describe("mockReconcile", () => {
  it("produces a schema-valid Recipe (passes the real validator, not just a shape check)", () => {
    const recipe = mockReconcile(
      baseInput({ caption: "Ingredients: 2 cups flour - 1 tsp salt - 3 eggs" }),
    );
    expect(() => validateRecipe(recipe)).not.toThrow();
  });

  it("marks the title with [MOCK] so a mock run is never mistaken for a real one", () => {
    const recipe = mockReconcile(baseInput({ caption: "800g chicken thighs" }));
    expect(recipe.title?.value).toMatch(/^\[MOCK\]/);
  });

  it("gives title a null_reason (not a fabricated value) when there's no caption", () => {
    const recipe = mockReconcile(baseInput({ caption: null }));
    expect(recipe.title?.value).toBeNull();
    expect(recipe.title?.null_reason).toBeTruthy();
  });

  it("extracts ingredient-shaped lines from the caption with caption evidence", () => {
    const recipe = mockReconcile(
      baseInput({ caption: "800g chicken thighs - 2 tbsp olive oil - 1 tsp paprika" }),
    );
    expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3);
    expect(recipe.ingredients[0]?.canonical_name_en.evidence?.[0]?.source_type).toBe("caption");
  });

  it("extracts from ASR segments with asr evidence including the segment's start timestamp", () => {
    // The shared scorer (ingredient_likelihood.ts) requires the quantity to
    // lead the line — it's tuned for captions/OCR overlay text, not natural
    // speech ("add 2 cups of flour" won't match; that's a known, documented
    // limitation of this dumb heuristic, not something this test should
    // paper over).
    const recipe = mockReconcile(
      baseInput({ asrSegments: [{ text: "2 cups flour", start: 12.5, end: 14.0 }] }),
    );
    const match = recipe.ingredients.find((i) => i.raw_text.includes("2 cups"));
    expect(match?.canonical_name_en.evidence?.[0]).toMatchObject({
      source_type: "asr",
      timestamp: 12.5,
    });
  });

  it("extracts from content-tagged OCR blocks but ignores chrome-tagged ones", () => {
    const recipe = mockReconcile(
      baseInput({
        ocrBlocks: [
          {
            text: "500ml milk",
            frame_ref: "f1",
            tag: "content",
            box: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
          },
          {
            text: "1 tbsp sugar",
            frame_ref: "f2",
            tag: "chrome",
            box: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
          },
        ],
      }),
    );
    expect(recipe.ingredients.some((i) => i.raw_text.includes("500ml milk"))).toBe(true);
    expect(recipe.ingredients.some((i) => i.raw_text.includes("1 tbsp sugar"))).toBe(false);
  });

  it("never fabricates a quantity value — always null with raw_text preserved", () => {
    const recipe = mockReconcile(baseInput({ caption: "800g chicken thighs" }));
    const match = recipe.ingredients.find((i) => i.raw_text.includes("800g"));
    expect(match?.quantity.value).toBeNull();
    expect(match?.quantity.raw_text).toContain("800g");
  });

  it("prioritizes ocr over caption over asr when the same line appears in multiple sources", () => {
    const recipe = mockReconcile(
      baseInput({
        caption: "2 cups flour",
        asrSegments: [{ text: "2 cups flour", start: 5, end: 6 }],
        ocrBlocks: [
          {
            text: "2 cups flour",
            frame_ref: "f1",
            tag: "content",
            box: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
          },
        ],
      }),
    );
    const matches = recipe.ingredients.filter((i) => i.raw_text === "2 cups flour");
    expect(matches).toHaveLength(1); // deduplicated, not one per source
    expect(matches[0]?.canonical_name_en.evidence?.[0]?.source_type).toBe("ocr");
  });

  it("returns an empty (but schema-valid) ingredients list when nothing ingredient-shaped is found", () => {
    const recipe = mockReconcile(baseInput({ caption: "just vibes, no recipe here #fyp" }));
    expect(recipe.ingredients).toEqual([]);
    expect(() => validateRecipe(recipe)).not.toThrow();
  });

  it("always classifies as result_type recipe (mock does no not_a_recipe classification)", () => {
    const recipe = mockReconcile(baseInput());
    expect(recipe.result_type).toBe("recipe");
  });
});
