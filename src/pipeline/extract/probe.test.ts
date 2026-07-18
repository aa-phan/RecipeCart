import { describe, expect, it, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

// node:util.promisify(execFile) uses execFile's [promisify.custom] symbol
// (child_process.execFile ships one) to produce a function that resolves
// {stdout, stderr} directly — mock that symbol so probe.ts's
// `promisify(execFile)` call resolves exactly like the real thing would,
// without us having to fake node's callback-arity-collapsing behavior.
const PROMISIFY_CUSTOM = (promisify as unknown as { custom: symbol }).custom;
const execFileMock = vi.fn();
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [PROMISIFY_CUSTOM]: execFileMock });
  return { execFile };
});

const { probe } = await import("./probe.js");

beforeEach(() => {
  execFileMock.mockReset();
});

describe("probe", () => {
  it("reports hasAudio/hasVideo from ffprobe stream types and duration from info.json", async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: "video\naudio\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "12.5", stderr: "" });
    const result = await probe("/tmp/video.mp4", 12.5);
    expect(result.hasVideo).toBe(true);
    expect(result.hasAudio).toBe(true);
    expect(result.durationS).toBe(12.5);
    expect(result.isPhotoMode).toBe(false);
  });

  it("detects photo-mode when info.json duration is 0/absent and ffprobe finds no video stream", async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0", stderr: "" });
    const result = await probe("/tmp/image.jpg", null);
    expect(result.isPhotoMode).toBe(true);
    expect(result.hasVideo).toBe(false);
  });

  it("treats an ffprobe failure (no streams) as a photo-mode signal, not a thrown error", async () => {
    execFileMock.mockRejectedValue(new Error("ffprobe: no streams"));
    const result = await probe("/tmp/image.jpg", 0);
    expect(result.isPhotoMode).toBe(true);
    expect(result.hasAudio).toBe(false);
  });
});
