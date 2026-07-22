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
import { getDb, DEFAULT_USER_ID } from "../platform/database.js";
import { logger } from "../platform/logger.js";
import { addToCart } from "./client.js";
import { loadToken, saveToken, isExpiredOrMissing, type StoredKrogerToken } from "./token_store.js";
import { refreshAccessToken } from "./auth.js";

export interface CartItemResult {
  ingredientId?: string;
  upc: string;
  status: "added" | "needs_attention";
  reason?: string;
  // Display-only fields threaded through from the ProductCandidate that was
  // approved for this item (see ApprovedCartItem below) — cart_runner itself
  // never looks these up, it only carries them along. Undefined when the
  // caller didn't have candidate data available (e.g. CLI's bare
  // upc/quantity picks) — screens must fall back to showing the UPC, never
  // crash on a missing name.
  productName?: string;
  imageUrl?: string;
  price?: number | null;
  // Display-only note carried from the approved ProductCandidate's own
  // `reason` (e.g. "sold by weight — 1 package (variable weight, set at
  // pickup)", src/matcher/types.ts) for a successfully `added` item — kept
  // distinct from a `needs_attention` item's `reason`, which is always the
  // Kroger failure explanation, not the matcher's note. When an added item
  // ALSO used a fallback candidate, this is combined with the existing
  // fallback-used note (see processItems) rather than overwritten by it.
}

export type CartRunStatus =
  "completed" | "partially_completed" | "failed" | "requires_user_intervention";

/** Set ONLY when `status === "requires_user_intervention"`, distinguishing
 * the two internal branches that produce that status (Phase 5 Kroger
 * connect/reconnect flow fix): no token stored at all (`ensureValidUserToken`
 * found nothing) vs. a token that WAS present but got rejected (401) by
 * Kroger mid-run (expired/revoked). The web app keys its two purpose-built
 * failure cards (`web/src/lib/failureCards.ts`) off these exact strings —
 * see `src/api/routes/cart.ts` for where this gets persisted onto the
 * `recipes` row. */
export type CartAuthFailureClass = "kroger_not_connected" | "kroger_token_expired";

export interface CartRunResult {
  jobId: string;
  status: CartRunStatus;
  results: CartItemResult[];
  summary: string;
  failureClass?: CartAuthFailureClass;
}

export interface ApprovedCartItem {
  upc: string;
  quantity: number;
  ingredientId?: string;
  // Display-only, describing `upc`'s own ProductCandidate — see
  // CartItemResult above for why these are optional/best-effort. Populated
  // by buildApprovedItems (src/api/lib/cart_selection.ts) from the
  // recipe's stored product_matches; not looked up again here.
  productName?: string;
  imageUrl?: string;
  price?: number | null;
  // Display-only note from the approved ProductCandidate's own `reason`
  // (src/matcher/types.ts) — e.g. a weight-sold estimate disclosure.
  // Populated by buildApprovedItems from `selected.reason`; carried onto the
  // `added` CartItemResult by processItems below (PRD C3 §26 "clearly
  // labeled as an estimate ... in the cart result").
  reason?: string;
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
  // Each fallback carries its own display fields (its own candidate), since
  // whichever one actually gets added determines what the result should show.
  fallbacks?: {
    upc: string;
    quantity: number;
    productName?: string;
    imageUrl?: string;
    price?: number | null;
    reason?: string;
  }[];
}

// Small transient retry cap (Spec 3 §2.3 point 4) — only for fetch itself
// throwing (network error), never for a clean API error response.
const TRANSIENT_RETRY_ATTEMPTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensures a valid Kroger user access token for `userId` (multi-tenancy
 * Slice 2 — defaults to DEFAULT_USER_ID for CLI/single-tenant callers),
 * refreshing it if expired/near expiry (Spec 3 §2.3 pre-flight, §2.4 token
 * management). Throws a clear, user-facing error if there's no stored
 * token at all — callers should treat that as a `requires_user_intervention`
 * terminal state, not a crash. Does NOT attempt to trigger the interactive
 * OAuth flow itself; that's a CLI/web-UI-level concern. */
