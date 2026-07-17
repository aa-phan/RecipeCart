import { describe, expect, it } from "vitest";
import { findIngredientLikelyLines, scoreLine } from "./ingredient_likelihood.js";

describe("scoreLine", () => {
  it("scores quantity+unit lines highest", () => {
    expect(scoreLine("2 cups flour")).toBe(1.0);
    expect(scoreLine("1 tsp salt")).toBe(1.0);
    expect(scoreLine("- 1/2 cup sugar")).toBe(1.0);
  });

  it("scores a bare quantity without a unit lower", () => {
    expect(scoreLine("3 eggs")).toBeGreaterThan(0);
    expect(scoreLine("3 eggs")).toBeLessThan(1.0);
  });

  it("scores non-ingredient prose as zero", () => {
    expect(scoreLine("This recipe is so easy and delicious!")).toBe(0);
    expect(scoreLine("#recipe #cooking #foodtiktok")).toBe(0);
    expect(scoreLine("")).toBe(0);
  });
});

describe("findIngredientLikelyLines", () => {
  it("extracts ingredient lines from a caption that mixes list + hashtags", () => {
    const caption = [
      "So indulgent, creamy & easy to make!",
      "Ingredients:",
      "2 lbs chicken thighs, diced",
      "1 cup heavy cream",
      "2 tbsp paprika",
      "1 tsp garlic powder",
      "Salt to taste",
      "#chickenrecipe #easydinner #foodtiktok",
    ].join("\n");

    const matches = findIngredientLikelyLines(caption);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("2 lbs chicken thighs, diced");
    expect(texts).toContain("1 cup heavy cream");
    expect(texts).toContain("2 tbsp paprika");
    expect(texts).toContain("1 tsp garlic powder");
    expect(texts).not.toContain("#chickenrecipe #easydinner #foodtiktok");
  });

  it("returns nothing useful for a caption with no ingredient list", () => {
    const caption = "Wait for it 😭🔥 the ending gets me every time #fyp #viral";
    expect(findIngredientLikelyLines(caption)).toHaveLength(0);
  });
});
