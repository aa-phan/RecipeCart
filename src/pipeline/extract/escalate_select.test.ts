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

  it("picks the highest-scoring frames, capped at maxEscalationFrames", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-1", text: "just some narration text" }), // score 0
      block({ frame_ref: "frame-2", text: "2 cups flour" }), // score 1.0
      block({ frame_ref: "frame-3", text: "800g chicken" }), // score 1.0 (glued)
      block({ frame_ref: "frame-4", text: "- a pinch of salt" }), // bullet + unit -> 0.7
    ];
    const selected = selectEscalationFrames(blocks);
    expect(selected.length).toBe(2);
    expect(selected).not.toContain("frame-1");
  });

  it("down-weights chrome-tagged blocks relative to content blocks", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-chrome", text: "2 cups flour", tag: "chrome" }),
      block({ frame_ref: "frame-content", text: "2 cups flour", tag: "content" }),
    ];
    const selected = selectEscalationFrames(blocks);
    // both score > 0 so both selected (cap is 2), but content should be first (higher weight)
    expect(selected[0]).toBe("frame-content");
  });

  it("excludes frames whose best block scores 0", () => {
    const blocks: OcrBlock[] = [
      block({ frame_ref: "frame-x", text: "just talking, no ingredients" }),
    ];
    expect(selectEscalationFrames(blocks)).toEqual([]);
  });
});
