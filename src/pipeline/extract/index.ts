// extract orchestrator (Spec 2 §2.1). Chains every stage into a single
// `extract(url, jobId) -> Recipe`. Each stage function takes a
// job-context-shaped argument on purpose (see types.ts's JobContext) so a
// P3 worker can wrap this same chain per-job without a signature refactor —
// P1 just calls it directly, synchronously, from the CLI.
//
// The whole chain runs inside try/finally: cleanupTempDir(jobId) is called
// unconditionally on every terminal state (success or failure) — the
// project's non-negotiable "media temp files deleted after every run" (Spec
// 4), not something that can be skipped because reconcile or postprocess
// threw partway through.
import crypto from "node:crypto";
import { getDb } from "../../platform/database.js";
import { tempDirFor, cleanupTempDir } from "../../platform/db.js";
import { logger } from "../../platform/logger.js";
import { validateRecipe, SCHEMA_VERSION, type Recipe } from "../schema.js";
import { normalizeUrl } from "./normalize_url.js";
import { download } from "./download.js";
import { probe } from "./probe.js";
import { parseCaption } from "./parse_caption.js";
import { mediaSplit } from "./media_split.js";
import { dedupFrames } from "./dedup_frames.js";
import { ocrFrames } from "./ocr.js";
import { transcribeAudio } from "./asr.js";
import { selectEscalationFrames } from "./escalate_select.js";
import { reconcile } from "./reconcile.js";
import { mockReconcile } from "./mock_reconcile.js";
import { postprocess } from "./postprocess.js";
import { ExtractionError } from "./failures.js";
import type { JobContext } from "./types.js";

/** Lightweight per-run counters (Spec 2 §8 P2 observability). Logged once at
 * every terminal state (success or failure) so the download-failure /
 * caption-sufficient / escalation / empty-transcript signals are visible from
 * the first run, before any persisted metrics store exists. */
interface RunMetrics {
  downloadOutcome: "ok" | "failed";
  captionSufficient?: boolean;
  ocrBlockCount?: number;
  asrSegmentCount?: number;
  emptyTranscript?: boolean;
  escalationFrameCount?: number;
  resultType?: string;
  failureClass?: string;
  elapsedMs?: number;
}

function isVideoFile(p: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(p);
}
function isImageFile(p: string): boolean {
  return /\.(jpg|jpeg|png|webp)$/i.test(p);
}

/** Returns the extracted Recipe along with the id its `recipes` row was
 * persisted under — reuses the caller-supplied `jobId` as that id, so the
 * caller (matcher/cart-runner integration) never has to guess or re-derive
 * it.
 *
 * `mockReconcile: true` skips the real Claude call entirely, using a dumb
 * heuristic instead (mock_reconcile.ts) — for local dev/testing the rest of
 * the pipeline (real download, real local OCR/ASR, real Kroger calls) at
 * zero API cost. Explicit opt-in only; never silently substituted, so a
 * misconfigured "real" run fails loudly (missing ANTHROPIC_API_KEY) rather
 * than quietly producing mock data. */
export async function extract(
  url: string,
  jobId: string,
  options: { mockReconcile?: boolean } = {},
): Promise<{ recipe: Recipe; recipeId: string }> {
  const jobDir = tempDirFor(jobId);
  const ctx: JobContext = { jobId, jobDir, sourceUrl: url };
  const startedAt = Date.now();
  const metrics: RunMetrics = { downloadOutcome: "failed" };

  try {
    const normalized = normalizeUrl(url);
    logger.info("extract: starting", { jobId, url, videoId: normalized.videoId });

    const downloadResult = await download(ctx);
    metrics.downloadOutcome = "ok";
    const videoPath = downloadResult.mediaFiles.find(isVideoFile) ?? null;
    const imagePaths = downloadResult.mediaFiles.filter(isImageFile);
    const caption = downloadResult.info?.description ?? null;

    const infoDuration = downloadResult.info?.duration ?? null;
    const probeResult = videoPath
      ? await probe(videoPath, infoDuration)
      : { durationS: infoDuration ?? null, hasAudio: false, hasVideo: false, isPhotoMode: true };

    const captionCheck = parseCaption(caption);
    const extractFrames = !captionCheck.captionSufficient;
    metrics.captionSufficient = captionCheck.captionSufficient;

    logger.info("extract: caption gate", {
      jobId,
      captionSufficient: captionCheck.captionSufficient,
      isPhotoMode: probeResult.isPhotoMode,
    });

    const splitResult = await mediaSplit({
      jobDir,
      videoPath,
      imagePaths,
      hasAudio: probeResult.hasAudio,
      extractFrames,
    });

    const dedupedFramePaths = extractFrames ? await dedupFrames(splitResult.rawFramePaths) : [];

    const [asrSegments, ocrBlocks] = await Promise.all([
      transcribeAudio(splitResult.audioPath),
      extractFrames ? ocrFrames(dedupedFramePaths) : Promise.resolve([]),
    ]);

    const escalationFramePaths = selectEscalationFrames(ocrBlocks);
    metrics.ocrBlockCount = ocrBlocks.length;
    metrics.asrSegmentCount = asrSegments.length;
    metrics.emptyTranscript = asrSegments.length === 0;
    metrics.escalationFrameCount = escalationFramePaths.length;

    logger.info("extract: reconciling", {
      jobId,
      asrSegmentCount: asrSegments.length,
      ocrBlockCount: ocrBlocks.length,
      escalationFrameCount: escalationFramePaths.length,
      mockReconcile: options.mockReconcile ?? false,
    });

    const reconcileInput = {
      sourceUrl: url,
      caption,
      asrSegments,
      ocrBlocks,
      escalationFramePaths,
    };
    const reconciled = options.mockReconcile
      ? mockReconcile(reconcileInput)
      : await reconcile(reconcileInput);

    const recipe = postprocess(reconciled);
    metrics.resultType = recipe.result_type;

    await persist(recipe, jobId);
    logger.info("extract: complete", { jobId, resultType: recipe.result_type });

    return { recipe, recipeId: jobId };
  } catch (err) {
    // A classified terminal failure (Spec 2 §3) gets a durable `recipes` row
    // (status='failed' + class/reason) so the failure is recorded, not just
    // thrown into the void — then rethrown for the CLI to render a failure
    // card. Unclassified errors (bugs, env issues) are rethrown untouched.
    if (err instanceof ExtractionError) {
      metrics.failureClass = err.failureClass;
      await persistFailure(jobId, url, err);
      logger.warn("extract: failed", {
        jobId,
        failureClass: err.failureClass,
        reason: err.userFacingReason,
      });
    }
    throw err;
  } finally {
    metrics.elapsedMs = Date.now() - startedAt;
    logger.info("extract: metrics", { jobId, ...metrics });
    cleanupTempDir(jobId);
  }
}

