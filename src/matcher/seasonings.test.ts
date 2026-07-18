import { describe, expect, it } from "vitest";
import { isSeasoning } from "./seasonings.js";

describe("isSeasoning", () => {
  it("matches an exact known seasoning", () => {
    expect(isSeasoning("salt")).toBe(true);
    expect(isSeasoning("garlic powder")).toBe(true);
    expect(isSeasoning("paprika")).toBe(true);
  });

  it("matches case-insensitively with surrounding whitespace", () => {
    expect(isSeasoning("  Salt  ")).toBe(true);
  });

  it("matches a phrase variant via whole-word substring", () => {
    expect(isSeasoning("dried oregano")).toBe(true);
    expect(isSeasoning("fresh garlic powder")).toBe(true);
  });

  it("returns false for core/bulk ingredients", () => {
    expect(isSeasoning("chicken breast")).toBe(false);
    expect(isSeasoning("flour")).toBe(false);
    expect(isSeasoning("olive oil")).toBe(false);
    expect(isSeasoning("milk")).toBe(false);
  });

  it("does not false-positive on a seasoning name appearing mid-word", () => {
    // "basilica" contains "basil" — must not match on a substring alone.
    expect(isSeasoning("basilica cheese")).toBe(false);
  });
});
