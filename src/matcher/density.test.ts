import { describe, expect, it } from "vitest";
import { densityForIngredient } from "./density.js";

describe("densityForIngredient", () => {
  it("matches an exact known core/bulk ingredient", () => {
    expect(densityForIngredient("flour")).toBeCloseTo(0.53, 5);
  });

  it("matches case-insensitively with surrounding whitespace", () => {
    expect(densityForIngredient("  Flour  ")).toBeCloseTo(0.53, 5);
  });

  it("matches a multi-word density entry as a substring phrase", () => {
    expect(densityForIngredient("fresh olive oil")).toBeCloseTo(0.92, 5);
  });

  it("does not false-positive on a short entry appearing mid-word", () => {
    // "boiled potatoes" contains the substring "oil" inside "boiled" — must
    // NOT match the "oil" density entry.
    expect(densityForIngredient("boiled potatoes")).toBeNull();
  });

  it("returns null for an ingredient with no known density", () => {
    expect(densityForIngredient("dragonfruit")).toBeNull();
  });

  it("does not carry density entries for seasonings (moved to seasonings.ts)", () => {
    // Seasonings skip quantity-fit scoring entirely (see seasonings.ts) —
    // they should never resolve to a density here.
    expect(densityForIngredient("salt")).toBeNull();
    expect(densityForIngredient("garlic powder")).toBeNull();
    expect(densityForIngredient("paprika")).toBeNull();
  });
});
