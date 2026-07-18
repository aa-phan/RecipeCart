import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";

vi.mock("../../platform/config.js", () => ({
  config: {
    extraction: {
      chromeRegions: {
        rightEdgeColumn: { xMin: 0.82, xMax: 1.0, yMin: 0.0, yMax: 1.0 },
        bottomCaptionBand: { xMin: 0.0, xMax: 1.0, yMin: 0.78, yMax: 1.0 },
      },
    },
  },
}));

const PROMISIFY_CUSTOM = (promisify as unknown as { custom: symbol }).custom;
const execFileMock = vi.fn();
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [PROMISIFY_CUSTOM]: execFileMock });
  return { execFile };
});

const recognizeMock = vi.fn();
const terminateMock = vi.fn();
const createWorkerMock = vi.fn().mockResolvedValue({
  recognize: recognizeMock,
  terminate: terminateMock,
});
vi.mock("tesseract.js", () => ({
  createWorker: createWorkerMock,
}));

const { ocrFrame, ocrFrames, shutdownOcr } = await import("./ocr.js");

/** Builds a fake tesseract.js recognize() result with the real nested
 * blocks -> paragraphs -> lines -> words shape (not the flat `data.words`
 * shape older mocks assumed — that field doesn't exist on this version's
 * Page type at all). */
function fakePage(
  words: { text: string; confidence: number; bbox: [number, number, number, number] }[],
) {
  return {
    data: {
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  words: words.map((w) => ({
                    text: w.text,
                    confidence: w.confidence,
                    bbox: { x0: w.bbox[0], y0: w.bbox[1], x1: w.bbox[2], y1: w.bbox[3] },
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockResolvedValue({ stdout: "1000x1000", stderr: "" }); // 1000x1000 image
  recognizeMock.mockReset();
  createWorkerMock.mockClear();
  terminateMock.mockReset();
});

// The worker is a module-level singleton (by design — reused across frames
// within one extraction job). Reset it after every test so call-count
// assertions (createWorkerMock/terminateMock) aren't polluted by whichever
// test ran before — ocrFrame() alone (unlike ocrFrames()) never tears the
// worker down on its own.
afterEach(async () => {
  await shutdownOcr();
});

describe("ocrFrame", () => {
  it("flattens nested blocks/paragraphs/lines to word-level blocks, tags content", async () => {
    recognizeMock.mockResolvedValue(
      fakePage([{ text: "2 cups flour", confidence: 95, bbox: [100, 100, 400, 200] }]),
    );

    const blocks = await ocrFrame("/tmp/frame-001.jpg");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("2 cups flour");
    expect(blocks[0]?.tag).toBe("content");
    // Tesseract reports 0-100; normalized to 0-1.
    expect(blocks[0]?.confidence).toBeCloseTo(0.95);
    expect(blocks[0]?.box).toEqual({ xMin: 0.1, xMax: 0.4, yMin: 0.1, yMax: 0.2 });
  });

  it("requests blocks explicitly since they're null by default in tesseract.js", async () => {
    recognizeMock.mockResolvedValue(fakePage([]));
    await ocrFrame("/tmp/frame-001.jpg");
    expect(recognizeMock).toHaveBeenCalledWith("/tmp/frame-001.jpg", {}, { blocks: true });
  });

  it("tags a block inside a configured chrome region as chrome", async () => {
    recognizeMock.mockResolvedValue(
      fakePage([{ text: "@someuser", confidence: 80, bbox: [900, 500, 950, 550] }]),
    );

    const blocks = await ocrFrame("/tmp/frame-001.jpg");
    expect(blocks[0]?.tag).toBe("chrome");
  });

  it("skips words with empty/whitespace-only text", async () => {
    recognizeMock.mockResolvedValue(
      fakePage([{ text: "   ", confidence: 50, bbox: [0, 0, 10, 10] }]),
    );
    const blocks = await ocrFrame("/tmp/frame-001.jpg");
    expect(blocks).toHaveLength(0);
  });

  it("handles a null blocks field (no text detected) without throwing", async () => {
    recognizeMock.mockResolvedValue({ data: { blocks: null } });
    const blocks = await ocrFrame("/tmp/frame-001.jpg");
    expect(blocks).toEqual([]);
  });
});

describe("ocrFrames", () => {
  it("continues past a frame that throws and returns blocks from the rest", async () => {
    recognizeMock
      .mockRejectedValueOnce(new Error("Vision API error"))
      .mockResolvedValueOnce(
        fakePage([{ text: "1 tsp salt", confidence: 90, bbox: [10, 10, 100, 50] }]),
      );

    const blocks = await ocrFrames(["/tmp/bad.jpg", "/tmp/good.jpg"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("1 tsp salt");
  });

  it("terminates the worker after processing the batch", async () => {
    recognizeMock.mockResolvedValue(fakePage([]));
    await ocrFrames(["/tmp/frame-001.jpg"]);
    expect(terminateMock).toHaveBeenCalledOnce();
  });

  it("reuses one worker across multiple frames instead of creating one per frame", async () => {
    recognizeMock.mockResolvedValue(fakePage([]));
    await ocrFrames(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    expect(createWorkerMock).toHaveBeenCalledOnce();
  });
});

describe("shutdownOcr", () => {
  it("is a no-op when no worker was ever created", async () => {
    await expect(shutdownOcr()).resolves.toBeUndefined();
    expect(terminateMock).not.toHaveBeenCalled();
  });
});
