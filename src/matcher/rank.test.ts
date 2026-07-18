import { describe, expect, it } from "vitest";
import {
  computeUnitPrice,
  packageSizeMagnitude,
  quantityFitScore,
  textRelevanceScore,
} from "./rank.js";

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

  it("still scores (lower) an undersized package rather than excluding it", () => {
    const fit = quantityFitScore({ value: 2, unit: "lb", raw_text: "2 lb" }, "1 lb");
    expect(fit).not.toBeNull();
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

  describe("cross-category density conversion", () => {
    it("converts a volume quantity to weight via a known ingredient density", () => {
      // 3 tsp salt ~= 3 * 4.92892 mL * 1.2 g/mL ~= 17.7g, well under a 26oz (737g) package.
      const fit = quantityFitScore({ value: 3, unit: "tsp", raw_text: "3 tsp" }, "26 oz", "salt");
      expect(fit).not.toBeNull();
      expect(fit!.score).toBeGreaterThan(0);
    });

    it("still returns null for an unknown ingredient with no density entry", () => {
      const fit = quantityFitScore(
        { value: 3, unit: "tsp", raw_text: "3 tsp" },
        "26 oz",
        "some unlisted spice blend",
      );
      expect(fit).toBeNull();
    });

    it("still returns null when no canonicalName is passed at all (back-compat)", () => {
      const fit = quantityFitScore({ value: 3, unit: "tsp", raw_text: "3 tsp" }, "26 oz");
      expect(fit).toBeNull();
    });

    it("never bridges count across categories, even with a density available", () => {
      const fit = quantityFitScore({ value: 2, unit: null, raw_text: "2" }, "26 oz", "salt");
      expect(fit).toBeNull();
    });
  });
});

describe("packageSizeMagnitude", () => {
  it("returns the parsed base quantity for a parseable size", () => {
    expect(packageSizeMagnitude("1 lb")).toBeCloseTo(453.592, 2);
  });

  it("orders smaller packages before larger ones within the same category", () => {
    expect(packageSizeMagnitude("2 oz")).toBeLessThan(packageSizeMagnitude("9.25 oz"));
  });

  it("treats an unparseable size as unknown-large (sorts last)", () => {
    expect(packageSizeMagnitude("assorted")).toBe(Infinity);
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
