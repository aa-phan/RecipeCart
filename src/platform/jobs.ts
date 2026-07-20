// Postgres-backed job queue primitives (Spec 4 §2.2, §2.3). The worker
// (src/worker/) drives these; the CLI `submit` command (and, later, the REST
// API) enqueue through here. Single job at a time, claimed with
// `FOR UPDATE SKIP LOCKED`.
import crypto from "node:crypto";
import { sql } from "kysely";
import { getDb, DEFAULT_USER_ID, type JobsTable } from "./database.js";
import type { Selectable } from "kysely";
import { config } from "./config.js";
import { normalizeUrl, resolveShortLinkVideoId } from "../pipeline/extract/normalize_url.js";

export type Job = Selectable<JobsTable>;

// Job-state machine (Spec 4 §2.3). Ordered progression; terminal + paused
// states called out. `stage` mirrors `status` for now (the UI reads `stage`);
// they diverge only if we later want a coarser public label than the internal
// status.
export const JobStatus = {
  Received: "received",
  Validating: "validating",
  Downloading: "downloading",
  ProcessingMedia: "processing_media",
  ExtractingRecipe: "extracting_recipe",
  MatchingProducts: "matching_products",
  AwaitingReview: "awaiting_review",
  Approved: "approved",
  AddingToCart: "adding_to_cart",
  Completed: "completed",
  PartiallyCompleted: "partially_completed",
  Failed: "failed",
  RequiresUserIntervention: "requires_user_intervention",
  Expired: "expired",
} as const;
export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

/** In-progress stages that can be safely re-run from scratch after a crash —
 * nothing here mutates external state (the cart). A stale lock in one of these
 * is requeued. `adding_to_cart` is deliberately excluded: re-running it could
 * double-add, so a stale cart-mutation is paused for manual resume instead. */
const REQUEUEABLE_STATES: JobStatusValue[] = [
  JobStatus.Validating,
  JobStatus.Downloading,
  JobStatus.ProcessingMedia,
  JobStatus.ExtractingRecipe,
  JobStatus.MatchingProducts,
];

/** Derive the job-creation idempotency key (Spec 4 §2.5): a re-submit of the
 * same (user, video) inside `duplicateWindowMs` collapses to the same key, so
 * a double-tapped share surfaces the in-flight job instead of spawning a
 * duplicate. Uses the parsed video id when available.
 *
 * For short-link forms (videoId unresolvable from the URL shape alone), this
 * resolves the redirect chain to get a real, stable video id BEFORE deriving
 * the key — real production gap found via live iOS Shortcut testing
 * 2026-07-20: TikTok's native Share button mints a fresh `/t/<token>/`
 * short-link every time, even for the identical underlying video, so keying
 * on the raw URL string (the old behavior) meant re-sharing the same video
 * almost never actually deduped in practice, only when a user happened to
 * paste the literal identical URL string twice. Falls back to the raw URL on
 * any resolution failure (network hiccup, timeout) — strictly no worse than
 * the old behavior, never a hard failure. */
async function deriveIdempotencyKey(userId: string, sourceUrl: string): Promise<string> {
  let key: string;
  try {
    const { videoId, url } = normalizeUrl(sourceUrl);
    if (videoId) {
      key = videoId;
    } else {
      const resolvedVideoId = await resolveShortLinkVideoId(
        url,
        config.jobs.shortLinkResolveTimeoutMs,
      );
      key = resolvedVideoId ?? url;
    }
  } catch {
    key = sourceUrl; // let validation reject it later; still de-dupe identical submits
  }
  const bucket = Math.floor(Date.now() / config.jobs.duplicateWindowMs);
  return crypto.createHash("sha256").update(`${userId}|${key}|${bucket}`).digest("hex");
}

/** Enqueue a job for `sourceUrl`. If an equivalent submit already exists within
 * the dedupe window, returns that existing job (and `created: false`) rather
 * than inserting a duplicate. */
export async function enqueueJob(
  sourceUrl: string,
  userId: string = DEFAULT_USER_ID,
  opts: { bypassDedup?: boolean } = {},
): Promise<{ job: Job; created: boolean }> {
  const db = getDb();
  const idempotencyKey = await deriveIdempotencyKey(userId, sourceUrl);
  // `bypassDedup` is used by the API's reprocess endpoint: it wants a brand
  // new job for the same source URL even though the normal dedupe window
  // would otherwise collapse it into the existing (already-terminal) job.
  // The idempotency key itself is still made unique below so the row can be
  // inserted without colliding with the original.
  const insertKey = opts.bypassDedup
    ? `${idempotencyKey}|reprocess|${crypto.randomUUID()}`
    : idempotencyKey;

  if (!opts.bypassDedup) {
    const existing = await db
      .selectFrom("jobs")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) return { job: existing, created: false };
  }

  const id = crypto.randomUUID();
  try {
    const job = await db
      .insertInto("jobs")
      .values({
        id,
        user_id: userId,
        source_url: sourceUrl,
        status: JobStatus.Received,
        stage: JobStatus.Received,
        idempotency_key: insertKey,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordEvent({ jobId: id, type: "job_received", data: { sourceUrl } });
    return { job, created: true };
  } catch (err) {
    if (opts.bypassDedup) throw err;
    // A concurrent submit may have won the unique(idempotency_key) race — fall
    // back to the row it created rather than surfacing a constraint error.
    const raced = await db
      .selectFrom("jobs")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (raced) return { job: raced, created: false };
    throw err;
  }
}

/** Claim the next runnable job atomically (`FOR UPDATE SKIP LOCKED`), moving it
 * to `validating` and stamping the lock. Returns null when the queue is empty.
 * Single-job-at-a-time is enforced by the caller polling one at a time. */
export async function claimNextJob(workerId: string): Promise<Job | null> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const next = await trx
      .selectFrom("jobs")
      .selectAll()
      .where("status", "=", JobStatus.Received)
      .where("run_after", "<=", sql<Date>`now()`)
      .orderBy("run_after")
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!next) return null;

    const claimed = await trx
      .updateTable("jobs")
      .set({
        status: JobStatus.Validating,
        stage: JobStatus.Validating,
        locked_by: workerId,
        locked_at: sql`now()`,
        attempt_count: next.attempt_count + 1,
        updated_at: sql`now()`,
        last_error: null, // clear any stale message from a prior requeue/failure
      })
      .where("id", "=", next.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return claimed;
  });
}

