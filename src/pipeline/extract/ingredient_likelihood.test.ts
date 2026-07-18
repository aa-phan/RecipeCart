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

  // Regression: a real TikTok caption (@jalalsamfit, "Sheet Pan Creamy Garlic
  // Cheesy Chicken & Potatoes") came back from yt-dlp as one run-on line with
  // no real newlines — the ingredient list used " - " as an inline separator
  // instead. The original newline-only splitter found zero matches here.
  it("extracts ingredients from a run-on caption using ' - ' as an inline separator", () => {
    const caption =
      "Ingredients (Makes 8 Servings) Chicken & Seasonings - 800g Raw Chicken Breast, cubed " +
      "- 800g Raw Boneless Chicken Thighs, cubed - 3 Tsp Salt - 5 Tsp Italian Herbs Seasoning " +
      "- 4 Tsp Garlic Powder - 4 Tsp Onion Powder - 4-5 Tsp Paprika - 6 Tsp Olive Oil";

    const matches = findIngredientLikelyLines(caption);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("800g Raw Chicken Breast, cubed");
    expect(texts).toContain("800g Raw Boneless Chicken Thighs, cubed");
    expect(texts).toContain("3 Tsp Salt");
    expect(texts).toContain("5 Tsp Italian Herbs Seasoning");
    expect(texts).toContain("4 Tsp Garlic Powder");
    expect(texts).toContain("4 Tsp Onion Powder");
    expect(texts).toContain("4-5 Tsp Paprika");
    expect(texts).toContain("6 Tsp Olive Oil");
    expect(matches.length).toBeGreaterThanOrEqual(8);
  });

  it("does not split mid-word hyphens like 'high-protein' as a separator", () => {
    // "high-protein" must stay one token, not become "high" + "protein" —
    // check by confirming the string wasn't split into multiple segments at
    // all (no ' - ' with surrounding whitespace exists in the input).
    const matches = findIngredientLikelyLines("A high-protein meal prep idea for the week");
    expect(matches.some((m) => m.text === "protein meal prep idea for the week")).toBe(false);
  });

  it("does not treat a sentence starting with the article 'A'/'An' as an ingredient line", () => {
    // Regression: an unpaired "a"/"an" is a common English article, not a
    // reliable quantity signal — "A high-protein meal prep idea..." must not
    // score as ingredient-like just because it starts with "A".
    expect(scoreLine("A high-protein meal prep idea for the week")).toBe(0);
    expect(findIngredientLikelyLines("A high-protein meal prep idea for the week")).toHaveLength(0);
  });

  // Regression: real captions glue the unit directly onto the number with no
  // space ("800g", "44g Carbs") — \b\d+\b\(g|kg|...\)\b can never match that
  // because digit and letter are both \w with no boundary between them.
  it("scores a number+unit glued with no space as high-confidence (e.g. '800g')", () => {
    expect(scoreLine("800g Raw Chicken Breast, cubed")).toBe(1.0);
    expect(scoreLine("120g Shredded Mozzarella")).toBe(1.0);
    expect(scoreLine("400-450ml Regular or Evaporated Milk")).toBe(1.0);
  });
});
