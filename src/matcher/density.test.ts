import { describe, expect, it } from "vitest";
import { densityForIngredient } from "./density.js";

describe("densityForIngredient", () => {
  it("matches an exact known ingredient", () => {
    expect(densityForIngredient("salt")).toBeCloseTo(1.2, 5);
  });

  it("matches case-insensitively with surrounding whitespace", () => {
    expect(densityForIngredient("  Salt  ")).toBeCloseTo(1.2, 5);
  });

  it("matches a multi-word density entry as a substring phrase", () => {
    expect(densityForIngredient("fresh garlic powder")).toBeCloseTo(0.45, 5);
  });

  it("does not false-positive on a short entry appearing mid-word", () => {
    // "boiled potatoes" contains the substring "oil" inside "boiled" — must
    // NOT match the "oil" density entry.
    expect(densityForIngredient("boiled potatoes")).toBeNull();
  });

  it("returns null for an ingredient with no known density", () => {
    expect(densityForIngredient("dragonfruit")).toBeNull();
  });
});
