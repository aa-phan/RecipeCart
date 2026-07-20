import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDb } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";

// Full orchestrator test: every stage is mocked so this exercises only the
// wiring/branching in index.ts (caption-gate branch selection, cleanup
// always running, persistence happening) — not the stages' own logic, which
// each have their own unit tests. Persistence itself goes through real
// Postgres (resetDb()) so the recipes/ingredients inserts are genuinely
// exercised; only the filesystem temp-dir helpers (still in db.js) are
// mocked.
const tempDirForMock = vi.fn(() => "/tmp/job-dir");
const cleanupTempDirMock = vi.fn();
vi.mock("../../platform/db.js", () => ({
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

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  tempDirForMock.mockReturnValue("/tmp/job-dir");
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
    // ASR gated by the same caption-sufficiency check as OCR (2026-07-20):
    // narration's only roles are unused `steps` extraction and a secondary
    // ingredient-disambiguation signal, not worth the OOM risk (see the
    // recipecart-worker-asr-oom memory) on a path that already has enough
    // ingredient evidence from the caption alone.
    expect(transcribeAudioMock).not.toHaveBeenCalled();
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ ocrBlocks: [], escalationFramePaths: [], asrSegments: [] }),
    );
    expect(result.recipe.result_type).toBe("recipe");
    expect(result.recipeId).toBe("job-1");
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-1");

    // persist() wrote real recipes + ingredients rows.
    const recipeRow = await getDb()
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", "job-1")
      .executeTakeFirstOrThrow();
    expect(recipeRow.status).toBe("extracted");
    expect((recipeRow.recipe_json as { title?: { value?: string } }).title?.value).toBe(
      "Chicken thighs",
    );

    const ingredientRows = await getDb()
      .selectFrom("ingredients")
      .selectAll()
      .where("recipe_id", "=", "job-1")
      .execute();
    expect(ingredientRows).toHaveLength(1);
    expect(ingredientRows[0]!.canonical_name).toBe("flour");
    expect(ingredientRows[0]!.is_pantry_staple).toBe(false);
  });

  // Live-caught bug (2026-07-19, real crash-recovery test): the worker's
  // requeueable stages (platform/jobs.ts REQUEUEABLE_STATES) include
  // extracting_recipe — a crashed-then-requeued job retries extract() with the
  // SAME jobId/recipeId. persist() used to do a plain INSERT, which collided
  // on the recipes PK on retry; ingredients used fresh random UUIDs each call,
  // so a retry silently DOUBLED the ingredient set instead of erroring.
  // persist() must be safe to call twice with the same recipeId.
  it("persist() is idempotent under a same-recipeId retry (crash-recovery scenario)", async () => {
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

    await extract(SOURCE_URL, "job-retry");
    // Same jobId again — simulates the worker retrying after a stale-lock
    // requeue, not a fresh extraction.
    await expect(extract(SOURCE_URL, "job-retry")).resolves.not.toThrow();

    const recipeRows = await getDb()
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", "job-retry")
      .execute();
    expect(recipeRows).toHaveLength(1); // upserted, not duplicated

    const ingredientRows = await getDb()
      .selectFrom("ingredients")
      .selectAll()
      .where("recipe_id", "=", "job-retry")
      .execute();
    expect(ingredientRows).toHaveLength(1); // replaced, not doubled to 2
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
    expect(transcribeAudioMock).toHaveBeenCalledWith("/tmp/job-dir/audio.wav");
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ escalationFramePaths: ["/tmp/job-dir/frames/frame-001.jpg"] }),
    );
  });

  it("still calls cleanupTempDir when a stage throws", async () => {
    downloadMock.mockRejectedValue(new Error("yt-dlp exploded"));

    await expect(extract(SOURCE_URL, "job-3")).rejects.toThrow("yt-dlp exploded");
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-3");
    // A plain Error (not ExtractionError) doesn't call persistFailure — no row.
    const rows = await getDb()
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", "job-3")
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("throws before downloading anything on an invalid URL, but still cleans up the temp dir", async () => {
    await expect(extract("https://www.youtube.com/watch?v=abc", "job-4")).rejects.toThrow();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(cleanupTempDirMock).toHaveBeenCalledWith("job-4");
  });
});
