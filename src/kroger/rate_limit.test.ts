import { describe, expect, it, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

// Real in-memory sqlite (not a hand-rolled fake) so the actual UPSERT SQL in
// rate_limit.ts is exercised, not just asserted about. Schema mirrors the
// real kroger_api_usage table (db.ts) without importing db.ts itself, to
// keep this test isolated from db.ts's other tables/migration.
let sqlite: DatabaseSync;

vi.mock("../platform/db.js", () => ({
  getDb: () => sqlite,
}));

vi.mock("../platform/config.js", () => ({
  config: {
    kroger: {
      productsDailyLimit: 100,
      cartDailyLimit: 50,
      locationsDailyLimitPerEndpoint: 20,
      rateLimitSafetyFraction: 0.9, // 90 / 45 / 18 thresholds
    },
  },
}));

const { recordCall, getUsage, assertUnderLimit, RateLimitExceededError } = await import(
  "./rate_limit.js"
);

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE kroger_api_usage (
      day TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, endpoint)
    );
  `);
});

describe("recordCall / getUsage", () => {
  it("starts at 0 for an endpoint with no recorded calls", () => {
    expect(getUsage("products")).toBe(0);
  });

  it("increments the counter on each call", () => {
    recordCall("products");
    recordCall("products");
    recordCall("products");
    expect(getUsage("products")).toBe(3);
  });

  it("tracks endpoints independently", () => {
    recordCall("products");
    recordCall("cart");
    recordCall("cart");
    expect(getUsage("products")).toBe(1);
    expect(getUsage("cart")).toBe(2);
    expect(getUsage("locations")).toBe(0);
  });
});

describe("assertUnderLimit", () => {
  it("passes when usage is below the safety threshold", () => {
    for (let i = 0; i < 89; i++) recordCall("products"); // threshold is 90 (100 * 0.9)
    expect(() => assertUnderLimit("products")).not.toThrow();
  });

  it("throws RateLimitExceededError once usage reaches the safety threshold", () => {
    for (let i = 0; i < 90; i++) recordCall("products"); // exactly at threshold
    expect(() => assertUnderLimit("products")).toThrow(RateLimitExceededError);
  });

  it("uses the correct ceiling per endpoint", () => {
    for (let i = 0; i < 45; i++) recordCall("cart"); // cart threshold: 50*0.9=45
    expect(() => assertUnderLimit("cart")).toThrow(RateLimitExceededError);
    // products is unaffected — independent counters/ceilings.
    expect(() => assertUnderLimit("products")).not.toThrow();
  });

  it("does not block a call to a DIFFERENT endpoint once one is over threshold", () => {
    for (let i = 0; i < 18; i++) recordCall("locations"); // locations threshold: 20*0.9=18
    expect(() => assertUnderLimit("locations")).toThrow(RateLimitExceededError);
    expect(() => assertUnderLimit("cart")).not.toThrow();
  });
});
