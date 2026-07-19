// Periodic worker sweep behaviors (Phase 4 cloud-deploy prep). Each sweep is
// independently timed from config and wired into the worker's main loop in
// index.ts, mirroring the existing requeueStaleJobs() stale-lock sweep.
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { getDb } from "../platform/database.js";
import { JobStatus, recordEvent } from "../platform/jobs.js";
import { config } from "../platform/config.js";

/** Disk safety-net sweep (Spec 4 §2.7). The pipeline already deletes each
 * job's temp dir in a try/finally on every terminal state
 * (pipeline/extract/index.ts → cleanupTempDir), so this is NOT the primary
 * cleanup path — it's a periodic sweep for anything a hard crash (kill -9,
 * OOM, container restart) left behind before that finally could run, so a
 * long-lived worker volume doesn't grow unbounded. Scans
 * config.tempMediaDir for per-job subdirectories and removes any whose mtime
 * is older than config.tempMedia.ttlHours. Returns the number removed. */
export async function sweepTempMedia(): Promise<{ removed: number; scannedCount: number }> {
  const dir = config.tempMediaDir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Nothing to sweep if the temp dir doesn't exist yet (fresh volume).
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { removed: 0, scannedCount: 0 };
    }
    throw err;
  }

  const cutoff = Date.now() - config.tempMedia.ttlHours * 60 * 60_000;
  let removed = 0;
  let scannedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scannedCount++;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue; // removed concurrently; nothing to do
    }
    if (stat.mtimeMs < cutoff) {
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    }
  }

  return { removed, scannedCount };
}

/** Awaiting-review → Expired TTL enforcement (Spec 4 A4-6). Transitions any
 * `jobs` row stuck in `awaiting_review` past config.jobs.reviewExpiryDays
 * (measured from updated_at) to `expired`, releasing the row from ongoing
 * review. Mirrors requeueStaleJobs()'s style. Returns the number acted on. */
export async function expireStaleReviews(): Promise<number> {
  const db = getDb();
  const expireBefore = new Date(Date.now() - config.jobs.reviewExpiryDays * 24 * 60 * 60_000);

  const expired = await db
    .updateTable("jobs")
    .set({
      status: JobStatus.Expired,
      stage: JobStatus.Expired,
      updated_at: sql`now()`,
      last_error: "awaiting_review expired after reviewExpiryDays with no action",
    })
    .where("status", "=", JobStatus.AwaitingReview)
    .where("updated_at", "<", expireBefore)
    .returning("id")
    .execute();

  for (const r of expired) await recordEvent({ jobId: r.id, type: "job_expired_review" });
  return expired.length;
}
