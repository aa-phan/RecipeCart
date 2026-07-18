// ocr stage (Spec 2 §2.3b). Tesseract.js (pure JS/WASM, runs fully locally —
// no cloud AI call) TEXT_DETECTION per frame, in line with the project's
// online-AI-usage constraint: Claude is the only cloud AI dependency, OCR
// runs on-device via Tesseract's local OCR engine.
// Text blocks whose bounding box falls inside config.extraction.chromeRegions
// (TikTok's UI chrome — like counter, username, caption band) are tagged
// "chrome", NOT deleted: they're still legitimate evidence (a caption can be
// burned into the chrome band), just down-weighted downstream in
// escalate_select's scoring.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorker, type Worker } from "tesseract.js";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";

const execFileAsync = promisify(execFile);

export interface OcrBlock {
  text: string;
  frame_ref: string;
  confidence?: number;
  /** Bounding box as fractions of frame width/height, matching the units
   * config.extraction.chromeRegions is expressed in. */
  box: { xMin: number; xMax: number; yMin: number; yMax: number };
  tag: "content" | "chrome";
}

let workerPromise: Promise<Worker> | undefined;
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }
  return workerPromise;
}

/** Release the Tesseract worker. Called at the end of ocrFrames() — this is
 * a short-lived CLI process, so it doesn't strictly matter, but it keeps
 * behavior clean for a future long-lived (P3 worker) caller. */
export async function shutdownOcr(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = undefined;
  }
}

async function getImageDimensions(framePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    framePath,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h) {
    throw new Error(`ocr: could not determine dimensions of ${framePath}`);
  }
  return { width: w, height: h };
}

function isInsideChromeRegion(box: OcrBlock["box"]): boolean {
  const centerX = (box.xMin + box.xMax) / 2;
  const centerY = (box.yMin + box.yMax) / 2;
  return Object.values(config.extraction.chromeRegions).some(
    (region) =>
      centerX >= region.xMin &&
      centerX <= region.xMax &&
      centerY >= region.yMin &&
      centerY <= region.yMax,
  );
}

/** Run OCR on one frame, returning individual word-level blocks. Words are
 * nested `Page.blocks[].paragraphs[].lines[].words[]` in tesseract.js's
 * output — `blocks` is `null` unless explicitly requested via the third
 * `recognize()` argument, which is why that's passed here. */
export async function ocrFrame(framePath: string): Promise<OcrBlock[]> {
  const { width, height } = await getImageDimensions(framePath);
  const worker = await getWorker();
  const { data } = await worker.recognize(framePath, {}, { blocks: true });

  const words = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
  );
  return words.flatMap((word): OcrBlock[] => {
    const text = word.text ?? "";
    if (!text.trim()) return [];

    const box = {
      xMin: word.bbox.x0 / width,
      xMax: word.bbox.x1 / width,
      yMin: word.bbox.y0 / height,
      yMax: word.bbox.y1 / height,
    };

    return [
      {
        text,
        frame_ref: framePath,
        // Tesseract reports confidence 0-100; normalize to 0-1 to match the
        // rest of the pipeline's evidence-confidence convention.
        confidence: typeof word.confidence === "number" ? word.confidence / 100 : undefined,
        box,
        tag: isInsideChromeRegion(box) ? "chrome" : "content",
      },
    ];
  });
}

/** Run OCR across all frames. Frames are processed sequentially — P1 scope
 * caps this at maxRawFrames (40) which is fine serially; parallelize later
 * if local OCR latency makes it worth it. */
export async function ocrFrames(framePaths: string[]): Promise<OcrBlock[]> {
  const allBlocks: OcrBlock[] = [];
  for (const framePath of framePaths) {
    try {
      const blocks = await ocrFrame(framePath);
      allBlocks.push(...blocks);
    } catch (err) {
      // One bad frame shouldn't kill the whole job — log and move on;
      // reconcile just gets less OCR evidence for that frame.
      logger.warn("ocr: failed on frame, skipping", {
        framePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await shutdownOcr();
  return allBlocks;
}
