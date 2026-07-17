// THROWAWAY SPIKE — Phase 0, Spike A (resolves blockers B2-1, B2-2).
// Not durable code: answers "does yt-dlp + ffmpeg work against real TikToks
// right now" and gets discarded once Phase 1's real `download`/`media_split`
// stages exist. Findings go in files/spike-notes.md.
//
// Usage: npm run spike:tiktok -- <url1> <url2> ...
// If no URLs are given, edit TEST_URLS below with ~5 real public TikTok
// recipe URLs, including one vm.tiktok.com short link and one photo-mode
// (slideshow) post, per the Phase 0 spec.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const TEST_URLS: string[] = [
  // Fill in ~5 real public TikTok recipe URLs before running, e.g.:
  // "https://www.tiktok.com/@someuser/video/1234567890123456789",
  // "https://vm.tiktok.com/ZMabcdefg/",              // short link case
  // "https://www.tiktok.com/@someuser/photo/1234567890123456789", // photo-mode case
];

const OUT_DIR = path.resolve("spikes/tmp");

interface SpikeResult {
  url: string;
  ok: boolean;
  ytDlpVersion?: string;
  isPhotoMode?: boolean;
  durationS?: number;
  hasAudio?: boolean;
  frameCount?: number;
  error?: string;
}

async function runOne(url: string, index: number): Promise<SpikeResult> {
  const jobDir = path.join(OUT_DIR, `job-${index}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const result: SpikeResult = { url, ok: false };

  try {
    const { stdout: version } = await execFileAsync("yt-dlp", ["--version"]);
    result.ytDlpVersion = version.trim();

    // Download. yt-dlp handles vm.tiktok.com redirects itself; if this
    // fails for the short-link case specifically, that's a Spike A finding.
    await execFileAsync(
      "yt-dlp",
      ["-o", path.join(jobDir, "media.%(ext)s"), "--write-info-json", "--no-playlist", url],
      { timeout: 180_000 },
    );

    const files = fs.readdirSync(jobDir);
    const infoFile = files.find((f) => f.endsWith(".info.json"));
    const mediaFiles = files.filter((f) => !f.endsWith(".info.json"));

    if (infoFile) {
      const info = JSON.parse(fs.readFileSync(path.join(jobDir, infoFile), "utf-8"));
      result.durationS = info.duration ?? null;
      // Photo-mode posts typically show up as a slideshow with no video
      // stream / duration, or as an image-only format list.
      result.isPhotoMode = !info.duration || info.duration === 0;
    }

    const videoFile = mediaFiles.find((f) => /\.(mp4|webm|mov)$/i.test(f));
    if (videoFile) {
      const videoPath = path.join(jobDir, videoFile);

      // ffprobe: duration + audio track presence
      const { stdout: probeOut } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        videoPath,
      ]);
      result.hasAudio = probeOut.includes("audio");

      // Extract audio (16kHz mono, matches Spec 2 media_split target)
      const audioPath = path.join(jobDir, "audio.wav");
      await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", audioPath]);

      // Extract frames at 2s interval as the simple P1 fallback (no
      // scene-change detection in this throwaway spike), resized to ~1000px
      // long edge, so we can eyeball quality.
      const framesDir = path.join(jobDir, "frames");
      fs.mkdirSync(framesDir, { recursive: true });
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        videoPath,
        "-vf",
        "fps=1/2,scale='if(gt(iw,ih),1000,-1)':'if(gt(iw,ih),-1,1000)'",
        path.join(framesDir, "frame-%03d.jpg"),
      ]);
      result.frameCount = fs.readdirSync(framesDir).length;
    } else {
      // Photo-mode: yt-dlp should have grabbed images instead of a video.
      const imageFiles = mediaFiles.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
      result.frameCount = imageFiles.length;
    }

    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

async function main() {
  const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : TEST_URLS;
  if (urls.length === 0) {
    console.error(
      "No URLs given. Pass them as CLI args or fill in TEST_URLS in this file.\n" +
        "Need ~5 real public TikTok recipe URLs incl. a vm.tiktok.com short link and a photo-mode post.",
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results: SpikeResult[] = [];
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`);
    const r = await runOne(urls[i]!, i);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }

  console.log("\n=== Spike A summary ===");
  console.table(
    results.map((r) => ({
      url: r.url,
      ok: r.ok,
      photoMode: r.isPhotoMode ?? "?",
      hasAudio: r.hasAudio ?? "?",
      frames: r.frameCount ?? "?",
      error: r.error ?? "",
    })),
  );
  console.log(
    "\nEyeball the extracted frames under spikes/tmp/job-*/frames/ for quality.\n" +
      "Write findings to files/spike-notes.md and mark B2-1/B2-2 resolved or escalated.",
  );
}

main();
