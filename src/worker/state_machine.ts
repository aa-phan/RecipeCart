// Job-state machine driver (Spec 4 §2.3). Wraps the UNCHANGED Phase 1/2
// pipeline (`extract()`, `matchRecipeAndPersist()`) per claimed job — the
// worker's whole job is orchestration, not pipeline logic.
//
// State progression driven here:
//   received → validating → downloading → processing_media →
//   extracting_recipe → matching_products → awaiting_review
// `extract()` internally runs download/media/extraction as one call, so this
// driver can't observe those sub-stages mid-flight (Spec 2 owns that
// pipeline) — it marks `downloading` immediately before calling extract() and
// jumps straight to `extracting_recipe`'s outcome after it returns. A finer
// per-substage breakdown would need extract() to accept a stage-callback,
// which is out of scope for this slice (worker wraps the pipeline unchanged).
import { logger } from "../platform/logger.js";
import { extract } from "../pipeline/extract/index.js";
import { ExtractionError } from "../pipeline/extract/failures.js";
import { matchRecipeAndPersist } from "../matcher/index.js";
import { loadStoreLocation } from "../kroger/store_config.js";
import { setStage, finishJob, heartbeat, JobStatus, type Job } from "../platform/jobs.js";

/** Runs one claimed job through extraction + matching to `awaiting_review` (or
 * a terminal failure state). Never touches the cart — approval is a separate,
 * explicit step (CLI `approve` today; the REST API's cart:approve later). */
export async function runJob(job: Job, workerId: string): Promise<void> {
  const jobId = job.id;
  logger.info("worker: starting job", { jobId, sourceUrl: job.source_url });

  const store = loadStoreLocation();
  if (!store) {
    await finishJob(jobId, JobStatus.Failed, {
      error: "No Kroger store configured — run `recipecart set-store <zip-code>` first.",
    });
    return;
  }

  try {
    await setStage(jobId, JobStatus.Downloading);
    // extract() runs download → media processing → OCR/ASR → reconcile →
    // postprocess → persist(recipe + ingredients) as one call (Spec 2 owns
    // this chain unchanged). mockReconcile is never set here — the worker is
    // the "real" path; --mock stays a CLI-only dev convenience.
    const heartbeatTimer = setInterval(() => {
      void heartbeat(jobId, workerId);
    }, 30_000);
    let recipeId: string;
    let resultType: string;
    try {
      await setStage(jobId, JobStatus.ExtractingRecipe);
      const { recipe, recipeId: id } = await extract(job.source_url, jobId, {});
      recipeId = id;
      resultType = recipe.result_type;
    } finally {
      clearInterval(heartbeatTimer);
    }

    if (resultType === "not_a_recipe") {
      await finishJob(jobId, JobStatus.Failed, {
        recipeId,
        error: "not_a_recipe",
      });
      return;
    }

    await setStage(jobId, JobStatus.MatchingProducts, { recipeId });
    await matchRecipeAndPersist(recipeId, store.locationId);

    await finishJob(jobId, JobStatus.AwaitingReview, { recipeId });
    logger.info("worker: job reached awaiting_review", { jobId, recipeId });
  } catch (err) {
    if (err instanceof ExtractionError) {
      // Extraction already persisted its own `recipes` failure row
      // (pipeline/extract/index.ts's persistFailure) — the job just needs to
      // reflect the same terminal outcome. All current FailureClass values
      // (download_failed_permanent/transient, model_call_failed,
      // schema_validation_failed) are terminal-after-their-own-internal-retry
      // (Spec 2 §3) by the time they surface here, so the job goes straight
      // to Failed rather than requires_user_intervention.
      await finishJob(jobId, JobStatus.Failed, {
        error: `[${err.failureClass}] ${err.userFacingReason}`,
      });
      logger.warn("worker: job failed (classified)", {
        jobId,
        failureClass: err.failureClass,
      });
      return;
    }
    // Unclassified error (bug, env issue) — surface it, don't guess a class.
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, JobStatus.Failed, { error: message });
    logger.error("worker: job failed (unclassified)", { jobId, error: message });
  }
}
