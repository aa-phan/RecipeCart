// Generic retry-with-backoff helper (Spec 2 §3 retry policy). Used by the
// download stage for transient network/timeout failures (×2 backoff). The
// Claude reconcile call does NOT use this — the @anthropic-ai/sdk already
// retries transient errors internally with its own exponential backoff (see
// config.extraction.claudeMaxRetries), so wrapping it here would double-retry.
import { logger } from "./logger.js";

export interface RetryOptions {
  /** Number of RETRIES after the first attempt (so `attempts: 2` = up to 3
   * total tries). */
  attempts: number;
  baseDelayMs: number;
  /** Return true if the error is worth retrying. A non-retryable error is
   * rethrown immediately without burning attempts. */
  isRetryable: (err: unknown) => boolean;
  /** Optional label for logging which operation is retrying. */
  label?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, retrying up to `opts.attempts` times on retryable errors with
 * exponential backoff (baseDelayMs, 2×, 4× …). A non-retryable error is
 * rethrown at once; the last error is rethrown after attempts are exhausted. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!opts.isRetryable(err) || attempt === opts.attempts) {
        throw err;
      }
      const wait = opts.baseDelayMs * 2 ** attempt;
      logger.warn("retry: transient failure, backing off", {
        label: opts.label,
        attempt: attempt + 1,
        maxAttempts: opts.attempts,
        waitMs: wait,
        error: err instanceof Error ? err.message : String(err),
      });
      await delay(wait);
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastError;
}
