import { describe, expect, it, vi, beforeEach } from "vitest";

// Full orchestrator test: every stage is mocked so this exercises only the
// wiring/branching in index.ts (caption-gate branch selection, cleanup
// always running, persistence happening) — not the stages' own logic,
// which each have their own unit tests.

const tempDirForMock = vi.fn(() => "/tmp/job-dir");
const cleanupTempDirMock = vi.fn();
const dbRunMock = vi.fn();
const dbPrepareMock = vi.fn(() => ({ run: dbRunMock }));
const getDbMock = vi.fn(() => ({ prepare: dbPrepareMock }));
vi.mock("../../platform/db.js", () => ({
  getDb: getDbMock,
  tempDirFor: tempDirForMock,
  cleanupTempDir: cleanupTempDirMock,
}));

const downloadMock = vi.fn();
vi.mock("./download.js", () => ({ download: downloadMock }));

const probeMock = vi.fn();
vi.mock("./probe.js", () => ({ probe: probeMock }));

const mediaSplitMock = vi.fn();
vi.mock("./media_split.js", () => ({ mediaSplit: mediaSplitMock }));

const dedupFramesMock = vi.fn();
vi.mock("./dedup_frames.js", () => ({ dedupFrames: dedupFramesMock }));

const ocrFramesMock = vi.fn();
vi.mock("./ocr.js", () => ({ ocrFrames: ocrFramesMock }));

const transcribeAudioMock = vi.fn();
vi.mock("./asr.js", () => ({ transcribeAudio: transcribeAudioMock }));

const selectEscalationFramesMock = vi.fn();
vi.mock("./escalate_select.js", () => ({ selectEscalationFrames: selectEscalationFramesMock }));

const reconcileMock = vi.fn();
vi.mock("./reconcile.js", () => ({ reconcile: reconcileMock }));

const postprocessMock = vi.fn((r: unknown) => r);
vi.mock("./postprocess.js", () => ({ postprocess: postprocessMock }));

const { extract } = await import("./index.js");
const { SCHEMA_VERSION } = await import("../schema.js");

const SOURCE_URL = "https://www.tiktok.com/@someone/video/7564134038592605462";

const validatedRecipe = {
  extraction_version: SCHEMA_VERSION,
  source_url: SOURCE_URL,
  result_type: "recipe",
  title: {
    value: "Chicken thighs",
    evidence: [{ source_type: "caption" as const, snippet: "Chicken thighs" }],
  },
  ingredients: [
    {
      canonical_name_en: {
        value: "flour",
        evidence: [{ source_type: "ocr" as const, frame_ref: "f1", snippet: "2 cups flour" }],
      },
      raw_text: "2 cups flour",
      quantity: { value: 2, unit: "cup", raw_text: "2 cups" },
      is_pantry_staple: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  tempDirForMock.mockReturnValue("/tmp/job-dir");
  dbPrepareMock.mockReturnValue({ run: dbRunMock });
  getDbMock.mockReturnValue({ prepare: dbPrepareMock });
  postprocessMock.mockImplementation((r: unknown) => r);
  reconcileMock.mockResolvedValue(validatedRecipe);
  selectEscalationFramesMock.mockReturnValue([]);
});

describe("extract (orchestrator)", () => {
  it("takes the captionSufficient path: skips media_split frame extraction / dedup / ocr", async () => {
    downloadMock.mockResolvedValue({
      mediaFiles: ["/tmp/job-dir/media.mp4"],
      infoJsonPath: "/tmp/job-dir/media.info.json",
      info: {
        description: ["2 cups flour", "1 tsp salt", "3 eggs", "2 tbsp sugar"].join("\n"),
        duration: 30,
      },
    });
    probeMock.mockResolvedValue({
      durationS: 30,
      hasAudio: true,
      hasVideo: true,
      isPhotoMode: false,
    });
    mediaSplitMock.mockResolvedValue({ audioPath: "/tmp/job-dir/audio.wav", rawFramePaths: [] });
    transcribeAudioMock.mockResolvedValue([]);

    const result = await extract(SOURCE_URL, "job-1");

    expect(mediaSplitMock).toHaveBeenCalledWith(expect.objectContaining({ extractFrames: false }));
    expect(dedupFramesMock).not.toHaveBeenCalled();
    expect(ocrFramesMock).not.toHaveBeenCalled();
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ ocrBlocks: [], escalationFramePaths: [] }),
    );
    expect(result.recipe.result_type).toBe("recipe");
    expect(result.recipeId).toBe("job-1");
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-1");
    expect(dbRunMock).toHaveBeenCalled();
  });

  it("takes the OCR path when the caption is insufficient: runs dedup + ocr + escalation selection", async () => {
    downloadMock.mockResolvedValue({
      mediaFiles: ["/tmp/job-dir/media.mp4"],
      infoJsonPath: "/tmp/job-dir/media.info.json",
      info: { description: "no ingredient list here, just vibes", duration: 30 },
    });
    probeMock.mockResolvedValue({
      durationS: 30,
      hasAudio: true,
      hasVideo: true,
      isPhotoMode: false,
    });
    mediaSplitMock.mockResolvedValue({
      audioPath: "/tmp/job-dir/audio.wav",
      rawFramePaths: ["/tmp/job-dir/frames/frame-001.jpg", "/tmp/job-dir/frames/frame-002.jpg"],
    });
    dedupFramesMock.mockResolvedValue(["/tmp/job-dir/frames/frame-001.jpg"]);
    ocrFramesMock.mockResolvedValue([{ text: "2 cups flour", frame_ref: "f1", tag: "content" }]);
    selectEscalationFramesMock.mockReturnValue(["/tmp/job-dir/frames/frame-001.jpg"]);
    transcribeAudioMock.mockResolvedValue([{ text: "add flour", start: 0, end: 1 }]);

    await extract(SOURCE_URL, "job-2");

    expect(mediaSplitMock).toHaveBeenCalledWith(expect.objectContaining({ extractFrames: true }));
    expect(dedupFramesMock).toHaveBeenCalledWith([
      "/tmp/job-dir/frames/frame-001.jpg",
      "/tmp/job-dir/frames/frame-002.jpg",
    ]);
    expect(ocrFramesMock).toHaveBeenCalledWith(["/tmp/job-dir/frames/frame-001.jpg"]);
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ escalationFramePaths: ["/tmp/job-dir/frames/frame-001.jpg"] }),
    );
  });

  it("still calls cleanupTempDir when a stage throws", async () => {
    downloadMock.mockRejectedValue(new Error("yt-dlp exploded"));

    await expect(extract(SOURCE_URL, "job-3")).rejects.toThrow("yt-dlp exploded");
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-3");
    expect(dbRunMock).not.toHaveBeenCalled();
  });

  it("throws before downloading anything on an invalid URL, but still cleans up the temp dir", async () => {
    await expect(extract("https://www.youtube.com/watch?v=abc", "job-4")).rejects.toThrow();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-4");
  });
});