export async function ensureValidUserToken(userId: string = DEFAULT_USER_ID): Promise<string> {
  const stored = await loadToken(userId);
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
  await saveToken(newToken, userId);
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

async function loadExistingRun(idempotencyKey: string): Promise<CartRunResult | null> {
  const db = getDb();
  const row = await db
    .selectFrom("cart_runs")
    .select(["id", "status", "results_json"])
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  if (!row) return null;

  // results_json is jsonb — already parsed on read (no JSON.parse).
  const results = row.results_json as CartItemResult[];
  const status = row.status as CartRunStatus;
  return {
    jobId: row.id,
    status,
    results,
    summary: summarize(status, results),
  };
}

async function persistCartRun(
  jobId: string,
  recipeId: string,
  idempotencyKey: string,
  status: CartRunStatus,
  results: CartItemResult[],
): Promise<void> {
  await getDb()
    .insertInto("cart_runs")
    .values({
      id: jobId,
      recipe_id: recipeId,
      idempotency_key: idempotencyKey,
      status,
      results_json: JSON.stringify(results),
      completed_at: new Date(),
    })
    .execute();
}

/** Updates an EXISTING cart_runs row in place (Spec 3 §2.3 point 5: a
 * requires_user_intervention run is resumable, re-attempting only remaining
 * items — see resumeCartRun). Never inserts a new row; the run keeps its
 * original id/idempotency_key throughout its resume history. */
async function updateCartRun(
  jobId: string,
  status: CartRunStatus,
  results: CartItemResult[],
): Promise<void> {
  await getDb()
    .updateTable("cart_runs")
    .set({ status, results_json: JSON.stringify(results), completed_at: new Date() })
    .where("id", "=", jobId)
    .execute();
}

/** An approved item counts as already-added if a stored `added` result
 * matches it by ingredientId, by its own upc, OR by any of its fallback
 * upcs — the upc that actually got added on a prior attempt may have been a
 * fallback, not `item.upc`, so matching on upc alone would wrongly re-add it. */
function isAlreadyAdded(item: ApprovedCartItem, addedResults: CartItemResult[]): boolean {
  const candidateUpcs = new Set([item.upc, ...(item.fallbacks ?? []).map((f) => f.upc)]);
  return addedResults.some(
    (r) =>
      (item.ingredientId !== undefined && r.ingredientId === item.ingredientId) ||
      candidateUpcs.has(r.upc),
  );
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
  | {
      outcome: "added";
      upc: string;
      usedFallback: boolean;
      productName?: string;
      imageUrl?: string;
      price?: number | null;
      reason?: string;
    }
  | { outcome: "needs_attention"; reason: string }
  | { outcome: "auth_failure"; reason: string }
> {
  const attempts = [
    {
      upc: item.upc,
      quantity: item.quantity,
      productName: item.productName,
      imageUrl: item.imageUrl,
      price: item.price,
      reason: item.reason,
    },
    ...(item.fallbacks ?? []),
  ];
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
      return {
        outcome: "added",
        upc: attempt.upc,
        usedFallback: i > 0,
        productName: attempt.productName,
        imageUrl: attempt.imageUrl,
        price: attempt.price,
        reason: attempt.reason,
      };
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

/** Sequential add with per-item transient retry + fallback (Spec 3 §2.3
 * points 3-4), shared by both a fresh run and a resumed one. Stops
 * immediately on auth_failure (401) without marking that item
 * needs_attention — its state is genuinely unknown/unattempted-in-a-usable-
 * way, driven by the connection, not the item. */
async function processItems(
  items: ApprovedCartItem[],
  accessToken: string,
  recipeId: string,
  jobId: string,
): Promise<{ results: CartItemResult[]; authFailure: boolean }> {
  const results: CartItemResult[] = [];
  let authFailure = false;

  for (const item of items) {
    const outcome = await addItemWithFallback(item, accessToken);

    if (outcome.outcome === "added") {
      // Combine the candidate's own display note (e.g. a weight-sold
      // estimate disclosure, PRD C3 §26) with the fallback-used note when
      // both apply — neither should silently overwrite the other.
      const fallbackNote = outcome.usedFallback
        ? `fallback candidate used — original pick (${item.upc}) was rejected`
        : undefined;
      const reason = [outcome.reason, fallbackNote].filter(Boolean).join(" — ") || undefined;
      results.push({
        ingredientId: item.ingredientId,
        upc: outcome.upc,
        status: "added",
        productName: outcome.productName,
        imageUrl: outcome.imageUrl,
        price: outcome.price,
        ...(reason ? { reason } : {}),
      });
      continue;
    }

    if (outcome.outcome === "auth_failure") {
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
      // Best-effort: the top pick's own candidate data, even though the add
      // failed — still useful for the user to recognize which ingredient
      // this was. Undefined when the caller had no candidate data at all.
      productName: item.productName,
      imageUrl: item.imageUrl,
      price: item.price,
    });
  }

  return { results, authFailure };
}

/** Resumes a run stuck in `requires_user_intervention` (Spec 3 §2.3 point 5:
 * "re-attempts only remaining items"). Re-attempts ONLY the approved items
 * not already `added` in the stored result (matched by ingredientId, upc, or
 * any fallback upc — see isAlreadyAdded), with a freshly-ensured token, and
 * merges the new outcomes with the previously-added ones — never re-sending
 * an item that already succeeded. Updates the SAME cart_runs row in place
 * (same jobId/idempotency_key throughout the run's resume history). */
async function resumeCartRun(
  recipeId: string,
  jobId: string,
  approvedItems: ApprovedCartItem[],
  storedResults: CartItemResult[],
  userId: string,
): Promise<CartRunResult> {
  const alreadyAdded = storedResults.filter((r) => r.status === "added");
  const remaining = approvedItems.filter((item) => !isAlreadyAdded(item, alreadyAdded));

  logger.info("cart_runner: resuming requires_user_intervention run", {
    recipeId,
    jobId,
    alreadyAddedCount: alreadyAdded.length,
    remainingCount: remaining.length,
  });

  if (remaining.length === 0) {
    // Nothing left to retry — every approved item was already added on a
    // prior attempt. Recompute the terminal status from what's actually
    // there rather than leaving it stuck at requires_user_intervention.
    const status = terminalStatusFor(alreadyAdded);
    await updateCartRun(jobId, status, alreadyAdded);
    return { jobId, status, results: alreadyAdded, summary: summarize(status, alreadyAdded) };
  }

  let accessToken: string;
  try {
    accessToken = await ensureValidUserToken(userId);
  } catch (err) {
    // Still not connected — the row stays requires_user_intervention with
    // exactly what it had before (nothing new attempted).
    logger.warn("cart_runner: resume still has no valid token", {
      recipeId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    await updateCartRun(jobId, "requires_user_intervention", alreadyAdded);
    return {
      jobId,
      status: "requires_user_intervention",
      results: alreadyAdded,
      summary: summarize("requires_user_intervention", alreadyAdded),
      failureClass: "kroger_not_connected",
    };
  }

  const { results: newResults, authFailure } = await processItems(
    remaining,
    accessToken,
    recipeId,
    jobId,
  );
  const merged = [...alreadyAdded, ...newResults];
  const status: CartRunStatus = authFailure
    ? "requires_user_intervention"
    : terminalStatusFor(merged);
  await updateCartRun(jobId, status, merged);

  logger.info("cart_runner: resume complete", {
    recipeId,
    jobId,
    status,
    addedCount: merged.filter((r) => r.status === "added").length,
    needsAttentionCount: merged.filter((r) => r.status === "needs_attention").length,
  });

  return {
    jobId,
    status,
    results: merged,
    summary: summarize(status, merged),
    ...(authFailure ? { failureClass: "kroger_token_expired" as const } : {}),
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
  userId: string = DEFAULT_USER_ID,
): Promise<CartRunResult> {
  // 1. Idempotency check first — the primary duplicate guard (Spec 3 §17:
  // no cart-read exists to double-check against). A run already in a
  // genuinely terminal state (completed/partially_completed/failed) replays
  // as-is — do NOT re-run any cart adds. A run stuck in
  // requires_user_intervention is RESUMABLE (Spec 3 §2.3 point 5) rather than
  // replayed: re-attempt only the items not already added.
  const existing = await loadExistingRun(idempotencyKey);
  if (existing) {
    if (existing.status !== "requires_user_intervention") {
      logger.info("cart_runner: idempotent replay, returning stored result", {
        recipeId,
        idempotencyKey,
        jobId: existing.jobId,
        status: existing.status,
      });
      return existing;
    }
    return resumeCartRun(recipeId, existing.jobId, approvedItems, existing.results, userId);
  }

  const jobId = crypto.randomUUID();

  if (approvedItems.length === 0) {
    const results: CartItemResult[] = [];
    const status: CartRunStatus = "failed";
    await persistCartRun(jobId, recipeId, idempotencyKey, status, results);
    return { jobId, status, results, summary: "No approved items were provided." };
  }

  // 2. Pre-flight: get a valid token. Not-connected is a terminal
  // requires_user_intervention result, not a crash.
  let accessToken: string;
  try {
    accessToken = await ensureValidUserToken(userId);
  } catch (err) {
    const status: CartRunStatus = "requires_user_intervention";
    const results: CartItemResult[] = [];
    await persistCartRun(jobId, recipeId, idempotencyKey, status, results);
    logger.warn("cart_runner: no valid token, requires user intervention", {
      recipeId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      jobId,
      status,
      results,
      summary: summarize(status, results),
      failureClass: "kroger_not_connected",
    };
  }

  // 3 & 4. Sequential add, with per-item transient retry.
  const { results, authFailure } = await processItems(approvedItems, accessToken, recipeId, jobId);

  const status: CartRunStatus = authFailure
    ? "requires_user_intervention"
    : terminalStatusFor(results);
  await persistCartRun(jobId, recipeId, idempotencyKey, status, results);

  logger.info("cart_runner: run complete", {
    recipeId,
    jobId,
    status,
    addedCount: results.filter((r) => r.status === "added").length,
    needsAttentionCount: results.filter((r) => r.status === "needs_attention").length,
  });

  return {
    jobId,
    status,
    results,
    summary: summarize(status, results),
    ...(authFailure ? { failureClass: "kroger_token_expired" as const } : {}),
  };
}
