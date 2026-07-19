import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetDb } from "../platform/test-db.js";

// Real Postgres (via resetDb()) so the actual UPSERT SQL in rate_limit.ts is
// exercised, not just asserted about. The config mock spreads the REAL config
// via importOriginal and only overrides the kroger limits under test —
// replacing the whole module would wipe `databaseUrl` and break getDb()'s
// real connection.
vi.mock("../platform/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/config.js")>();
  return {
    config: {
      ...actual.config,
      kroger: {
        ...actual.config.kroger,
        productsDailyLimit: 100,
        cartDailyLimit: 50,
        locationsDailyLimitPerEndpoint: 20,
        rateLimitSafetyFraction: 0.9, // 90 / 45 / 18 thresholds
      },
    },
  };
});

const { recordCall, getUsage, assertUnderLimit, RateLimitExceededError } = await import(
  "./rate_limit.js"
);

beforeEach(async () => {
  await resetDb();
});

describe("recordCall / getUsage", () => {
  it("starts at 0 for an endpoint with no recorded calls", async () => {
    expect(await getUsage("products")).toBe(0);
  });

  it("increments the counter on each call", async () => {
    await recordCall("products");
    await recordCall("products");
    await recordCall("products");
    expect(await getUsage("products")).toBe(3);
  });

  it("tracks endpoints independently", async () => {
    await recordCall("products");
    await recordCall("cart");
    await recordCall("cart");
    expect(await getUsage("products")).toBe(1);
    expect(await getUsage("cart")).toBe(2);
    expect(await getUsage("locations")).toBe(0);
  });
});

describe("assertUnderLimit", () => {
  it("passes when usage is below the safety threshold", async () => {
    for (let i = 0; i < 89; i++) await recordCall("products"); // threshold is 90 (100 * 0.9)
    await expect(assertUnderLimit("products")).resolves.not.toThrow();
  });

  it("throws RateLimitExceededError once usage reaches the safety threshold", async () => {
    for (let i = 0; i < 90; i++) await recordCall("products"); // exactly at threshold
    await expect(assertUnderLimit("products")).rejects.toThrow(RateLimitExceededError);
  });

  it("uses the correct ceiling per endpoint", async () => {
    for (let i = 0; i < 45; i++) await recordCall("cart"); // cart threshold: 50*0.9=45
    await expect(assertUnderLimit("cart")).rejects.toThrow(RateLimitExceededError);
    // products is unaffected — independent counters/ceilings.
    await expect(assertUnderLimit("products")).resolves.not.toThrow();
  });

  it("does not block a call to a DIFFERENT endpoint once one is over threshold", async () => {
    for (let i = 0; i < 18; i++) await recordCall("locations"); // locations threshold: 20*0.9=18
    await expect(assertUnderLimit("locations")).rejects.toThrow(RateLimitExceededError);
    await expect(assertUnderLimit("cart")).resolves.not.toThrow();
  });
});
