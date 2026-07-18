import { describe, expect, it } from "vitest";
import { computeUnitPrice, quantityFitScore, textRelevanceScore } from "./rank.js";

describe("textRelevanceScore", () => {
  it("scores full-phrase matches highly", () => {
    const score = textRelevanceScore("heavy cream", "Kroger Heavy Whipping Cream, 16 fl oz");
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0.5);
  });

  it("scores partial token overlap lower but non-null", () => {
    const score = textRelevanceScore("chicken thighs", "Perdue Boneless Chicken Breast");
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it("excludes (returns null) when there is no meaningful overlap", () => {
    expect(textRelevanceScore("salt", "Frozen Blueberry Waffles")).toBeNull();
  });
});

describe("quantityFitScore", () => {
  it("scores a package that exactly covers the need highest", () => {
    const fit = quantityFitScore({ value: 1, unit: "lb", raw_text: "1 lb" }, "1 lb");
    expect(fit).not.toBeNull();
    expect(fit!.score).toBeCloseTo(1, 5);
  });

  it("prefers smaller surplus over larger surplus (closest-over rule)", () => {
    const small = quantityFitScore({ value: 8, unit: "oz", raw_text: "8 oz" }, "1 lb");
    const big = quantityFitScore({ value: 8, unit: "oz", raw_text: "8 oz" }, "5 lb");
    expect(small).not.toBeNull();
    expect(big).not.toBeNull();
    expect(small!.score).toBeGreaterThan(big!.score);
  });

  it("covers via buying multiple of a smaller package, within the auto-purchase cap", () => {
    // 2 lb needed from 1 lb packages: buying 2 exactly covers it — this is
    // the normal, expected "closest-over" outcome, not a failure to match.
    const fit = quantityFitScore({ value: 2, unit: "lb", raw_text: "2 lb" }, "1 lb");
    expect(fit).not.toBeNull();
    expect(fit!.covers).toBe(true);
    expect(fit!.unitsNeeded).toBe(2);
    expect(fit!.score).toBeCloseTo(1, 5);
  });

  it("still scores (lower) rather than excluding when even multiple packages can't reasonably cover it", () => {
    // 10 lb needed from 1 lb packages: 10 units exceeds
    // MAX_AUTO_MULTI_UNIT_PURCHASE, so this is no longer auto-resolved —
    // reported (with the real unit count), not excluded.
    const fit = quantityFitScore({ value: 10, unit: "lb", raw_text: "10 lb" }, "1 lb");
    expect(fit).not.toBeNull();
    expect(fit!.covers).toBe(false);
    expect(fit!.unitsNeeded).toBe(10);
    expect(fit!.score).toBeLessThan(0.5);
  });

  it("returns null (skip boost, don't penalize) when unit is unparseable", () => {
    expect(quantityFitScore({ value: 1, unit: "glug", raw_text: "a glug" }, "1 lb")).toBeNull();
  });

  it("returns null when categories don't match (e.g. cups vs weight-only size)", () => {
    expect(quantityFitScore({ value: 1, unit: "cup", raw_text: "1 cup" }, "1 lb")).toBeNull();
  });

  it("returns null when quantity value is null", () => {
    expect(quantityFitScore({ value: null, unit: "cup", raw_text: "a splash" }, "1 lb")).toBeNull();
  });

  it("treats a null unit as count", () => {
    const fit = quantityFitScore({ value: 2, unit: null, raw_text: "2" }, "4 count");
    expect(fit).not.toBeNull();
  });

  describe("cross-category density conversion (core/bulk ingredients only)", () => {
    it("converts a volume quantity to weight via a known ingredient density", () => {
      // 2 cups flour ~= 2 * 236.588 mL * 0.53 g/mL ~= 251g, well under a 5lb (2268g) bag.
      const fit = quantityFitScore(
        { value: 2, unit: "cup", raw_text: "2 cups" },
        "5 lb",
        "flour",
      );
      expect(fit).not.toBeNull();
      expect(fit!.score).toBeGreaterThan(0);
    });

    it("still returns null for an unknown ingredient with no density entry", () => {
      const fit = quantityFitScore(
        { value: 2, unit: "cup", raw_text: "2 cups" },
        "5 lb",
        "some unlisted bulk ingredient",
      );
      expect(fit).toBeNull();
    });

    it("still returns null when no canonicalName is passed at all (back-compat)", () => {
      const fit = quantityFitScore({ value: 2, unit: "cup", raw_text: "2 cups" }, "5 lb");
      expect(fit).toBeNull();
    });

    it("never bridges count across categories, even with a density available", () => {
      const fit = quantityFitScore({ value: 2, unit: null, raw_text: "2" }, "5 lb", "flour");
      expect(fit).toBeNull();
    });

    it("returns null for a seasoning name too — density.ts no longer lists them", () => {
      // rank.ts itself doesn't know about seasonings.ts's classification;
      // matcher/index.ts is what routes seasonings around quantityFitScore
      // entirely. This just confirms density.ts has nothing for "salt" now.
      const fit = quantityFitScore({ value: 3, unit: "tsp", raw_text: "3 tsp" }, "26 oz", "salt");
      expect(fit).toBeNull();
    });
  });
});

describe("computeUnitPrice", () => {
  it("computes price per base unit when size is parseable", () => {
    expect(computeUnitPrice(4, "1 lb")).toBeCloseTo(4 / 453.592, 6);
  });

  it("returns undefined when size is unparseable", () => {
    expect(computeUnitPrice(4, "assorted")).toBeUndefined();
  });
});
