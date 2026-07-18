// probe stage (Spec 2 §2.1). ffprobe over the downloaded media: duration,
// audio track presence, and the photo-mode signal. Per prior investigation
// (spikes/tiktok-media-spike.ts, files/spike-notes.md B2-2): photo-mode
// slideshow posts have duration 0/absent in yt-dlp's info.json and (when
// ffprobe can even open the file — it may be a plain image, not a container
// ffprobe recognizes as having streams at all) no video stream either.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../platform/logger.js";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationS: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  isPhotoMode: boolean;
}

/** @param infoDuration the `duration` field from yt-dlp's info.json, when
 * available — the primary photo-mode signal per prior investigation.
 * ffprobe's own stream inspection is used to fill in hasAudio/hasVideo and
 * as a fallback duration source. */
export async function probe(
  mediaPath: string,
  infoDuration: number | null | undefined,
): Promise<ProbeResult> {
  const infoSignalsPhotoMode = !infoDuration || infoDuration === 0;

  let streamTypes: string[] = [];
  let ffprobeDuration: number | null = null;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      mediaPath,
    ]);
    streamTypes = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const { stdout: durOut } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      mediaPath,
    ]);
    const parsed = parseFloat(durOut.trim());
    ffprobeDuration = Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    // ffprobe failing to find any stream at all (e.g. a plain image file
    // with no container streams) is itself a photo-mode signal, not an
    // error — swallow and fall through to the info.json signal.
    logger.debug("ffprobe found no streams (likely a still image)", {
      mediaPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const hasVideo = streamTypes.includes("video");
  const hasAudio = streamTypes.includes("audio");
  const durationS = infoDuration ?? ffprobeDuration ?? null;
  const isPhotoMode = infoSignalsPhotoMode && !hasVideo;

  return { durationS, hasAudio, hasVideo, isPhotoMode };
}
