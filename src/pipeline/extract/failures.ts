// Extraction failure taxonomy (Spec 2 §3). Before Phase 2 the pipeline mostly
// just threw raw stage errors; this gives every terminal failure a stable
// class so the CLI can render a specific failure card (Spec 1), the recipes
// row can record why (db.ts failure_class/failure_reason), and P3 can emit the
// matching `recipe.extraction.failed` event without re-deriving the reason.
//
// NOTE on what is and isn't a "failure":
//   - no_speech_detected and ocr_low_yield are NOT failures — the pipeline
//     proceeds with an empty transcript / lower-yield OCR (handled inline in
//     asr/ocr stages, not here).
//   - not_a_recipe is a SUCCESSFUL classification (Recipe.result_type), not a
//     failure — it flows through the normal return path, not ExtractionError.
// So the only terminal failure classes are the four below.

export type FailureClass =
  // Private/deleted/region-locked/removed video — no retry, terminal (Spec 2 §2.2).
  | "download_failed_permanent"
  // Network/timeout during download — retried ×2 with backoff, terminal after.
  | "download_failed_transient"
  // Claude call failed after the SDK's transient retries were exhausted.
  | "model_call_failed"
  // Response still failed schema validation after one corrective re-prompt.
  | "schema_validation_failed"
  // The job-level hard timeout (Spec C2 §26, config.extraction.jobTimeoutMs)
  // fired before extract() returned — the worker gives up waiting rather
  // than hanging forever; the underlying extract() call keeps running
  // detached in the background (no cooperative cancellation for the
  // yt-dlp/Whisper/Claude calls it wraps).
  | "extraction_timeout";

/** A classified, terminal extraction failure. `userFacingReason` is safe to
 * show in a Spec 1 failure card; `cause` keeps the original error for logs. */
export class ExtractionError extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    public readonly userFacingReason: string,
    public readonly cause?: unknown,
  ) {
    super(`[${failureClass}] ${userFacingReason}`);
    this.name = "ExtractionError";
  }
}

// yt-dlp stderr fragments that mean the video is gone / access-restricted —
// retrying will never help, so these map to download_failed_permanent. Matched
// case-insensitively against stderr. Deliberately conservative: anything not
// matched here is treated as transient (retryable) rather than wrongly giving
// up on a recoverable network blip.
const PERMANENT_DOWNLOAD_PATTERNS: RegExp[] = [
  /private/i,
  /this post is not available/i,
  /video is unavailable/i,
  /has been deleted/i,
  /content isn'?t available/i,
  /removed/i,
  /not available in your (country|region)/i,
  /account.*(private|banned|suspended)/i,
  /login required/i,
  /age[- ]restricted/i,
];

/** Classify a failed yt-dlp download from its stderr. Permanent (no retry)
 * when the message indicates the video is gone or access-restricted;
 * transient (retryable) otherwise — a bare non-zero exit with no telltale
 * text is assumed to be a recoverable network/transient problem. */
export function classifyDownloadFailure(stderr: string): FailureClass {
  return PERMANENT_DOWNLOAD_PATTERNS.some((re) => re.test(stderr))
    ? "download_failed_permanent"
    : "download_failed_transient";
}

/** Short, user-facing card text per failure class (Spec 1 failure card). */
export function userFacingReasonFor(failureClass: FailureClass, detail?: string): string {
  switch (failureClass) {
    case "download_failed_permanent":
      return "This TikTok couldn't be downloaded — it may be private, deleted, or region-restricted.";
    case "download_failed_transient":
      return "Downloading this TikTok kept failing (network or TikTok-side issue). Try again later.";
    case "model_call_failed":
      return "The extraction service was temporarily unavailable. Try again in a bit.";
    case "schema_validation_failed":
      return `The recipe couldn't be structured reliably from this video${detail ? ` (${detail})` : ""}.`;
    case "extraction_timeout":
      return "This recipe took too long to extract.";
  }
}
