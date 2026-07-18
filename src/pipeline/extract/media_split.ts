// media_split stage (Spec 2 §2.1). Splits the downloaded media into the
// per-modality inputs the rest of the pipeline needs: a 16kHz mono WAV for
// ASR, and (only when the caption-sufficiency gate says frames are needed)
// raw frames at a fixed interval, resized in the same ffmpeg pass via
// resize_frames.ts's shared scale filter. Photo-mode posts have no video
// stream to extract frames from — their "frames" are just the downloaded
// images, resized separately by resize_frames.resizeFrames().
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";
import { buildScaleFilter, resizeFrames } from "./resize_frames.js";

const execFileAsync = promisify(execFile);

export interface MediaSplitInput {
  jobDir: string;
  /** Path to the downloaded video file, or null for a photo-mode post with
   * no video stream. */
  videoPath: string | null;
  /** Downloaded slideshow image paths, for photo-mode posts. Empty for
   * normal video posts. */
  imagePaths: string[];
  hasAudio: boolean;
  /** Whether the caption-sufficiency gate says we need frames/OCR at all. */
  extractFrames: boolean;
}

export interface MediaSplitResult {
  /** null when there's no audio to extract (photo-mode, or a video with no
   * audio track) — asr treats that as a normal empty-transcript case. */
  audioPath: string | null;
  /** Raw (pre-dedup) frame paths, already resized to
   * config.extraction.resizeLongEdgePx. Empty when extractFrames is false. */
  rawFramePaths: string[];
}

export async function mediaSplit(input: MediaSplitInput): Promise<MediaSplitResult> {
  const { jobDir, videoPath, imagePaths, hasAudio, extractFrames } = input;

  let audioPath: string | null = null;
  if (videoPath && hasAudio) {
    const outPath = path.join(jobDir, "audio.wav");
    await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", outPath]);
    audioPath = outPath;
  }

  if (!extractFrames) {
    logger.info("media_split: caption sufficient, skipping frame extraction", { jobDir });
    return { audioPath, rawFramePaths: [] };
  }

  if (videoPath) {
    const framesDir = path.join(jobDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const scaleFilter = buildScaleFilter(config.extraction.resizeLongEdgePx);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=1/${config.extraction.frameIntervalS},${scaleFilter}`,
      "-frames:v",
      String(config.extraction.maxRawFrames),
      path.join(framesDir, "frame-%03d.jpg"),
    ]);
    const rawFramePaths = fs
      .readdirSync(framesDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => path.join(framesDir, f));
    return { audioPath, rawFramePaths };
  }

  // Photo-mode: the downloaded images ARE the frames, just resized.
  const framesDir = path.join(jobDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const rawFramePaths = await resizeFrames(
    imagePaths.slice(0, config.extraction.maxRawFrames),
    framesDir,
    config.extraction.resizeLongEdgePx,
  );
  return { audioPath, rawFramePaths };
}
