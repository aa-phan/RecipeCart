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
import { parseCaption } from "../src/pipeline/extract/parse_caption.js";

const execFileAsync = promisify(execFile);

// Real URLs confirmed during the Phase 0 spike run (see files/spike-notes.md for
// full findings). Kept here, labeled, so the spike can be re-run against the same
// known-good/known-bad cases later (e.g. after a yt-dlp upgrade, to see if the
// photo-mode gap has been fixed upstream).
const TEST_URLS: string[] = [
  // Standard video, caption HAS a full ingredient list -> captionSufficient: true.
  // Confirms B2-1 (standard download/audio/frame extraction) and the positive path
  // of the Spec 2 §2.3a caption-sufficiency gate.
  "https://www.tiktok.com/@jalalsamfit/video/7564134038592605462",

  // Short link (tiktok.com/t/... form) for the beef-bulgogi video below. Confirms
  // yt-dlp's short-link redirect resolution (B2-1).
  "https://www.tiktok.com/t/ZTSKEBAMy/",

  // Same beef-bulgogi video, fully-expanded URL. Caption has NO ingredient list
  // (recipe is only in the video itself) -> captionSufficient: false. Confirms the
  // negative path of the caption-sufficiency gate, and that the short-link and
  // expanded-link forms of the same video behave identically.
  "https://www.tiktok.com/@shreddedandfed/video/7650230773512965393?q=meal%20prep%20recipe&t=1784319852681",

  // Photo-mode/slideshow post; recipe is only in the slide images, caption has no
  // ingredient list. CONFIRMED FAILING as of yt-dlp 2026.07.04: the /photo/<id> URL
  // pattern isn't recognized at all (falls back to the generic extractor and
  // errors). Kept here specifically to re-check after future yt-dlp upgrades —
  // see files/spike-notes.md "B2-2" for the full writeup and workaround attempts.
  "https://www.tiktok.com/@success.fitness/photo/7547822272153799954?q=meal%20prep%20recipe&t=1784319852681",
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
  caption?: string;
  captionSufficient?: boolean;
  captionMatchedLines?: string[];
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

      // Spec 2 §2.3a: check the caption-sufficiency gate against the real
      // caption yt-dlp pulled down, using the actual parse_caption module —
      // gives a first real signal on the A2-7 threshold.
      const caption: string | undefined = info.description ?? info.caption;
      result.caption = caption;
      if (caption) {
        const captionCheck = parseCaption(caption);
        result.captionSufficient = captionCheck.captionSufficient;
        result.captionMatchedLines = captionCheck.matchedLines.map((m) => m.text);
      }
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
      captionSufficient: r.captionSufficient ?? "?",
      error: r.error ?? "",
    })),
  );
  for (const r of results) {
    if (r.caption) {
      console.log(`\n--- caption for ${r.url} ---`);
      console.log(r.caption);
      console.log(
        `captionSufficient=${r.captionSufficient} matchedLines=${JSON.stringify(r.captionMatchedLines)}`,
      );
    }
  }
  console.log(
    "\nEyeball the extracted frames under spikes/tmp/job-*/frames/ for quality.\n" +
      "Write findings to files/spike-notes.md and mark B2-1/B2-2 resolved or escalated.",
  );
}

main();
