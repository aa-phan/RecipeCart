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
import { extract, persistFailure } from "../pipeline/extract/index.js";
import { ExtractionError } from "../pipeline/extract/failures.js";
import { matchRecipeAndPersist } from "../matcher/index.js";
import { loadStoreLocation } from "../kroger/store_config.js";
import { loadPreferences } from "../api/routes/preferences.js";
import { config } from "../platform/config.js";
import {
  setStage,
  finishJob,
  heartbeat,
  setRecipeFailureClass,
  JobStatus,
  type Job,
} from "../platform/jobs.js";

/** Runs one claimed job through extraction + matching to `awaiting_review` (or
 * a terminal failure state). Never touches the cart — approval is a separate,
 * explicit step (CLI `approve` today; the REST API's cart:approve later). */
export async function runJob(job: Job, workerId: string): Promise<void> {
  const jobId = job.id;
  logger.info("worker: starting job", { jobId, sourceUrl: job.source_url });

  const store = await loadStoreLocation(job.user_id);
  if (!store) {
    await finishJob(jobId, JobStatus.Failed, {
      error:
        "No Kroger store configured — set one via the web app (Preferences) or run " +
        "`recipecart set-store <zip-code>` first.",
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
      // Hard job timeout (Spec C2 §26, config.extraction.jobTimeoutMs): race
      // extract() against a timer rather than trusting it to always settle.
      // Promise.race can only ABANDON the loser, not cancel it — there's no
      // cooperative cancellation for the yt-dlp/Whisper/Claude calls extract()
      // wraps — so on timeout the extract() call keeps running detached in
      // the background.
      const extractPromise = extract(job.source_url, jobId, {});
      let timeoutHandle: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new ExtractionError("extraction_timeout", "This recipe took too long to extract."));
        }, config.extraction.jobTimeoutMs);
      });
      try {
        const { recipe, recipeId: id } = await Promise.race([extractPromise, timeoutPromise]);
        recipeId = id;
        resultType = recipe.result_type;
      } catch (err) {
        if (err instanceof ExtractionError && err.failureClass === "extraction_timeout") {
          // extract()'s own internal catch (index.ts's persistFailure) will
          // never fire for this outcome — we abandoned the await before it
          // could throw. Persist the failure row here via the exact same
          // upsert mechanism extract() uses for every other terminal failure
          // class, so recipes.failure_class ends up populated identically
          // either way (and the outer catch below can treat this exactly
          // like any other classified ExtractionError).
          await persistFailure(jobId, job.source_url, err);
          // Never let the abandoned call's eventual settlement surface as an
          // unhandled promise rejection.
          extractPromise.catch(() => {});
        }
        throw err;
      } finally {
        clearTimeout(timeoutHandle!);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }

    if (resultType === "not_a_recipe") {
      // Distinct failure_class from a genuine technical failure (Spec C2
      // §26): extract() already persisted a normal, successful `recipes` row
      // for this classification (postprocess.ts's result_type is part of a
      // valid Recipe, not an ExtractionError) — this UPDATEs that existing
      // row via the same setRecipeFailureClass mechanism the Kroger
      // connect/reconnect failure cards use, so the API/web failure-card
      // lookup can render a friendly "not a recipe" message instead of the
      // generic fallback.
      await setRecipeFailureClass(
        recipeId,
        "not_a_recipe",
        "This doesn't look like a recipe video.",
      );
      await finishJob(jobId, JobStatus.Failed, {
        recipeId,
        error: "not_a_recipe",
      });
      return;
    }

    await setStage(jobId, JobStatus.MatchingProducts, { recipeId });
    // Wires the Preferences screen's saved settings into ranking (Phase 5)
    // — for the JOB'S OWNER specifically, as of multi-tenancy Slice 2 (the
    // worker processes every account's jobs, not just one).
    const preferences = await loadPreferences(job.user_id);
    await matchRecipeAndPersist(recipeId, store.locationId, { preferences });

    await finishJob(jobId, JobStatus.AwaitingReview, { recipeId });
    logger.info("worker: job reached awaiting_review", { jobId, recipeId });
  } catch (err) {
    if (err instanceof ExtractionError) {
      // The `recipes` failure row is already persisted by this point either
      // way — extract() itself for download/model/schema failures
      // (pipeline/extract/index.ts's persistFailure), or the inner
      // catch above (same persistFailure function) for extraction_timeout,
      // since extract() never gets the chance to run its own catch when
      // Promise.race abandons it. The job just needs to reflect the same
      // terminal outcome. All current FailureClass values
      // (download_failed_permanent/transient, model_call_failed,
      // schema_validation_failed, extraction_timeout) are terminal by the
      // time they surface here, so the job goes straight to Failed rather
      // than requires_user_intervention.
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
