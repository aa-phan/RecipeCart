import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/config.js", () => ({
  config: { extraction: { maxEscalationFrames: 2 } },
}));

const { selectEscalationFrames } = await import("./escalate_select.js");

import type { OcrBlock } from "./ocr.js";

function block(overrides: Partial<OcrBlock>): OcrBlock {
  return {
    text: "",
    frame_ref: "frame-1",
    box: { xMin: 0, xMax: 0.1, yMin: 0, yMax: 0.1 },
    tag: "content",
    ...overrides,
  };
}

describe("selectEscalationFrames", () => {
  it("returns [] when there are no OCR blocks (captionSufficient path)", () => {
    expect(selectEscalationFrames([])).toEqual([]);
  });

  it("picks the highest ingredient-likelihood frames within the cap", () => {
    // Ordinals all pushed past EARLY_FRAME_WINDOW so the early-frame bonus is
    // 0 for all of them — isolates pure ingredient-likelihood ranking from
    // the early-frame-bonus behavior covered separately below. The
    // zero-scoring frame is deliberately NOT the earliest ordinal in the
    // set, so it's excluded on merit rather than force-included by the
    // earliest-frame hard rule (covered by its own test further down).
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-101", text: "2 cups flour" }), // score 1.0
      block({ frame_ref: "frame-102", text: "800g chicken" }), // score 1.0 (glued)
      block({ frame_ref: "frame-103", text: "- a pinch of salt" }), // bullet + unit -> 0.7
      block({ frame_ref: "frame-104", text: "just some narration text" }), // score 0, latest ordinal
    ];
    const selected = selectEscalationFrames(blocks);
    expect(selected.length).toBe(2);
    expect(selected).not.toContain("frame-104");
  });

  it("down-weights chrome-tagged blocks relative to content blocks", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-chrome-101", text: "2 cups flour", tag: "chrome" }),
      block({ frame_ref: "frame-content-102", text: "2 cups flour", tag: "content" }),
    ];
    const selected = selectEscalationFrames(blocks);
    // both score > 0 so both selected (cap is 2), but content should be first (higher weight)
    expect(selected[0]).toBe("frame-content-102");
  });

  it("boosts a low-confidence OCR read over a high-confidence one with the same text (inverse-confidence weighting)", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-confident-101", text: "2 cups flour", confidence: 0.95 }),
      block({ frame_ref: "frame-unsure-102", text: "2 cups flour", confidence: 0.1 }),
    ];
    // cap of 2 means both are selected regardless — check ORDER (higher score first).
    const selected = selectEscalationFrames(blocks);
    expect(selected[0]).toBe("frame-unsure-102");
  });

  it("treats undefined confidence the same as low confidence, not as a penalty", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-confident-101", text: "2 cups flour", confidence: 0.95 }),
      block({ frame_ref: "frame-unscored-102", text: "2 cups flour", confidence: undefined }),
    ];
    const selected = selectEscalationFrames(blocks);
    expect(selected[0]).toBe("frame-unscored-102");
  });

  it("favors an earlier frame over a later one with identical ingredient-likelihood and confidence (early-frame bonus)", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-002", text: "2 cups flour", confidence: 0.9 }),
      block({ frame_ref: "frame-004", text: "2 cups flour", confidence: 0.9 }),
    ];
    const selected = selectEscalationFrames(blocks);
    expect(selected[0]).toBe("frame-002");
  });

  it("always includes the single earliest frame even when its own score doesn't make the ranked cut (title-card heuristic)", () => {
    // frame-001 (earliest, ordinal 1) has NO ingredient-pattern text at all —
    // exactly the realistic "title card with a recipe name, not a
    // quantity/unit line" case. frame-101/frame-102 are strong matches but
    // pushed past the early-frame window so their ranking is on merit alone.
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-001", text: "Sheet Pan Chicken Dinner" }), // score 0
      block({ frame_ref: "frame-101", text: "2 cups flour" }), // score 1.0
      block({ frame_ref: "frame-102", text: "800g chicken" }), // score 1.0 (glued)
    ];
    const selected = selectEscalationFrames(blocks); // cap 2
    expect(selected).toContain("frame-001");
    expect(selected.length).toBe(2);
    // frame-001 pushed in ahead of the lower-ranked of the two merit picks —
    // both frame-101 and frame-102 score equally here, so either could be
    // the one displaced; the guarantee is just that frame-001 made the cut.
  });

  it("force-includes a lone zero-scoring frame as the (only, hence earliest) title-card candidate", () => {
    // Documented behavior change from the P1 baseline: previously a single
    // frame with no ingredient-pattern text was excluded entirely. Per Spec
    // 2 §2.4's hard rule ("always include at least one early frame"), the
    // sole available frame IS the earliest one by definition, so it's now
    // force-included rather than dropped — a title/ingredient card frame
    // doesn't always contain quantity/unit-shaped text.
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-x", text: "just talking, no ingredients" }),
    ];
    expect(selectEscalationFrames(blocks)).toEqual(["frame-x"]);
  });
});
