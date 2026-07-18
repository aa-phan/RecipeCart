// dedup_frames stage (Spec 2 §2.1). Perceptual hashing (dHash) to drop
// near-duplicate frames before spending OCR calls on them — TikTok recipe
// videos routinely hold on the same shot for several seconds, and a fixed
// 2s-interval extraction (frameIntervalS) will pull multiple near-identical
// frames out of a single held shot.
//
// No image-decoding library is a project dependency (deliberately avoiding
// a native/sharp dependency for a P1 pipeline) — ffmpeg is already a hard
// requirement for extraction, so it doubles as the decoder here: piping a
// frame through `scale=9:8,format=gray` -> rawvideo gives exactly the 9x8
// grayscale pixel grid the classic dHash algorithm needs, read straight off
// stdout with no temp file.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../platform/config.js";

const execFileAsync = promisify(execFile);

const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;

/** Compute a 64-bit dHash for one image file. Each bit compares a pixel to
 * its right neighbor in a 9x8 grayscale downscale (9 columns -> 8
 * horizontal comparisons per row * 8 rows = 64 bits). */
export async function computeDHash(framePath: string): Promise<bigint> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      framePath,
      "-vf",
      `scale=${DHASH_WIDTH}:${DHASH_HEIGHT},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024 },
  );
  const pixels = stdout as unknown as Buffer;
  if (pixels.length < DHASH_WIDTH * DHASH_HEIGHT) {
    throw new Error(`dHash: unexpected pixel buffer size ${pixels.length} for ${framePath}`);
  }

  let hash = 0n;
  for (let row = 0; row < DHASH_HEIGHT; row++) {
    for (let col = 0; col < DHASH_WIDTH - 1; col++) {
      const left = pixels[row * DHASH_WIDTH + col]!;
      const right = pixels[row * DHASH_WIDTH + col + 1]!;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

/** Number of differing bits between two dHashes — 0 means identical, larger
 * means more visually different. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Drop frames that are near-duplicates (hamming distance below
 * config.extraction.dedupHammingThreshold) of a frame already kept, walking
 * in input order so the FIRST frame of a held shot is the one retained. */
export async function dedupFrames(framePaths: string[]): Promise<string[]> {
  const kept: { path: string; hash: bigint }[] = [];

  for (const framePath of framePaths) {
    const hash = await computeDHash(framePath);
    const isDuplicate = kept.some(
      (k) => hammingDistance(k.hash, hash) < config.extraction.dedupHammingThreshold,
    );
    if (!isDuplicate) {
      kept.push({ path: framePath, hash });
    }
  }

  return kept.map((k) => k.path);
}
