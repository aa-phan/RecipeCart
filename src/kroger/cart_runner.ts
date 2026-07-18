// Cart runner (Spec 3 §2.3, "[P1 basic, P2 safeguards]"). Turns a set of
// human-approved product matches into real Kroger cart adds. The Public Cart
// API has no read endpoint at this tier (§17 rationale lives in
// files/specs/spec-3-kroger-matching-cart.md §2.3) — there is no
// "fresh cart-read before mutating" / "re-read after write" pattern
// available here at all. Two things stand in for it:
//   1. addToCart()'s own response IS the confirmation signal (204 = accepted
//      by Kroger; anything else carries a specific error reason).
//   2. The idempotency_key UNIQUE constraint on cart_runs is the primary
//      duplicate guard against a retried/duplicate approval re-running adds
//      that already happened — checked FIRST, before any network call.
//
// KNOWN GAP, live-confirmed (2026-07-18): (1) is not a reliable fulfillment
// guarantee. A paprika UPC that Kroger's Products search API still reports
// `stockLevel: HIGH` / fully fulfillable for got a clean 204 accept from
// addToCart, then showed as out-of-stock in the real cart. Kroger's
// fulfillment-time stock check evidently differs from what search/write
// report, and the write-only Cart API gives no way to detect this at add
// time. `ApprovedCartItem.fallbacks` (below) only helps the DETECTABLE
// failure case — Kroger actually rejecting an add — not this silent one;
// there is currently no mechanical fix for the silent case at this API tier.
import { getDb } from "../platform/db.js";
import { logger } from "../platform/logger.js";
import { addToCart } from "./client.js";
import { loadToken, saveToken, isExpiredOrMissing, type StoredKrogerToken } from "./token_store.js";
import { refreshAccessToken } from "./auth.js";

export interface CartItemResult {
  ingredientId?: string;
  upc: string;
  status: "added" | "needs_attention";
  reason?: string;
}

export type CartRunStatus =
  "completed" | "partially_completed" | "failed" | "requires_user_intervention";

export interface CartRunResult {
  jobId: string;
  status: CartRunStatus;
  results: CartItemResult[];
  summary: string;
}

export interface ApprovedCartItem {
  upc: string;
  quantity: number;
  ingredientId?: string;
  // Next-best-ranked candidates to try, in order, ONLY when Kroger's
  // addToCart itself rejects `upc` (a real, detectable failure). This does
  // NOT help when Kroger accepts the add (204) for an item that later turns
  // out unavailable at fulfillment time — found live: a paprika UPC Kroger's
  // own Products search API still reports `stockLevel: HIGH` / fully
  // fulfillable for showed as out-of-stock in the actual cart after a clean
  // 204 accept. The Public Cart API is write-only (no read/stock-validation
  // endpoint at this tier — see module doc), so a silent accept-then-later-
  // unavailable case is invisible to this code entirely; this field only
  // improves the cases where Kroger DOES signal rejection at write time.
  fallbacks?: { upc: string; quantity: number }[];
}

// Small transient retry cap (Spec 3 §2.3 point 4) — only for fetch itself
// throwing (network error), never for a clean API error response.
const TRANSIENT_RETRY_ATTEMPTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensures a valid Kroger user access token, refreshing it if expired/near
 * expiry (Spec 3 §2.3 pre-flight, §2.4 token management). Throws a clear,
 * user-facing error if there's no stored token at all — callers should treat
 * that as a `requires_user_intervention` terminal state, not a crash. Does
 * NOT attempt to trigger the interactive OAuth flow itself; that's a
 * CLI-level concern. */
