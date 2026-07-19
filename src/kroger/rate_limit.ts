// Kroger daily API-usage tracking + safety guard (Spec 3 §2.1 documented
// limits, §17 rationale). Kroger's Public tier publishes generous daily
// ceilings — Products 10,000/day, Locations 1,600/day/endpoint, Public Cart
// 5,000/day — and asks callers to stay under them. At single-user volume this
// is trivially satisfied, but there's no reason to fly blind: every real API
// call is counted per (UTC day, endpoint) in `kroger_api_usage`, and a run
// refuses to make a call once usage reaches a safety fraction of the ceiling
// (config.kroger.rateLimitSafetyFraction), leaving headroom rather than
// tripping Kroger's hard limit mid-run. Self-contained to the kroger module —
// the client calls into this; nothing else needs to know it exists.
import { getDb } from "../platform/db.js";
import { config } from "../platform/config.js";

export type RateLimitEndpoint = "products" | "locations" | "cart";

/** Thrown by assertUnderLimit when today's usage for an endpoint has reached
 * the configured safety fraction of its documented daily ceiling. Typed so
 * callers can distinguish a self-imposed pre-flight refusal from a real
 * Kroger 429. */
export class RateLimitExceededError extends Error {
  readonly endpoint: RateLimitEndpoint;
  readonly count: number;
  readonly ceiling: number;

  constructor(endpoint: RateLimitEndpoint, count: number, ceiling: number) {
    super(
      `Kroger ${endpoint} API daily rate-limit safety threshold reached: ` +
        `${count} calls today of a ${ceiling}/day ceiling ` +
        `(safety fraction ${config.kroger.rateLimitSafetyFraction}). Refusing further ` +
        `${endpoint} calls until tomorrow (UTC) to stay under Kroger's limit.`,
    );
    this.name = "RateLimitExceededError";
    this.endpoint = endpoint;
    this.count = count;
    this.ceiling = ceiling;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ceilingFor(endpoint: RateLimitEndpoint): number {
  switch (endpoint) {
    case "products":
      return config.kroger.productsDailyLimit;
    case "cart":
      return config.kroger.cartDailyLimit;
    case "locations":
      return config.kroger.locationsDailyLimitPerEndpoint;
  }
}

interface UsageRow {
  count: number;
}

/** Today's (UTC) call count for an endpoint. 0 if none recorded yet. Useful
 * for tests and metrics logging as well as the guard below. */
export function getUsage(endpoint: RateLimitEndpoint): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT count FROM kroger_api_usage WHERE day = ? AND endpoint = ?`)
    .get(today(), endpoint) as UsageRow | undefined;
  return row?.count ?? 0;
}

/** Increment today's (UTC) counter for an endpoint by 1, upserting the row. */
export function recordCall(endpoint: RateLimitEndpoint): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO kroger_api_usage (day, endpoint, count) VALUES (?, ?, 1)
     ON CONFLICT(day, endpoint) DO UPDATE SET count = count + 1`,
  ).run(today(), endpoint);
}

/** Throw RateLimitExceededError if today's usage for `endpoint` has reached
 * the configured safety fraction of its documented daily ceiling. Called
 * BEFORE a request is made, so the run backs off with headroom rather than
 * hitting Kroger's hard limit. */
export function assertUnderLimit(endpoint: RateLimitEndpoint): void {
  const ceiling = ceilingFor(endpoint);
  const threshold = ceiling * config.kroger.rateLimitSafetyFraction;
  const count = getUsage(endpoint);
  if (count >= threshold) {
    throw new RateLimitExceededError(endpoint, count, ceiling);
  }
}
