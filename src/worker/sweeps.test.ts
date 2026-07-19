import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "../platform/database.js";
import { resetDb } from "../platform/test-db.js";
import { enqueueJob, claimNextJob, setStage, JobStatus } from "../platform/jobs.js";
import { config } from "../platform/config.js";
import { sweepTempMedia, expireStaleReviews } from "./sweeps.js";

const VIDEO_URL = "https://www.tiktok.com/@chef/video/7564134038592605462";
const OTHER_URL = "https://www.tiktok.com/@chef/video/7650230773512965393";

describe("expireStaleReviews", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("expires an awaiting_review job past reviewExpiryDays and leaves a recent one alone", async () => {
    const { job: stale } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");
    await setStage(stale.id, JobStatus.AwaitingReview);
    // Backdate updated_at past the TTL.
    const staleUpdatedAt = new Date(
      Date.now() - (config.jobs.reviewExpiryDays * 24 * 60 * 60_000 + 60_000),
    );
    await getDb()
      .updateTable("jobs")
      .set({ updated_at: staleUpdatedAt })
      .where("id", "=", stale.id)
      .execute();

    const { job: recent } = await enqueueJob(OTHER_URL);
    await claimNextJob("worker-B");
    await setStage(recent.id, JobStatus.AwaitingReview);

    const acted = await expireStaleReviews();
    expect(acted).toBe(1);

    const staleRow = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", stale.id)
      .executeTakeFirstOrThrow();
    expect(staleRow.status).toBe(JobStatus.Expired);
    expect(staleRow.stage).toBe(JobStatus.Expired);

    const recentRow = await getDb()
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", recent.id)
      .executeTakeFirstOrThrow();
    expect(recentRow.status).toBe(JobStatus.AwaitingReview);

    const events = await getDb()
      .selectFrom("events")
      .selectAll()
      .where("job_id", "=", stale.id)
      .where("type", "=", "job_expired_review")
      .execute();
    expect(events.length).toBe(1);
  });

  it("is a no-op when nothing is stale", async () => {
    const acted = await expireStaleReviews();
    expect(acted).toBe(0);
  });
});

describe("sweepTempMedia", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recipecart-sweep-test-"));
    vi.spyOn(config, "tempMediaDir", "get").mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("removes a stale job dir and leaves a fresh one alone", async () => {
    const staleDir = path.join(tmpRoot, "stale-job");
    const freshDir = path.join(tmpRoot, "fresh-job");
    fs.mkdirSync(staleDir);
    fs.mkdirSync(freshDir);

    const staleTime = new Date(Date.now() - (config.tempMedia.ttlHours * 60 * 60_000 + 60_000));
    fs.utimesSync(staleDir, staleTime, staleTime);

    const { removed, scannedCount } = await sweepTempMedia();
    expect(scannedCount).toBe(2);
    expect(removed).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("returns zeros when the temp dir doesn't exist yet", async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const { removed, scannedCount } = await sweepTempMedia();
    expect(removed).toBe(0);
    expect(scannedCount).toBe(0);
    // recreate so afterEach cleanup doesn't error
    fs.mkdirSync(tmpRoot, { recursive: true });
  });
});
