import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { resizeLongEdgePx: 1024, frameIntervalS: 2, maxRawFrames: 40 } },
}));

const PROMISIFY_CUSTOM = (promisify as unknown as { custom: symbol }).custom;
const execFileMock = vi.fn();
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [PROMISIFY_CUSTOM]: execFileMock });
  return { execFile };
});

const { mediaSplit } = await import("./media_split.js");

let jobDir: string;

beforeEach(() => {
  jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-split-test-"));
  execFileMock.mockReset();
  // Default: ffmpeg "succeeds" without writing anything (audio extraction path).
  execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  fs.rmSync(jobDir, { recursive: true, force: true });
});

describe("mediaSplit", () => {
  it("extracts audio when hasAudio is true, skips frames when extractFrames is false", async () => {
    const result = await mediaSplit({
      jobDir,
      videoPath: "/tmp/video.mp4",
      imagePaths: [],
      hasAudio: true,
      extractFrames: false,
    });
    expect(result.audioPath).toBe(path.join(jobDir, "audio.wav"));
    expect(result.rawFramePaths).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1); // just the audio extraction
  });

  it("returns null audioPath when hasAudio is false", async () => {
    const result = await mediaSplit({
      jobDir,
      videoPath: "/tmp/video.mp4",
      imagePaths: [],
      hasAudio: false,
      extractFrames: false,
    });
    expect(result.audioPath).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("extracts frames from a video when extractFrames is true, reading them back from the frames dir", async () => {
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      // Simulate ffmpeg's frame-extraction pass writing frame-%03d.jpg files.
      const outPattern = args[args.length - 1] as string;
      if (outPattern.includes("frame-%03d")) {
        const dir = path.dirname(outPattern);
        fs.writeFileSync(path.join(dir, "frame-001.jpg"), "");
        fs.writeFileSync(path.join(dir, "frame-002.jpg"), "");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await mediaSplit({
      jobDir,
      videoPath: "/tmp/video.mp4",
      imagePaths: [],
      hasAudio: true,
      extractFrames: true,
    });
    expect(result.rawFramePaths).toEqual([
      path.join(jobDir, "frames", "frame-001.jpg"),
      path.join(jobDir, "frames", "frame-002.jpg"),
    ]);
  });

  it("for photo-mode posts (no videoPath), resizes the downloaded images instead of extracting frames", async () => {
    const result = await mediaSplit({
      jobDir,
      videoPath: null,
      imagePaths: ["/tmp/slide-1.jpg", "/tmp/slide-2.jpg"],
      hasAudio: false,
      extractFrames: true,
    });
    expect(result.audioPath).toBeNull();
    expect(result.rawFramePaths).toEqual([
      path.join(jobDir, "frames", "resized-000.jpg"),
      path.join(jobDir, "frames", "resized-001.jpg"),
    ]);
  });
});
