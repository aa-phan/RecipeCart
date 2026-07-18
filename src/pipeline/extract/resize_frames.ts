// resize_frames stage (Spec 2 §2.1). For frames extracted from a video,
// media_split does the resize in the same ffmpeg pass as extraction (see
// buildScaleFilter below, shared so the two stages don't drift). This file's
// standalone resizeFrames() is for the other case: photo-mode/slideshow
// posts, where yt-dlp hands us already-full-size images directly (no ffmpeg
// extraction pass happens for those), so they need an explicit resize pass
// of their own before OCR.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** ffmpeg scale filter that resizes the long edge to `longEdgePx`, preserving
 * aspect ratio, without upscaling images already smaller than that. Shared
 * between media_split's frame-extraction pass and resizeFrames() below so
 * both stages produce frames at the exact same target size. */
export function buildScaleFilter(longEdgePx: number): string {
  return `scale='if(gt(iw,ih),min(iw,${longEdgePx}),-2)':'if(gt(iw,ih),-2,min(ih,${longEdgePx}))'`;
}

/** Resize a list of already-extracted image files in place into `outDir`,
 * long edge = longEdgePx. Returns the resized file paths, same order as
 * input. */
export async function resizeFrames(
  framePaths: string[],
  outDir: string,
  longEdgePx: number,
): Promise<string[]> {
  const scaleFilter = buildScaleFilter(longEdgePx);
  const out: string[] = [];
  for (const [i, framePath] of framePaths.entries()) {
    const outPath = path.join(outDir, `resized-${String(i).padStart(3, "0")}.jpg`);
    await execFileAsync("ffmpeg", ["-y", "-i", framePath, "-vf", scaleFilter, outPath]);
    out.push(outPath);
  }
  return out;
}