/** Record a terminal extraction failure as a `recipes` row (status='failed').
 * recipe_json is a small marker (the table requires it NOT NULL and there is
 * no recipe to store); the actionable data is in failure_class/failure_reason.
 *
 * UPSERT on id (Spec 4 §2.2/§2.3): a job's `extracting_recipe` stage is
 * requeueable after a crashed worker (platform/jobs.ts REQUEUEABLE_STATES),
 * and a retry reuses the same jobId/recipeId — a plain INSERT would collide
 * on the `recipes` PK on a second attempt. Live-caught via a real
 * crash-recovery test: a job retried after a stale-lock requeue hit a
 * unique-constraint violation here instead of completing. */
async function persistFailure(
  recipeId: string,
  sourceUrl: string,
  err: ExtractionError,
): Promise<void> {
  try {
    const values = {
      id: recipeId,
      source_url: sourceUrl,
      extraction_version: SCHEMA_VERSION,
      title: null,
      status: "failed" as const,
      recipe_json: JSON.stringify({ failed: true, failure_class: err.failureClass }),
      failure_class: err.failureClass,
      failure_reason: err.userFacingReason,
    };
    await getDb()
      .insertInto("recipes")
      .values(values)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          status: values.status,
          recipe_json: values.recipe_json,
          failure_class: values.failure_class,
          failure_reason: values.failure_reason,
          updated_at: new Date(),
        }),
      )
      .execute();
  } catch (persistErr) {
    // Persisting the failure must never mask the original failure.
    logger.error("extract: could not persist failure row", {
      recipeId,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
  }
}

/** Persists the recipe + its ingredient rows. UPSERT on `recipes.id` and
 * REPLACE (delete-then-insert) the ingredient set, all in one transaction —
 * same idempotency reasoning as persistFailure(): `extracting_recipe` is a
 * requeueable stage (platform/jobs.ts), so a retry re-runs this with the
 * SAME recipeId. A plain INSERT would collide on the recipes PK; a plain
 * ingredients INSERT would silently DOUBLE the ingredient set (fresh random
 * UUIDs each call, so no PK conflict to catch it) — both live-caught via a
 * real crash-recovery test. Deleting first lets ON DELETE CASCADE clean up
 * any product_matches from a prior partial attempt for the old ingredient
 * ids, so the next matching_products run starts clean. */
async function persist(recipe: Recipe, recipeId: string): Promise<void> {
  // Re-validate at the persistence boundary too — cheap, and guarantees
  // nothing between here and the DB write silently produced an
  // out-of-contract object.
  const validated = validateRecipe(recipe);
  const title = validated.title?.value ?? null;
  const recipeJson = JSON.stringify(validated);

  await getDb()
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto("recipes")
        .values({
          id: recipeId,
          source_url: validated.source_url,
          extraction_version: validated.extraction_version,
          title,
          status: "extracted",
          recipe_json: recipeJson,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            source_url: validated.source_url,
            extraction_version: validated.extraction_version,
            title,
            status: "extracted",
            recipe_json: recipeJson,
            failure_class: null,
            failure_reason: null,
            updated_at: new Date(),
          }),
        )
        .execute();

      // Ingredient rows are persisted here (moved out of cli.ts) so BOTH the
      // CLI and the Phase 3 worker get ingredients populated automatically
      // after an extraction — the matcher reads these rows. Mapping
      // preserved verbatim from the old cli.ts `ingredientsTableRows`.
      await trx.deleteFrom("ingredients").where("recipe_id", "=", recipeId).execute();
      const ingredientRows = validated.ingredients.map((ing) => ({
        id: crypto.randomUUID(),
        recipe_id: recipeId,
        canonical_name: ing.canonical_name_en.value ?? "",
        quantity_value: ing.quantity.value,
        quantity_unit: ing.quantity.unit,
        raw_text: ing.raw_text,
        is_pantry_staple: ing.is_pantry_staple ? true : false,
        evidence_json: JSON.stringify(ing.canonical_name_en.evidence ?? []),
      }));
      if (ingredientRows.length > 0) {
        await trx.insertInto("ingredients").values(ingredientRows).execute();
      }
    });
}