export async function ensureValidUserToken(): Promise<string> {
  const stored = loadToken();
  if (!stored) {
    throw new Error("Not connected to Kroger — run `recipecart auth` first");
  }

  if (!isExpiredOrMissing(stored)) {
    return stored.accessToken;
  }

  const refreshed = await refreshAccessToken(stored.refreshToken);
  const newToken: StoredKrogerToken = {
    accessToken: refreshed.access_token,
    // Refresh token rotation is optional per OAuth2 convention — keep the
    // old one if the response didn't include a new one.
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  saveToken(newToken);
  return newToken.accessToken;
}

function reasonFromAddToCartFailure(reason: unknown, status: number): string {
  if (reason && typeof reason === "object") {
    const obj = reason as Record<string, unknown>;
    const candidate = obj.reason ?? obj.error ?? obj.message ?? obj.errors;
    if (typeof candidate === "string") return candidate;
    if (candidate !== undefined) {
      try {
        return JSON.stringify(candidate);
      } catch {
        // fall through
      }
    }
  }
  if (typeof reason === "string" && reason.length > 0) return reason;
  return `Kroger API error ${status}`;
}

interface StoredCartRunRow {
  id: string;
  status: CartRunStatus;
  results_json: string;
}

function loadExistingRun(idempotencyKey: string): CartRunResult | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT id, status, results_json FROM cart_runs WHERE idempotency_key = ?`)
    .get(idempotencyKey) as StoredCartRunRow | undefined;
  if (!row) return null;

  const results = JSON.parse(row.results_json) as CartItemResult[];
  return {
    jobId: row.id,
    status: row.status,
    results,
    summary: summarize(row.status, results),
  };
}

function persistCartRun(
  jobId: string,
  recipeId: string,
  idempotencyKey: string,
  status: CartRunStatus,
  results: CartItemResult[],
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO cart_runs (id, recipe_id, idempotency_key, status, results_json, completed_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(jobId, recipeId, idempotencyKey, status, JSON.stringify(results));
}

function summarize(status: CartRunStatus, results: CartItemResult[]): string {
  const added = results.filter((r) => r.status === "added").length;
  const needsAttention = results.filter((r) => r.status === "needs_attention").length;
  switch (status) {
    case "completed":
      return `Added ${added} item${added === 1 ? "" : "s"} to your Kroger cart.`;
    case "partially_completed":
      return `Added ${added} item${added === 1 ? "" : "s"} to your Kroger cart; ${needsAttention} need${needsAttention === 1 ? "s" : ""} attention.`;
    case "failed":
      return `Failed to add any items to your Kroger cart (${needsAttention} item${needsAttention === 1 ? "" : "s"} need attention).`;
    case "requires_user_intervention":
      return added > 0
        ? `Added ${added} item${added === 1 ? "" : "s"} before your Kroger connection needed re-authorization. Run \`recipecart auth\` and retry the remaining items.`
        : "Not connected to Kroger (or the connection was revoked) — run `recipecart auth` and try again.";
  }
}

function terminalStatusFor(results: CartItemResult[]): CartRunStatus {
  const added = results.filter((r) => r.status === "added").length;
  const needsAttention = results.filter((r) => r.status === "needs_attention").length;
  if (added > 0 && needsAttention === 0) return "completed";
  if (added > 0 && needsAttention > 0) return "partially_completed";
  return "failed";
}

/** Calls addToCart for a single (upc, quantity), retrying up to
 * TRANSIENT_RETRY_ATTEMPTS times ONLY when fetch itself throws (network
 * error) — a clean API error response (404/400/429/...) is not retried,
 * per Spec 3 §2.3 point 4. */
async function addItemWithRetry(
  upc: string,
  quantity: number,
  accessToken: string,
): Promise<
  | { outcome: "added" }
  | { outcome: "needs_attention"; reason: string }
  | { outcome: "auth_failure"; reason: string }
> {
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await addToCart(upc, quantity, accessToken);
      if (result.ok) {
        return { outcome: "added" };
      }
      if (result.status === 401) {
        return {
          outcome: "auth_failure",
          reason: reasonFromAddToCartFailure(result.reason, result.status),
        };
      }
      // Clean API error response (404/400/429/etc.) — not transient, don't retry.
      return {
        outcome: "needs_attention",
        reason: reasonFromAddToCartFailure(result.reason, result.status),
      };
    } catch (err) {
      // fetch itself threw — network error, potentially transient.
      lastNetworkError = err;
      logger.warn("cart_runner: transient network error adding item, will retry", {
        upc,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < TRANSIENT_RETRY_ATTEMPTS) {
        await delay(TRANSIENT_RETRY_DELAY_MS);
      }
    }
  }

  const message =
    lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError);
  return { outcome: "needs_attention", reason: `Network error: ${message}` };
}

/** Tries `item.upc` first, then each of `item.fallbacks` in order, ONLY when
 * Kroger's addToCart actually rejects the previous attempt (a detectable
 * failure) — never for a silent 204-accept-then-later-unavailable case,
 * which this can't see (module doc above). Stops immediately on
 * auth_failure (unrelated to product choice — retrying a different UPC
 * won't fix an expired/revoked token). Returns which UPC actually
 * succeeded, since it may not be the original top pick. */
async function addItemWithFallback(
  item: ApprovedCartItem,
  accessToken: string,
): Promise<
  | { outcome: "added"; upc: string; usedFallback: boolean }
  | { outcome: "needs_attention"; reason: string }
  | { outcome: "auth_failure"; reason: string }
