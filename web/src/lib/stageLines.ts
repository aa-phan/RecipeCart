// Plain-language line per job status/stage, for display in StageLine.tsx and
// anywhere else a screen wants a human-readable progress string. Keys mirror
// `JobStatus`/`JobStatusValue` in src/platform/jobs.ts exactly.

export type JobStatusValue =
  | "received"
  | "validating"
  | "downloading"
  | "processing_media"
  | "extracting_recipe"
  | "matching_products"
  | "awaiting_review"
  | "approved"
  | "adding_to_cart"
  | "completed"
  | "partially_completed"
  | "failed"
  | "requires_user_intervention"
  | "expired";

const STAGE_LINES: Record<JobStatusValue, string> = {
  received: "Got your link — starting up…",
  validating: "Checking the link…",
  downloading: "Downloading the video…",
  processing_media: "Processing the video…",
  extracting_recipe: "Extracting ingredients…",
  matching_products: "Matching ingredients to products…",
  awaiting_review: "Ready to review",
  approved: "Approved — getting ready to shop…",
  adding_to_cart: "Adding to cart…",
  completed: "Done — all items added",
  partially_completed: "Done — some items need attention",
  failed: "Something went wrong",
  requires_user_intervention: "Needs your attention",
  expired: "This request expired",
};

const FALLBACK_LINE = "Working on it…";

// Ordered extraction-pipeline stages (mirrors the worker's state machine,
// src/worker/state_machine.ts's header comment) — used to derive a rough
// fraction-complete for the progress bar. Only covers the pre-review leg;
// post-approval statuses (adding_to_cart, completed, ...) aren't part of
// this progression and return null below.
const PROCESSING_STAGE_ORDER: JobStatusValue[] = [
  "received",
  "validating",
  "downloading",
  "processing_media",
  "extracting_recipe",
  "matching_products",
  "awaiting_review",
];

/**
 * Rough 0-1 completion fraction for the recipe-extraction leg of a job,
 * derived from stage order rather than real substep timing (the worker
 * can't observe finer-grained progress inside a single extract() call — see
 * state_machine.ts). Returns null for statuses outside that progression
 * (nothing to show a bar for).
 */
export function stageProgress(status: string | undefined): number | null {
  if (!status) return null;
  const idx = PROCESSING_STAGE_ORDER.indexOf(status as JobStatusValue);
  if (idx === -1) return null;
  return (idx + 1) / PROCESSING_STAGE_ORDER.length;
}

/**
 * Look up the plain-language line for a job status. When `itemCount` is
 * given for a `completed` status, it's folded in (e.g. "Done — 9 items
 * added") rather than the generic line.
 */
export function stageLineFor(status: string | undefined, itemCount?: number): string {
  if (!status) return FALLBACK_LINE;
  if (status === "completed" && typeof itemCount === "number") {
    return `Done — ${itemCount} item${itemCount === 1 ? "" : "s"} added`;
  }
  return STAGE_LINES[status as JobStatusValue] ?? FALLBACK_LINE;
}
