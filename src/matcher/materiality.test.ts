import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../platform/config.js", () => ({
  config: {
    secrets: { anthropicApiKey: "fake-key" },
    matching: {
      materialityModel: "claude-sonnet-5",
      materialityMaxTokens: 1024,
      claudeMaxRetries: 3,
    },
  },
}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock(this: {
    messages: { create: typeof createMock };
  }) {
    this.messages = { create: createMock };
  }),
}));

const { judgeMateriality } = await import("./materiality.js");

function textMessage(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

const caseA = {
  ingredientId: "ing-0",
  ingredientName: "cream cheese",
  candidate: { name: "Garlic & Herb Spreadable Cheese", brand: "Philadelphia", size: "8 oz" },
};
const caseB = {
  ingredientId: "ing-1",
  ingredientName: "chicken breast",
  candidate: { name: "Shaved Chicken", brand: "Kroger", size: "10 oz" },
};

beforeEach(() => {
  createMock.mockReset();
});

describe("judgeMateriality", () => {
  it("makes no API call and returns an empty map when there are zero cases", async () => {
    const result = await judgeMateriality([]);
    expect(result.size).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("maps a safe verdict through", async () => {
    createMock.mockResolvedValueOnce(
      textMessage([{ index: 1, material: false, reason: "same product, different brand name" }]),
    );

    const result = await judgeMateriality([caseA]);
    expect(result.get("ing-0")).toEqual({
      material: false,
      reason: "same product, different brand name",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("maps a material verdict through", async () => {
    createMock.mockResolvedValueOnce(
      textMessage([{ index: 1, material: true, reason: "different cut of meat entirely" }]),
    );

    const result = await judgeMateriality([caseB]);
    expect(result.get("ing-1")).toEqual({
      material: true,
      reason: "different cut of meat entirely",
    });
  });

  it("batches multiple cases into exactly one call", async () => {
    createMock.mockResolvedValueOnce(
      textMessage([
        { index: 1, material: false, reason: "safe" },
        { index: 2, material: true, reason: "material" },
      ]),
    );

    const result = await judgeMateriality([caseA, caseB]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.get("ing-0")?.material).toBe(false);
    expect(result.get("ing-1")?.material).toBe(true);
  });

  it("fails safe (material: true for every case) on an API error", async () => {
    createMock.mockRejectedValueOnce(new Error("network down"));

    const result = await judgeMateriality([caseA, caseB]);
    expect(result.get("ing-0")).toMatchObject({ material: true });
    expect(result.get("ing-1")).toMatchObject({ material: true });
  });

  it("fails safe on an unparseable response", async () => {
    createMock.mockResolvedValueOnce({ content: [{ type: "text", text: "not json at all" }] });

    const result = await judgeMateriality([caseA]);
    expect(result.get("ing-0")).toMatchObject({ material: true });
  });

  it("fails safe on a response array length mismatch", async () => {
    createMock.mockResolvedValueOnce(textMessage([{ index: 1, material: false, reason: "ok" }]));

    const result = await judgeMateriality([caseA, caseB]);
    expect(result.get("ing-0")).toMatchObject({ material: true });
    expect(result.get("ing-1")).toMatchObject({ material: true });
  });

  it("fails safe only for a case with a malformed individual entry, not the whole batch", async () => {
    createMock.mockResolvedValueOnce(
      textMessage([
        { index: 1, material: false, reason: "safe" },
        { index: 2, material: "not-a-boolean", reason: "material" },
      ]),
    );

    const result = await judgeMateriality([caseA, caseB]);
    expect(result.get("ing-0")).toEqual({ material: false, reason: "safe" });
    expect(result.get("ing-1")).toMatchObject({ material: true }); // fail-safe fallback
  });
});
