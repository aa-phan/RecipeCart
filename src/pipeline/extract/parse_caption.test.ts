import { describe, expect, it } from "vitest";
import { parseCaption } from "./parse_caption.js";

describe("parseCaption (Spec 2 §2.3a caption-sufficiency gate)", () => {
  it("is sufficient when the caption has a real ingredient list (>= default threshold of 3)", () => {
    const caption = [
      "ONLY 540 CALORIES so indulgent, creamy & easy to make!",
      "2 lbs chicken thighs, diced",
      "1 cup heavy cream",
      "2 tbsp paprika",
      "1 tsp garlic powder",
      "#chickenrecipe #easydinner",
    ].join("\n");

    const result = parseCaption(caption);
    expect(result.captionSufficient).toBe(true);
    expect(result.matchedLines.length).toBeGreaterThanOrEqual(3);
  });

  it("is not sufficient for a caption with fewer than the threshold of ingredient-like lines", () => {
    const caption = "Only 540 calories! 2 cups flour and that's basically it, trust me #easy";
    const result = parseCaption(caption);
    expect(result.captionSufficient).toBe(false);
  });

  it("is not sufficient for a caption with no ingredient list at all", () => {
    const caption = "Wait for it 😭🔥 the ending gets me every time #fyp #viral";
    expect(parseCaption(caption).captionSufficient).toBe(false);
  });

  it("handles a missing/empty caption without throwing", () => {
    expect(parseCaption(null).captionSufficient).toBe(false);
    expect(parseCaption(undefined).captionSufficient).toBe(false);
    expect(parseCaption("").captionSufficient).toBe(false);
  });
});
