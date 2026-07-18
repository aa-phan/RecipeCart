import { describe, expect, it, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { dedupHammingThreshold: 8 } },
}));

const PROMISIFY_CUSTOM = (promisify as unknown as { custom: symbol }).custom;
const execFileMock = vi.fn();
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [PROMISIFY_CUSTOM]: execFileMock });
  return { execFile };
});

const { computeDHash, hammingDistance, dedupFrames } = await import("./dedup_frames.js");

beforeEach(() => {
  execFileMock.mockReset();
});

// 9x8 = 72 grayscale bytes. All-identical pixels -> every left>right
// comparison is false -> hash 0.
function flatGrayBuffer(): Buffer {
  return Buffer.alloc(72, 128);
}

// A buffer where every pixel is strictly descending left-to-right within
// each row -> every comparison bit is 1 -> hash is all 1s (2^64 - 1).
function descendingGrayBuffer(): Buffer {
  const buf = Buffer.alloc(72);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 9; col++) {
      buf[row * 9 + col] = 200 - col * 10;
    }
  }
  return buf;
}

describe("computeDHash", () => {
  it("produces hash 0 for a flat/uniform image (no left>right transitions)", async () => {
    execFileMock.mockResolvedValue({ stdout: flatGrayBuffer(), stderr: Buffer.alloc(0) });
    const hash = await computeDHash("/tmp/frame.jpg");
    expect(hash).toBe(0n);
  });

  it("produces the all-1s hash for a strictly left>right descending image", async () => {
    execFileMock.mockResolvedValue({ stdout: descendingGrayBuffer(), stderr: Buffer.alloc(0) });
    const hash = await computeDHash("/tmp/frame.jpg");
    expect(hash).toBe((1n << 64n) - 1n);
  });

  it("throws on an unexpectedly small pixel buffer", async () => {
    execFileMock.mockResolvedValue({ stdout: Buffer.alloc(10), stderr: Buffer.alloc(0) });
    await expect(computeDHash("/tmp/frame.jpg")).rejects.toThrow(/unexpected pixel buffer size/);
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingDistance(123n, 123n)).toBe(0);
  });

  it("counts differing bits", () => {
    expect(hammingDistance(0b0000n, 0b1111n)).toBe(4);
  });
});

describe("dedupFrames", () => {
  it("drops a frame whose hash is within the hamming threshold of a kept frame", async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: flatGrayBuffer(), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({ stdout: flatGrayBuffer(), stderr: Buffer.alloc(0) }); // identical -> dup
    const result = await dedupFrames(["/tmp/a.jpg", "/tmp/b.jpg"]);
    expect(result).toEqual(["/tmp/a.jpg"]);
  });

  it("keeps frames whose hashes differ by more than the threshold", async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: flatGrayBuffer(), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({ stdout: descendingGrayBuffer(), stderr: Buffer.alloc(0) });
    const result = await dedupFrames(["/tmp/a.jpg", "/tmp/b.jpg"]);
    expect(result).toEqual(["/tmp/a.jpg", "/tmp/b.jpg"]);
  });
});
