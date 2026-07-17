// Caption-sufficiency gate (Spec 2 §2.3a). Runs right after `download`/
// `probe`, before any frame extraction. When the caption alone looks like it
// has a real ingredient list, the frame/OCR branch of the pipeline
// (media_split frames, dedup_frames, resize_frames, ocr) is skipped entirely
// — cheaper and faster than always running the vision path. `asr` still runs
// regardless: captions carry ingredients but essentially never carry method
// steps.
import { config } from "../../platform/config.js";
import { findIngredientLikelyLines, type IngredientLikelyLine } from "./ingredient_likelihood.js";

export interface CaptionCheckResult {
  captionSufficient: boolean;
  matchedLines: IngredientLikelyLine[];
}

/** Deliberately biased toward false negatives over false positives: skipping
 * OCR only when confident. A caption that only *looked* sufficient but
 * missed real ingredients isn't a wrong answer — it just surfaces as more
 * `null` + `null_reason` fields downstream, caught by schema validation
 * (§2.3a), not by this gate. */
export function parseCaption(caption: string | null | undefined): CaptionCheckResult {
  if (!caption) {
    return { captionSufficient: false, matchedLines: [] };
  }

  const matchedLines = findIngredientLikelyLines(caption);
  return {
    captionSufficient: matchedLines.length >= config.extraction.captionMinIngredientLines,
    matchedLines,
  };
}
