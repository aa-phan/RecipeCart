import { describe, expect, it } from "vitest";
import { normalizeUnit, parseSizeString } from "./units.js";

describe("normalizeUnit", () => {
  it("recognizes weight units", () => {
    expect(normalizeUnit("lb")).toEqual({ category: "weight", factor: 453.592 });
    expect(normalizeUnit("pounds")).toEqual({ category: "weight", factor: 453.592 });
    expect(normalizeUnit("g")).toEqual({ category: "weight", factor: 1 });
  });

  it("recognizes volume units", () => {
    expect(normalizeUnit("cup")).toEqual({ category: "volume", factor: 236.588 });
    expect(normalizeUnit("fl oz")).toEqual({ category: "volume", factor: 29.5735 });
    expect(normalizeUnit("tbsp")).toEqual({ category: "volume", factor: 14.7868 });
  });

  it("recognizes count units", () => {
    expect(normalizeUnit("each")).toEqual({ category: "count", factor: 1 });
    expect(normalizeUnit("dozen")).toEqual({ category: "count", factor: 12 });
  });

  it("is case/whitespace/period insensitive", () => {
    expect(normalizeUnit(" Fl. Oz. ")).toEqual({ category: "volume", factor: 29.5735 });
  });

  it("returns null for unrecognized or empty units", () => {
    expect(normalizeUnit("glug")).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
    expect(normalizeUnit("")).toBeNull();
  });
});

describe("parseSizeString", () => {
  it("parses a simple weight size", () => {
    expect(parseSizeString("1 lb")).toEqual({ category: "weight", baseQuantity: 453.592 });
  });

  it("parses a simple volume size", () => {
    expect(parseSizeString("8 fl oz")).toEqual({
      category: "volume",
      baseQuantity: 8 * 29.5735,
    });
  });

  it("parses a pint", () => {
    expect(parseSizeString("1 pt")).toEqual({ category: "volume", baseQuantity: 473.176 });
  });

  it("parses a multi-part pack size, using the pack count as a multiplier", () => {
    const result = parseSizeString("24 bottles / 16.9 fl oz");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("volume");
    expect(result!.baseQuantity).toBeCloseTo(24 * 16.9 * 29.5735, 2);
  });

  it("returns null for unparseable strings", () => {
    expect(parseSizeString("assorted")).toBeNull();
    expect(parseSizeString("")).toBeNull();
  });
});
