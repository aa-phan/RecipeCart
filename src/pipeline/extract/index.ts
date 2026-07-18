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
import { getDb, tempDirFor, cleanupTempDir } from "../../platform/db.js";
import { logger } from "../../platform/logger.js";
import { validateRecipe, type Recipe } from "../schema.js";
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
import { postprocess } from "./postprocess.js";
import type { JobContext } from "./types.js";

function isVideoFile(p: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(p);
}
function isImageFile(p: string): boolean {
  return /\.(jpg|jpeg|png|webp)$/i.test(p);
}

/** Returns the extracted Recipe along with the id its `recipes` row was
 * persisted under — reuses the caller-supplied `jobId` as that id, so the
 * caller (matcher/cart-runner integration) never has to guess or re-derive
 * it. */
export async function extract(
  url: string,
  jobId: string,
): Promise<{ recipe: Recipe; recipeId: string }> {
  const jobDir = tempDirFor(jobId);
  const ctx: JobContext = { jobId, jobDir, sourceUrl: url };

  try {
    const normalized = normalizeUrl(url);
    logger.info("extract: starting", { jobId, url, videoId: normalized.videoId });

    const downloadResult = await download(ctx);
    const videoPath = downloadResult.mediaFiles.find(isVideoFile) ?? null;
    const imagePaths = downloadResult.mediaFiles.filter(isImageFile);
    const caption = downloadResult.info?.description ?? null;

    const infoDuration = downloadResult.info?.duration ?? null;
    const probeResult = videoPath
      ? await probe(videoPath, infoDuration)
      : { durationS: infoDuration ?? null, hasAudio: false, hasVideo: false, isPhotoMode: true };

    const captionCheck = parseCaption(caption);
    const extractFrames = !captionCheck.captionSufficient;

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

    logger.info("extract: reconciling", {
      jobId,
      asrSegmentCount: asrSegments.length,
      ocrBlockCount: ocrBlocks.length,
      escalationFrameCount: escalationFramePaths.length,
    });

    const reconciled = await reconcile({
      sourceUrl: url,
      caption,
      asrSegments,
      ocrBlocks,
      escalationFramePaths,
    });

    const recipe = postprocess(reconciled);

    persist(recipe, jobId);
    logger.info("extract: complete", { jobId, resultType: recipe.result_type });

    return { recipe, recipeId: jobId };
  } finally {
    cleanupTempDir(jobId);
  }
}

function persist(recipe: Recipe, recipeId: string): void {
  // Re-validate at the persistence boundary too — cheap, and guarantees
  // nothing between here and the DB write silently produced an
  // out-of-contract object.
  const validated = validateRecipe(recipe);
  const db = getDb();
  const id = recipeId;
  const title = validated.title?.value ?? null;

  db.prepare(
    `INSERT INTO recipes (id, source_url, extraction_version, title, status, recipe_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    validated.source_url,
    validated.extraction_version,
    title,
    "extracted",
    JSON.stringify(validated),
  );
}
