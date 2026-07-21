import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "../platform/database.js";
import { resetDb } from "../platform/test-db.js";
import { enqueueJob, claimNextJob, JobStatus } from "../platform/jobs.js";
import { config } from "../platform/config.js";

// The worker's own store lookup (a local file / env-var fallback) is
// irrelevant to what this file tests (the extract-call timeout and the
// not_a_recipe routing branch, both of which resolve before matching ever
// starts) — stub it so runJob doesn't short-circuit on "no store configured".
vi.mock("../kroger/store_config.js", () => ({
  loadStoreLocation: () => ({ locationId: "loc-1", name: "Test Store", zipCode: "12345" }),
}));

// Only `extract` is mocked — everything else in index.ts (persistFailure in
// particular, the mechanism the timeout branch reuses) stays real so the DB
// write is genuinely exercised, same approach as pipeline/extract/index.test.ts.
const extractMock = vi.fn();
vi.mock("../pipeline/extract/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../pipeline/extract/index.js")>(
      "../pipeline/extract/index.js",
    );
  return { ...actual, extract: extractMock };
});

const { runJob } = await import("./state_machine.js");

const VIDEO_URL = "https://www.tiktok.com/@chef/video/7564134038592605462";

describe("runJob", () => {
  const originalJobTimeoutMs = config.extraction.jobTimeoutMs;

  beforeEach(async () => {
    await resetDb();
    extractMock.mockReset();
  });

  afterEach(() => {
    config.extraction.jobTimeoutMs = originalJobTimeoutMs;
  });

  it("classifies a hung extract() as extraction_timeout, terminates the job, and persists the failure row", async () => {
    config.extraction.jobTimeoutMs = 20; // fire fast rather than waiting 5 real minutes
    extractMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const { job } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");

    await runJob(job, "worker-A");

    const db = getDb();
    const jobRow = await db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(jobRow.status).toBe(JobStatus.Failed);
    expect(jobRow.last_error).toContain("extraction_timeout");

    const recipeRow = await db
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(recipeRow.status).toBe("failed");
    expect(recipeRow.failure_class).toBe("extraction_timeout");
  });

  it("routes result_type=not_a_recipe through a distinct failure_class, not the generic failure path", async () => {
    const { job } = await enqueueJob(VIDEO_URL);
    await claimNextJob("worker-A");

    // Mirrors what extract()'s own persist() would have written for a
    // successful (non-failure) not_a_recipe classification, since extract()
    // itself is mocked out here.
    const db = getDb();
    await db
      .insertInto("recipes")
      .values({
        id: job.id,
        source_url: VIDEO_URL,
        extraction_version: "test-version",
        title: null,
        status: "extracted",
        recipe_json: JSON.stringify({ result_type: "not_a_recipe" }),
      })
      .execute();

    extractMock.mockResolvedValue({
      recipe: { result_type: "not_a_recipe" },
      recipeId: job.id,
    });

    await runJob(job, "worker-A");

    const recipeRow = await db
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    // setRecipeFailureClass only ever UPDATEs failure_class/failure_reason —
    // status/recipe_json (the successful extraction) must be left untouched.
    expect(recipeRow.status).toBe("extracted");
    expect(recipeRow.failure_class).toBe("not_a_recipe");
    expect(recipeRow.failure_reason).toBeTruthy();

    const jobRow = await db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(jobRow.status).toBe(JobStatus.Failed);
    expect(jobRow.last_error).toBe("not_a_recipe");
  });
});
