import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff } from "./retry.js";

const alwaysRetryable = () => true;

describe("retryWithBackoff", () => {
  it("returns the first result without retrying on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, {
      attempts: 2,
      baseDelayMs: 1,
      isRetryable: alwaysRetryable,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure up to `attempts` extra times, then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");
    const result = await retryWithBackoff(fn, {
      attempts: 2,
      baseDelayMs: 1,
      isRetryable: alwaysRetryable,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("throws the last error after exhausting all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still failing"));
    await expect(
      retryWithBackoff(fn, { attempts: 2, baseDelayMs: 1, isRetryable: alwaysRetryable }),
    ).rejects.toThrow("still failing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error — rethrows immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      retryWithBackoff(fn, { attempts: 5, baseDelayMs: 1, isRetryable: () => false }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
