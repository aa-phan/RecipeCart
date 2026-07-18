// download stage (Spec 2 §2.1). Shells out to yt-dlp on PATH — deliberately
// doesn't assume a pinned version, just that it's installed. Two timeouts,
// tracked separately per spec: kill if yt-dlp produces no output at all
// within downloadStartTimeoutMs (looks hung / network stalled before it even
// starts), and kill unconditionally if the whole run exceeds
// downloadTotalTimeoutMs (slow but "working" is still a failure at some point).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";
import type { JobContext } from "./types.js";

export class DownloadTimeoutError extends Error {}
export class DownloadFailedError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "DownloadFailedError";
  }
}

/** Subset of yt-dlp's --write-info-json output this pipeline actually uses.
 * The real file has many more fields; we only type what we read. */
export interface TikTokInfoJson {
  id?: string;
  description?: string;
  duration?: number | null;
  uploader?: string;
  creator?: string;
  [key: string]: unknown;
}

export interface DownloadResult {
  /** All non-info files yt-dlp wrote (a video, or one-or-more images for
   * photo-mode posts). */
  mediaFiles: string[];
  infoJsonPath: string | null;
  info: TikTokInfoJson | null;
}

/** Run yt-dlp against `url`, writing media + --write-info-json into
 * ctx.jobDir. Caller owns creating/cleaning up jobDir (tempDirFor/
 * cleanupTempDir in db.ts). */
export async function download(ctx: JobContext): Promise<DownloadResult> {
  const outTemplate = path.join(ctx.jobDir, "media.%(ext)s");

  await runYtDlp(["-o", outTemplate, "--write-info-json", "--no-playlist", ctx.sourceUrl]);

  const files = fs.readdirSync(ctx.jobDir);
  const infoFile = files.find((f) => f.endsWith(".info.json"));
  const mediaFiles = files
    .filter((f) => f !== infoFile)
    .map((f) => path.join(ctx.jobDir, f))
    .sort();

  let info: TikTokInfoJson | null = null;
  let infoJsonPath: string | null = null;
  if (infoFile) {
    infoJsonPath = path.join(ctx.jobDir, infoFile);
    info = JSON.parse(fs.readFileSync(infoJsonPath, "utf-8")) as TikTokInfoJson;
  }

  logger.info("download complete", {
    jobId: ctx.jobId,
    mediaFileCount: mediaFiles.length,
    hasInfoJson: infoFile !== undefined,
  });

  return { mediaFiles, infoJsonPath, info };
}

function runYtDlp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args);
    let stderr = "";
    let stdout = "";
    let settled = false;

    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new DownloadTimeoutError(
          `yt-dlp produced no output within ${config.extraction.downloadStartTimeoutMs}ms`,
        ),
      );
    }, config.extraction.downloadStartTimeoutMs);

    const totalTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new DownloadTimeoutError(
          `yt-dlp exceeded total timeout of ${config.extraction.downloadTotalTimeoutMs}ms`,
        ),
      );
    }, config.extraction.downloadTotalTimeoutMs);

    const clearStartTimer = () => clearTimeout(startTimer);

    child.stdout.on("data", (chunk: Buffer) => {
      clearStartTimer();
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      clearStartTimer();
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(totalTimer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(totalTimer);
      if (code === 0) {
        resolve();
      } else {
        reject(new DownloadFailedError(`yt-dlp exited with code ${code}`, stderr || stdout));
      }
    });
  });
}
