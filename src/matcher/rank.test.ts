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
});

describe("computeUnitPrice", () => {
  it("computes price per base unit when size is parseable", () => {
    expect(computeUnitPrice(4, "1 lb")).toBeCloseTo(4 / 453.592, 6);
  });

  it("returns undefined when size is unparseable", () => {
    expect(computeUnitPrice(4, "assorted")).toBeUndefined();
  });
});
