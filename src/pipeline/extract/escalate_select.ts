// escalate_select stage (Spec 2 §2.4, P2 scoring refinement). Picks which
// frames get sent to Claude as actual images (expensive, so hard-capped)
// rather than just their OCR text. Reuses the SAME ingredient-likelihood
// scorer as the caption gate (ingredient_likelihood.ts) — one heuristic for
// "does this text look like an ingredient line", not two drifting
// implementations.
//
// Score = ingredient-likelihood × inverse-OCR-confidence × chrome-weight +
// early-frame bonus (Spec 2 §2.4). The P1 baseline was ingredient-likelihood
// alone; P2 adds the other two terms:
//   - inverse OCR confidence: a frame Tesseract read with LOW confidence but
//     that still looks like an ingredient line is exactly the case vision
//     escalation exists for (Tesseract wasn't sure, Claude reading the actual
//     pixels might resolve it) — so low confidence on likely-ingredient text
//     is a signal FOR escalation, not against it. A floor keeps a
//     high-confidence match from being zeroed out entirely — it's still
//     useful evidence, just less urgent to also send as an image.
//   - early-frame bonus: title/ingredient-card frames tend to appear early
//     in a recipe video (Spec 2 §2.4's "always include at least one early
//     frame" hard rule, below, is the same intuition made absolute).
import { config } from "../../platform/config.js";
import { scoreLine } from "./ingredient_likelihood.js";
import type { OcrBlock } from "./ocr.js";

// Chrome-tagged text (TikTok UI chrome — counters, usernames, etc.) is real
// evidence but far less likely to be an ingredient list than the main
// content area, so it contributes to a frame's score at a fraction of its
// weight rather than being ignored outright (§2.3b: down-weight, don't delete).
const CHROME_WEIGHT = 0.3;

// Floor on inverse-confidence weighting: a word Tesseract read at 100%
// confidence still keeps this fraction of its ingredient-likelihood score,
// rather than being zeroed out just for being clearly legible. Only genuinely
// LOW-confidence reads get the full escalation boost.
const MIN_CONFIDENCE_WEIGHT = 0.2;

// Early-frame bonus (flat points added to score, not a multiplier — so it
// can matter even for a frame with a middling ingredient-likelihood score,
// per the spec's additive "+ bonus for early-video frames"). Decays linearly
// to 0 by EARLY_FRAME_WINDOW frames in; both are tunable heuristics, not
// validated constants — scoreLine's typical range is roughly 0-1.3, so a max
// bonus of 0.3 is meaningful without dominating a genuinely strong match
// found later in the video.
const EARLY_FRAME_BONUS_MAX = 0.3;
const EARLY_FRAME_WINDOW = 5;

/** Extracts a frame's ordinal position from its file path/ref — both real
 * naming schemes (media_split's `frame-003.jpg`, resize_frames's
 * `resized-003.jpg`) embed a monotonically-increasing zero-padded index that
 * tracks video-time order (dedup drops frames but preserves relative order).
 * Takes the LAST run of digits in the ref, so it also works for simpler test
 * fixtures like "frame-1". Unparseable refs sort last (never "early"). */
function frameOrdinal(frameRef: string): number {
  const matches = frameRef.match(/\d+/g);
  if (!matches || matches.length === 0) return Number.MAX_SAFE_INTEGER;
  return Number(matches[matches.length - 1]);
}

function earlyFrameBonus(ordinal: number): number {
  if (ordinal >= EARLY_FRAME_WINDOW) return 0;
  return EARLY_FRAME_BONUS_MAX * (1 - ordinal / EARLY_FRAME_WINDOW);
}

function inverseConfidenceWeight(confidence: number | undefined): number {
  // Undefined confidence (Tesseract couldn't score the word at all) is
  // treated the same as low confidence — an unscored read is exactly the
  // kind of uncertain evidence escalation exists to resolve.
  if (confidence === undefined) return 1;
  return Math.max(MIN_CONFIDENCE_WEIGHT, 1 - confidence);
}

/** Score each frame by its best (max) weighted ingredient-likelihood line
 * among its OCR blocks, then take the top-scoring frames up to
 * config.extraction.maxEscalationFrames — with a hard floor requiring the
 * single earliest-ordinal frame to always be included (Spec 2 §2.4's
 * "title/ingredient-card heuristic"), even if its own score didn't make the
 * cut on merit. No-op (returns []) when there are no OCR blocks — the
 * captionSufficient path, where OCR never ran. */
export function selectEscalationFrames(ocrBlocks: OcrBlock[]): string[] {
  if (ocrBlocks.length === 0) return [];

  // Tracks every frame that had at least one OCR block, including a
  // genuinely 0-scoring one — undefined (not 0) as the "not seen yet"
  // sentinel, so a real 0 score still gets recorded and the frame remains
  // eligible for the always-include-earliest-frame rule below (a title card
  // with no quantity/unit-shaped text legitimately scores 0 on the
  // likelihood heuristic but should still be a candidate for escalation).
  const scoreByFrame = new Map<string, number>();
  for (const block of ocrBlocks) {
    const ordinal = frameOrdinal(block.frame_ref);
    const rawScore = scoreLine(block.text);
    const chromeWeight = block.tag === "chrome" ? CHROME_WEIGHT : 1;
    const weighted =
      rawScore * inverseConfidenceWeight(block.confidence) * chromeWeight +
      earlyFrameBonus(ordinal);
    const best = scoreByFrame.get(block.frame_ref);
    if (best === undefined || weighted > best) {
      scoreByFrame.set(block.frame_ref, weighted);
    }
  }

  const ranked = [...scoreByFrame.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  const cap = config.extraction.maxEscalationFrames;
  let selected = ranked.slice(0, cap).map(([frameRef]) => frameRef);

  // Hard rule: always include at least one early frame, even if its score
  // alone wouldn't have made the cut — a title/ingredient card doesn't
  // always contain quantity/unit-shaped text the likelihood scorer
  // recognizes, but it's still valuable to send to vision. Only applies when
  // there's actually a cap to work within and a frame to add.
  if (cap > 0 && scoreByFrame.size > 0) {
    const [earliestFrame] = [...scoreByFrame.keys()].sort(
      (a, b) => frameOrdinal(a) - frameOrdinal(b),
    );
    if (earliestFrame && !selected.includes(earliestFrame)) {
      selected = [earliestFrame, ...selected.slice(0, cap - 1)];
    }
  }

  return selected;
}
