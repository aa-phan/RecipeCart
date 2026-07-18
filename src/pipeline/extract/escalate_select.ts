// escalate_select stage (Spec 2 §2.4). Picks which frames get sent to Claude
// as actual images (expensive, so hard-capped) rather than just their OCR
// text. Reuses the SAME ingredient-likelihood scorer as the caption gate
// (ingredient_likelihood.ts) — one heuristic for "does this text look like
// an ingredient line", not two drifting implementations.
import { config } from "../../platform/config.js";
import { scoreLine } from "./ingredient_likelihood.js";
import type { OcrBlock } from "./ocr.js";

// Chrome-tagged text (TikTok UI chrome — counters, usernames, etc.) is real
// evidence but far less likely to be an ingredient list than the main
// content area, so it contributes to a frame's score at a fraction of its
// weight rather than being ignored outright (§2.3b: down-weight, don't delete).
const CHROME_WEIGHT = 0.3;

/** Score each frame by its best (max) ingredient-likelihood line among its
 * OCR blocks, then take the top-scoring frames up to
 * config.extraction.maxEscalationFrames. Returns frame_refs in
 * descending-score order. No-op (returns []) when there are no OCR blocks —
 * the captionSufficient path, where OCR never ran. */
export function selectEscalationFrames(ocrBlocks: OcrBlock[]): string[] {
  if (ocrBlocks.length === 0) return [];

  const scoreByFrame = new Map<string, number>();
  for (const block of ocrBlocks) {
    const rawScore = scoreLine(block.text);
    const weighted = block.tag === "chrome" ? rawScore * CHROME_WEIGHT : rawScore;
    const best = scoreByFrame.get(block.frame_ref) ?? 0;
    if (weighted > best) {
      scoreByFrame.set(block.frame_ref, weighted);
    }
  }

  return [...scoreByFrame.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.extraction.maxEscalationFrames)
    .map(([frameRef]) => frameRef);
}
