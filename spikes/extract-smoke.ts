// THROWAWAY manual smoke test for the real Spec 2 download/probe/parse_caption
// stage code (src/pipeline/extract/*.ts) — not the Phase 0 spike
// (tiktok-media-spike.ts), which predates and doesn't use the real stage
// functions. Confirms the actual implementation works end-to-end against a
// real public TikTok URL, no API keys required (download/probe/caption-gate
// only — doesn't touch Claude/Vision/Whisper).
//
// Usage: npx tsx spikes/extract-smoke.ts [url]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { download } from "../src/pipeline/extract/download.js";
import { probe } from "../src/pipeline/extract/probe.js";
import { parseCaption } from "../src/pipeline/extract/parse_caption.js";
import { normalizeUrl } from "../src/pipeline/extract/normalize_url.js";

const url = process.argv[2] ?? "https://www.tiktok.com/@jalalsamfit/video/7564134038592605462";

async function main() {
  const normalized = normalizeUrl(url);
  console.log("normalizeUrl:", normalized);

  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-smoke-"));
  console.log("jobDir:", jobDir);

  const downloadResult = await download({ jobId: "smoke", jobDir, sourceUrl: url });
  console.log("download result:", {
    mediaFiles: downloadResult.mediaFiles,
    hasInfo: downloadResult.info !== null,
    duration: downloadResult.info?.duration,
  });

  const videoPath = downloadResult.mediaFiles.find((f) => /\.(mp4|webm|mov)$/i.test(f));
  if (videoPath) {
    const probeResult = await probe(videoPath, downloadResult.info?.duration ?? null);
    console.log("probe result:", probeResult);
  } else {
    console.log("no video file found (photo-mode?) — skipping probe");
  }

  const caption = downloadResult.info?.description ?? null;
  const captionCheck = parseCaption(caption);
  console.log("caption:", caption);
  console.log("parseCaption result:", captionCheck);

  fs.rmSync(jobDir, { recursive: true, force: true });
  console.log("cleaned up jobDir");
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
