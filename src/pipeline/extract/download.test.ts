import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { downloadStartTimeoutMs: 200, downloadTotalTimeoutMs: 2000 } },
}));

// retry.ts's own backoff timing is covered by retry.test.ts directly; here we
// stub it to retry immediately (no real delay) so these tests stay fast and
// focus on download.ts's classification/wiring, not backoff timing.
vi.mock("../../platform/retry.js", () => ({
  retryWithBackoff: async (
    fn: () => Promise<unknown>,
    opts: { attempts: number; isRetryable: (err: unknown) => boolean },
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= opts.attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!opts.isRetryable(err) || attempt === opts.attempts) throw err;
      }
    }
    throw lastErr;
  },
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

// A fresh FakeChild per spawn() call so each retry attempt gets independent
// stdout/stderr/close emitters — `spawnedChildren` lets a test reach whichever
// attempt (1st, 2nd, ...) it needs to drive.
let spawnedChildren: FakeChild[];
const spawnMock = vi.fn((..._args: unknown[]) => {
  const child = new FakeChild();
  spawnedChildren.push(child);
  return child;
});
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { download } = await import("./download.js");
const { ExtractionError } = await import("./failures.js");

let jobDir: string;

beforeEach(() => {
  jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-test-"));
  spawnedChildren = [];
  spawnMock.mockClear();
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    spawnedChildren.push(child);
    return child;
  });
});

afterEach(() => {
  fs.rmSync(jobDir, { recursive: true, force: true });
});

describe("download", () => {
  it("reads back the downloaded media file and parsed info.json on success", async () => {
    fs.writeFileSync(path.join(jobDir, "media.mp4"), "fake video bytes");
    fs.writeFileSync(
      path.join(jobDir, "media.info.json"),
      JSON.stringify({ id: "123", description: "2 cups flour", duration: 30 }),
    );

    const promise = download({ jobId: "job-1", jobDir, sourceUrl: "https://www.tiktok.com/x" });
    const child = spawnedChildren[0]!;
    child.stdout.emit("data", Buffer.from("[download] progress\n"));
    child.emit("close", 0);

    const result = await promise;
    expect(result.mediaFiles).toEqual([path.join(jobDir, "media.mp4")]);
    expect(result.info?.description).toBe("2 cups flour");
    expect(result.info?.duration).toBe(30);
    expect(spawnMock).toHaveBeenCalledTimes(1); // success = no retry
  });

  it("maps a permanent (private/deleted) failure to a terminal ExtractionError with NO retry", async () => {
    const promise = download({ jobId: "job-1", jobDir, sourceUrl: "https://www.tiktok.com/x" });
    const child = spawnedChildren[0]!;
    child.stderr.emit("data", Buffer.from("ERROR: This video is private"));
    child.emit("close", 1);

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.failureClass).toBe("download_failed_permanent");
    expect(spawnMock).toHaveBeenCalledTimes(1); // permanent = not retried
  });

  it("retries a transient failure, then maps to a terminal download_failed_transient", async () => {
    // Every attempt closes non-zero with generic (non-permanent) stderr.
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      spawnedChildren.push(child);
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("HTTP Error 503: Service Unavailable"));
        child.emit("close", 1);
      });
      return child;
    });

    const err = await download({
      jobId: "job-1",
      jobDir,
      sourceUrl: "https://www.tiktok.com/x",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.failureClass).toBe("download_failed_transient");
    expect(spawnMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("times out when no output arrives within the start timeout, killing the child", async () => {
    const promise = download({ jobId: "job-1", jobDir, sourceUrl: "https://www.tiktok.com/x" });
    // never emit any data/close -> start timer (200ms, mocked) fires each attempt
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.failureClass).toBe("download_failed_transient");
    expect(spawnedChildren[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  }, 2000);
});