/** Refresh the lock timestamp during a long stage so the stale-lock sweep
 * doesn't reclaim a job that's still actively being worked. */
export async function heartbeat(jobId: string, workerId: string): Promise<void> {
  await getDb()
    .updateTable("jobs")
    .set({ locked_at: sql`now()`, updated_at: sql`now()` })
    .where("id", "=", jobId)
    .where("locked_by", "=", workerId)
    .execute();
}

/** Advance a job's status/stage and log a transition event.
 *
 * `last_error` is ALWAYS written (to `extra.error` or `null`) — same
 * reasoning as `finishJob`: a stale message from a prior requeue must not
 * silently persist through a normal forward transition. */
export async function setStage(
  jobId: string,
  status: JobStatusValue,
  extra: { recipeId?: string; error?: string } = {},
): Promise<void> {
  await getDb()
    .updateTable("jobs")
    .set({
      status,
      stage: status,
      updated_at: sql`now()`,
      last_error: extra.error ?? null,
      ...(extra.recipeId ? { recipe_id: extra.recipeId } : {}),
    })
    .where("id", "=", jobId)
    .execute();
  await recordEvent({
    jobId,
    recipeId: extra.recipeId,
    type: `job_${status}`,
    data: extra.error ? { error: extra.error } : undefined,
  });
}

/** Move a job to a terminal/paused state and release the lock.
 *
 * `last_error` is ALWAYS written (to `extra.error` or `null`), never left
 * untouched — a prior requeue/heartbeat cycle may have left a transient
 * message (e.g. "requeued after stale lock...") in that column, and a job
 * that goes on to finish successfully must not carry that message forward
 * into a terminal success state (a real bug, live-caught: a
 * crash-recovered-then-succeeded job showed a stale "requeued" error despite
 * reaching awaiting_review). */
export async function finishJob(
  jobId: string,
  status: JobStatusValue,
  extra: { error?: string; recipeId?: string } = {},
): Promise<void> {
  await getDb()
    .updateTable("jobs")
    .set({
      status,
      stage: status,
      locked_by: null,
      locked_at: null,
      updated_at: sql`now()`,
      last_error: extra.error ?? null,
      ...(extra.recipeId ? { recipe_id: extra.recipeId } : {}),
    })
    .where("id", "=", jobId)
    .execute();
  await recordEvent({
    jobId,
    recipeId: extra.recipeId,
    type: `job_${status}`,
    data: extra.error ? { error: extra.error } : undefined,
  });
}

/** Requeue jobs whose worker died mid-stage (lock older than staleLockMs).
 * Re-runnable stages go back to `received`; a stale cart mutation is paused as
 * `requires_user_intervention` (never blindly re-run — Spec 3 §17). Returns the
 * number of jobs acted on. */
export async function requeueStaleJobs(): Promise<number> {
  const db = getDb();
  const staleBefore = new Date(Date.now() - config.jobs.staleLockMs);

  const requeued = await db
    .updateTable("jobs")
    .set({
      status: JobStatus.Received,
      stage: JobStatus.Received,
      locked_by: null,
      locked_at: null,
      run_after: sql`now()`,
      updated_at: sql`now()`,
      last_error: "requeued after stale lock (worker presumed crashed)",
    })
    .where("locked_at", "is not", null)
    .where("locked_at", "<", staleBefore)
    .where("status", "in", REQUEUEABLE_STATES)
    .returning("id")
    .execute();

  const paused = await db
    .updateTable("jobs")
    .set({
      status: JobStatus.RequiresUserIntervention,
      stage: JobStatus.RequiresUserIntervention,
      locked_by: null,
      locked_at: null,
      updated_at: sql`now()`,
      last_error: "cart mutation interrupted; manual resume required",
    })
    .where("locked_at", "is not", null)
    .where("locked_at", "<", staleBefore)
    .where("status", "=", JobStatus.AddingToCart)
    .returning("id")
    .execute();

  for (const r of requeued) await recordEvent({ jobId: r.id, type: "job_requeued_stale" });
  for (const r of paused) await recordEvent({ jobId: r.id, type: "job_paused_stale_cart" });
  return requeued.length + paused.length;
}

/** Append an event to the log (Spec 4 §2.4 events, append-only). */
export async function recordEvent(e: {
  jobId?: string;
  recipeId?: string;
  type: string;
  data?: unknown;
}): Promise<void> {
  await getDb()
    .insertInto("events")
    .values({
      job_id: e.jobId ?? null,
      recipe_id: e.recipeId ?? null,
      type: e.type,
      data: e.data === undefined ? null : JSON.stringify(e.data),
    })
    .execute();
}
