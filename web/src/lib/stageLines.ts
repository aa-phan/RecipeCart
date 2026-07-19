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
