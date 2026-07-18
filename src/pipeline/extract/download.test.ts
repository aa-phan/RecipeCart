import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { downloadStartTimeoutMs: 200, downloadTotalTimeoutMs: 2000 } },
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let fakeChild: FakeChild;
const spawnMock = vi.fn((..._args: unknown[]) => fakeChild);
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { download, DownloadTimeoutError, DownloadFailedError } = await import("./download.js");

let jobDir: string;

beforeEach(() => {
  jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-test-"));
  fakeChild = new FakeChild();
  spawnMock.mockClear();
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
    fakeChild.stdout.emit("data", Buffer.from("[download] progress\n"));
    fakeChild.emit("close", 0);

    const result = await promise;
    expect(result.mediaFiles).toEqual([path.join(jobDir, "media.mp4")]);
    expect(result.info?.description).toBe("2 cups flour");
    expect(result.info?.duration).toBe(30);
  });

  it("rejects with DownloadFailedError on a non-zero exit code", async () => {
    const promise = download({ jobId: "job-1", jobDir, sourceUrl: "https://www.tiktok.com/x" });
    fakeChild.stderr.emit("data", Buffer.from("ERROR: video unavailable"));
    fakeChild.emit("close", 1);

    await expect(promise).rejects.toThrow(DownloadFailedError);
  });

  it("rejects with DownloadTimeoutError if no output arrives within the start timeout", async () => {
    const promise = download({ jobId: "job-1", jobDir, sourceUrl: "https://www.tiktok.com/x" });
    // never emit any data/close -> start timer (200ms, mocked) should fire
    await expect(promise).rejects.toThrow(DownloadTimeoutError);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");
  }, 1000);
});