> {
  const attempts = [{ upc: item.upc, quantity: item.quantity }, ...(item.fallbacks ?? [])];
  const failureReasons: string[] = [];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const outcome = await addItemWithRetry(attempt.upc, attempt.quantity, accessToken);

    if (outcome.outcome === "added") {
      if (i > 0) {
        logger.info("cart_runner: fallback candidate succeeded after rejection", {
          ingredientId: item.ingredientId,
          rejectedUpc: item.upc,
          addedUpc: attempt.upc,
          attemptIndex: i,
        });
      }
      return { outcome: "added", upc: attempt.upc, usedFallback: i > 0 };
    }
    if (outcome.outcome === "auth_failure") {
      return outcome;
    }
    failureReasons.push(`${attempt.upc}: ${outcome.reason}`);
  }

  return {
    outcome: "needs_attention",
    reason:
      attempts.length > 1
        ? `all ${attempts.length} candidates rejected — ${failureReasons.join("; ")}`
        : failureReasons[0]!,
  };
}

/** Runs a human-approved cart addition for a recipe (Spec 3 §2.3). Never
 * adds anything to the cart without having gone through the caller's
 * explicit approval step — this function assumes `approvedItems` has
 * already been filtered/confirmed by the human upstream. */
export async function runCartApproval(
  recipeId: string,
  approvedItems: ApprovedCartItem[],
  idempotencyKey: string,
): Promise<CartRunResult> {
  // 1. Idempotency check first — the primary duplicate guard (Spec 3 §17:
  // no cart-read exists to double-check against). Do NOT re-run any cart
  // adds if this key was already processed.
  const existing = loadExistingRun(idempotencyKey);
  if (existing) {
    logger.info("cart_runner: idempotent replay, returning stored result", {
      recipeId,
      idempotencyKey,
      jobId: existing.jobId,
      status: existing.status,
    });
    return existing;
  }

  const jobId = crypto.randomUUID();

  if (approvedItems.length === 0) {
    const results: CartItemResult[] = [];
    const status: CartRunStatus = "failed";
    persistCartRun(jobId, recipeId, idempotencyKey, status, results);
    return { jobId, status, results, summary: "No approved items were provided." };
  }

  // 2. Pre-flight: get a valid token. Not-connected is a terminal
  // requires_user_intervention result, not a crash.
  let accessToken: string;
  try {
    accessToken = await ensureValidUserToken();
  } catch (err) {
    const status: CartRunStatus = "requires_user_intervention";
    const results: CartItemResult[] = [];
    persistCartRun(jobId, recipeId, idempotencyKey, status, results);
    logger.warn("cart_runner: no valid token, requires user intervention", {
      recipeId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { jobId, status, results, summary: summarize(status, results) };
  }

  // 3 & 4. Sequential add, with per-item transient retry.
  const results: CartItemResult[] = [];
  let authFailure = false;

  for (const item of approvedItems) {
    const outcome = await addItemWithFallback(item, accessToken);

    if (outcome.outcome === "added") {
      results.push({
        ingredientId: item.ingredientId,
        upc: outcome.upc,
        status: "added",
        ...(outcome.usedFallback
          ? { reason: `fallback candidate used — original pick (${item.upc}) was rejected` }
          : {}),
      });
      continue;
    }

    if (outcome.outcome === "auth_failure") {
      // 401 mid-run — stop processing remaining items, terminal
      // requires_user_intervention. Do not mark this item needs_attention;
      // it's genuinely unknown/unattempted-in-a-usable-way state, driven by
      // the connection, not the item.
      logger.warn("cart_runner: token invalid mid-run, stopping", {
        recipeId,
        jobId,
        upc: item.upc,
      });
      authFailure = true;
      break;
    }

    results.push({
      ingredientId: item.ingredientId,
      upc: item.upc,
      status: "needs_attention",
      reason: outcome.reason,
    });
  }

  const status: CartRunStatus = authFailure
    ? "requires_user_intervention"
    : terminalStatusFor(results);
  persistCartRun(jobId, recipeId, idempotencyKey, status, results);

  logger.info("cart_runner: run complete", {
    recipeId,
    jobId,
    status,
    addedCount: results.filter((r) => r.status === "added").length,
    needsAttentionCount: results.filter((r) => r.status === "needs_attention").length,
  });

  return { jobId, status, results, summary: summarize(status, results) };
}
