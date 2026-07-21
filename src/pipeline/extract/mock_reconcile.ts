// mock_reconcile — a DEV/TESTING-ONLY stand-in for reconcile.ts's Claude
// call, so the full CLI (`recipecart <url>`, real yt-dlp download, real
// local OCR/ASR, real Kroger matching and cart-add) can be exercised
// end-to-end with zero API spend. This is NOT a production fallback and
// NOT a quality claim — it's a dumb heuristic, not an LLM, reusing the same
// ingredient-likelihood scorer the caption-sufficiency gate already uses
// (ingredient_likelihood.ts) to scan caption/ASR/OCR text for
// ingredient-shaped lines. It never infers a quantity it can't see (same
// no-fabrication rule as the real schema), it just finds far fewer/rougher
// matches than Claude actually reading the evidence would.
//
// Every output is clearly marked: the recipe title is prefixed "[MOCK]" so
// it's obvious downstream (DB rows, review tables, logs) that this run
// didn't call Claude at all — never silently indistinguishable from a real
// extraction.
import { findIngredientLikelyLines } from "./ingredient_likelihood.js";
import { SCHEMA_VERSION, type Recipe, type Ingredient, type EvidenceRef } from "../schema.js";
import type { ReconcileInput } from "./reconcile.js";

interface Candidate {
  text: string;
  evidence: EvidenceRef;
}

/** Evidence-source priority on conflict, same rule as the real reconcile
 * (Spec 2 §2.5): on-screen text (ocr) > caption > narration (asr). Sources
 * are scanned in that order and de-duplicated keeping the first (highest-
 * priority) match for a given normalized line. */
function collectCandidates(input: ReconcileInput): Candidate[] {
  const candidates: Candidate[] = [];

  for (const block of input.ocrBlocks) {
    if (block.tag !== "content") continue;
    for (const line of findIngredientLikelyLines(block.text)) {
      candidates.push({
        text: line.text,
        evidence: {
          source_type: "ocr",
          frame_ref: block.frame_ref,
          snippet: line.text.slice(0, 200),
        },
      });
    }
  }

  if (input.caption) {
    for (const line of findIngredientLikelyLines(input.caption)) {
      candidates.push({
        text: line.text,
        evidence: { source_type: "caption", snippet: line.text.slice(0, 200) },
      });
    }
  }

  // Known limitation of reusing the caption-tuned scorer here: it requires
  // the quantity to lead the line, so natural narration ("add 2 cups of
  // flour") mostly won't match — only ASR text that happens to already be
  // quantity-first ("2 cups flour, then...") will. Real Claude reconciliation
  // doesn't have this gap; this is a dumb heuristic, not a quality claim.
  for (const segment of input.asrSegments) {
    for (const line of findIngredientLikelyLines(segment.text)) {
      candidates.push({
        text: line.text,
        evidence: {
          source_type: "asr",
          timestamp: segment.start,
          snippet: line.text.slice(0, 200),
        },
      });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.text.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateToIngredient(candidate: Candidate): Ingredient {
  return {
    canonical_name_en: { value: candidate.text, evidence: [candidate.evidence] },
    raw_text: candidate.text,
    // Never fabricate a quantity the heuristic can't actually parse — same
    // no-inference rule as the real schema, just a much blunter instrument
    // for satisfying it (no real quantity parsing happens here at all).
    quantity: {
      value: null,
      unit: null,
      raw_text: candidate.text,
      null_reason: "mock_reconcile: heuristic scan does not parse quantities",
    },
    is_pantry_staple: false,
  };
}

export function mockReconcile(input: ReconcileInput): Recipe {
  const candidates = collectCandidates(input);
  const ingredients = candidates.map(candidateToIngredient);

  const title = input.caption
    ? {
        value: `[MOCK] ${input.caption.slice(0, 80)}${input.caption.length > 80 ? "…" : ""}`,
        evidence: [{ source_type: "caption" as const, snippet: input.caption.slice(0, 200) }],
      }
    : {
        value: null,
        null_reason: "mock_reconcile: no caption available to derive a title from",
      };

  return {
    extraction_version: SCHEMA_VERSION,
    source_url: input.sourceUrl,
    result_type: "recipe",
    title,
    ingredients,
  };
}
