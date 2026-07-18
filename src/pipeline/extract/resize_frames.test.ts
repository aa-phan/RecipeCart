import { describe, expect, it, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

const PROMISIFY_CUSTOM = (promisify as unknown as { custom: symbol }).custom;
const execFileMock = vi.fn();
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [PROMISIFY_CUSTOM]: execFileMock });
  return { execFile };
});

const { buildScaleFilter, resizeFrames } = await import("./resize_frames.js");

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("buildScaleFilter", () => {
  it("builds an ffmpeg filter that scales the long edge without upscaling", () => {
    const filter = buildScaleFilter(1024);
    expect(filter).toContain("1024");
    expect(filter).toContain("scale=");
  });
});

describe("resizeFrames", () => {
  it("invokes ffmpeg once per input frame and returns the resized output paths in order", async () => {
    const result = await resizeFrames(["/tmp/a.jpg", "/tmp/b.jpg"], "/tmp/out", 1024);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(["/tmp/out/resized-000.jpg", "/tmp/out/resized-001.jpg"]);
    const firstCallArgs = execFileMock.mock.calls[0]?.[1] as string[];
    expect(firstCallArgs).toContain("/tmp/a.jpg");
  });

  it("returns [] for an empty input list without calling ffmpeg", async () => {
    const result = await resizeFrames([], "/tmp/out", 1024);
    expect(result).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
