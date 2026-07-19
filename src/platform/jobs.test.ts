import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "./database.js";
import { resetDb } from "./test-db.js";
import {
  enqueueJob,
  claimNextJob,
  heartbeat,
  requeueStaleJobs,
  finishJob,
  JobStatus,
} from "./jobs.js";

const VIDEO_URL = "https://www.tiktok.com/@chef/video/7564134038592605462";
const OTHER_URL = "https://www.tiktok.com/@chef/video/7650230773512965393";

describe("jobs queue", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("enqueues a new job and de-dupes an identical re-submit", async () => {
    const first = await enqueueJob(VIDEO_URL);
    expect(first.created).toBe(true);
    expect(first.job.status).toBe(JobStatus.Received);

    const second = await enqueueJob(VIDEO_URL);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const different = await enqueueJob(OTHER_URL);
    expect(different.created).toBe(true);
    expect(different.job.id).not.toBe(first.job.id);
  });

  it("claims the next job atomically and moves it to validating", async () => {
    const { job } = await enqueueJob(VIDEO_URL);

    const claimed = await claimNextJob("worker-A");
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe(JobStatus.Validating);
    expect(claimed?.locked_by).toBe("worker-A");
    expect(claimed?.locked_at).toBeInstanceOf(Date);
    expect(claimed?.attempt_count).toBe(1);

    // No more runnable jobs → null (single-job-at-a-time).
    const none = await claimNextJob("worker-A");
    expect(none).toBeNull();
  });

  it("heartbeat refreshes the lock timestamp", async () => {
    const { job } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");
    // Backdate the lock, then heartbeat and confirm it advances.
    await getDb()
      .updateTable("jobs")
      .set({ locked_at: new Date(Date.now() - 60_000) })
      .where("id", "=", job.id)
      .execute();
    await heartbeat(job.id, "worker-A");
    const row = await getDb()
      .selectFrom("jobs")
      .select("locked_at")
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(Date.now() - row.locked_at!.getTime()).toBeLessThan(5_000);
  });

  it("requeues a stale re-runnable job and pauses a stale cart mutation", async () => {
    // Re-runnable stale job → back to received.
    const { job: a } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A"); // → validating, locked
    await getDb()
      .updateTable("jobs")
      .set({ locked_at: new Date(Date.now() - 30 * 60_000) }) // 30m ago
      .where("id", "=", a.id)
      .execute();

    // Cart-mutation stale job → requires_user_intervention.
    const { job: b } = await enqueueJob(OTHER_URL);
    await getDb()
      .updateTable("jobs")
      .set({
        status: JobStatus.AddingToCart,
        stage: JobStatus.AddingToCart,
        locked_by: "worker-B",
        locked_at: new Date(Date.now() - 30 * 60_000),
      })
      .where("id", "=", b.id)
      .execute();

    const acted = await requeueStaleJobs();
    expect(acted).toBe(2);

    const aRow = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", a.id)
      .executeTakeFirstOrThrow();
    expect(aRow.status).toBe(JobStatus.Received);
    expect(aRow.locked_by).toBeNull();

    const bRow = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", b.id)
      .executeTakeFirstOrThrow();
    expect(bRow.status).toBe(JobStatus.RequiresUserIntervention);
  });

  // Live-caught bug (2026-07-19, real crash-recovery test): a job requeued
  // after a stale lock got last_error="requeued after stale lock..."; when the
  // RETRY then succeeded, finishJob only wrote last_error when an error was
  // passed, so the stale message silently survived into a terminal SUCCESS
  // state. finishJob/setStage/claimNextJob must always write last_error
  // (to the new value or null), never leave a prior one untouched.
  it("does not carry a stale last_error into a later successful finish", async () => {
    const { job } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");
    // Simulate the message requeueStaleJobs() would have left behind.
    await getDb()
      .updateTable("jobs")
      .set({ last_error: "requeued after stale lock (worker presumed crashed)" })
      .where("id", "=", job.id)
      .execute();

    await getDb()
      .insertInto("recipes")
      .values({
        id: "recipe-stale-error",
        source_url: VIDEO_URL,
        extraction_version: "test",
        recipe_json: JSON.stringify({}),
      })
      .execute();
    await finishJob(job.id, JobStatus.AwaitingReview, { recipeId: "recipe-stale-error" });

    const row = await getDb()
      .selectFrom("jobs")
      .select(["status", "last_error"])
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe(JobStatus.AwaitingReview);
    expect(row.last_error).toBeNull();
  });

  it("finishJob releases the lock and records the terminal status", async () => {
    const { job } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");
    // jobs.recipe_id is an FK to recipes.id — in the real flow extract has
    // already persisted the recipe by the time the job reaches awaiting_review.
    await getDb()
      .insertInto("recipes")
      .values({
        id: "recipe-1",
        source_url: VIDEO_URL,
        extraction_version: "test",
        recipe_json: JSON.stringify({}),
      })
      .execute();
    await finishJob(job.id, JobStatus.AwaitingReview, { recipeId: "recipe-1" });
    const row = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe(JobStatus.AwaitingReview);
    expect(row.locked_by).toBeNull();
    expect(row.recipe_id).toBe("recipe-1");
  });
});
