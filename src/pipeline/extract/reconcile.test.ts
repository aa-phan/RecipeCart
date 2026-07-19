import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../platform/config.js", () => ({
  config: {
    secrets: { anthropicApiKey: "fake-key" },
    extraction: { claudeModel: "claude-sonnet-5", claudeMaxTokens: 4000, claudeMaxRetries: 3 },
  },
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn(() => Buffer.from("fake-image-bytes")) },
}));

// A minimal stand-in for Anthropic.APIError so createMessageOrFail's
// `instanceof Anthropic.APIError` check works against the mocked SDK.
class FakeAPIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const AnthropicMock = vi.fn().mockImplementation(function AnthropicMock(this: {
    messages: { create: typeof createMock };
  }) {
    this.messages = { create: createMock };
  }) as unknown as { APIError: typeof FakeAPIError };
  AnthropicMock.APIError = FakeAPIError;
  return { default: AnthropicMock };
});

const { reconcile } = await import("./reconcile.js");
const { ExtractionError } = await import("./failures.js");
const { SCHEMA_VERSION } = await import("../schema.js");

function textMessage(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

const validRecipe = {
  extraction_version: SCHEMA_VERSION,
  source_url: "https://www.tiktok.com/@someone/video/123",
  result_type: "recipe",
  ingredients: [
    {
      canonical_name_en: {
        value: "flour",
        evidence: [{ source_type: "ocr", frame_ref: "frame-001", snippet: "2 cups flour" }],
      },
      raw_text: "2 cups flour",
      quantity: { value: 2, unit: "cup", raw_text: "2 cups" },
      is_pantry_staple: true,
    },
  ],
};

const invalidRecipe = {
  extraction_version: SCHEMA_VERSION,
  source_url: "https://www.tiktok.com/@someone/video/123",
  result_type: "recipe",
  ingredients: [
    {
      // non-null value with NO evidence -> should fail schema validation
      canonical_name_en: { value: "flour" },
      raw_text: "2 cups flour",
      quantity: { value: 2, unit: "cup", raw_text: "2 cups" },
      is_pantry_staple: true,
    },
  ],
};

beforeEach(() => {
  createMock.mockReset();
});

describe("reconcile", () => {
  it("validates and returns a well-formed first response without a re-prompt", async () => {
    createMock.mockResolvedValueOnce(textMessage(validRecipe));

    const result = await reconcile({
      sourceUrl: "https://www.tiktok.com/@someone/video/123",
      caption: "2 cups flour",
      asrSegments: [],
      ocrBlocks: [],
      escalationFramePaths: [],
    });

    expect(result.ingredients[0]?.canonical_name_en.value).toBe("flour");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one corrective re-prompt on a schema validation failure, then succeeds", async () => {
    createMock
      .mockResolvedValueOnce(textMessage(invalidRecipe))
      .mockResolvedValueOnce(textMessage(validRecipe));

    const result = await reconcile({
      sourceUrl: "https://www.tiktok.com/@someone/video/123",
      caption: "2 cups flour",
      asrSegments: [],
      ocrBlocks: [],
      escalationFramePaths: [],
    });

    expect(result.ingredients[0]?.canonical_name_en.value).toBe("flour");
    expect(createMock).toHaveBeenCalledTimes(2);
    // second call's messages include the validation errors as corrective feedback
    const secondCallArgs = createMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(secondCallArgs.messages.length).toBe(3); // original user + assistant + corrective user
  });

  it("throws a terminal schema_validation_failed ExtractionError if the corrected response still fails validation", async () => {
    createMock
      .mockResolvedValueOnce(textMessage(invalidRecipe))
      .mockResolvedValueOnce(textMessage(invalidRecipe));

    await expect(
      reconcile({
        sourceUrl: "https://www.tiktok.com/@someone/video/123",
        caption: "2 cups flour",
        asrSegments: [],
        ocrBlocks: [],
        escalationFramePaths: [],
      }),
    ).rejects.toMatchObject({ failureClass: "schema_validation_failed" });
    expect(createMock).toHaveBeenCalledTimes(2); // no more than one re-prompt
  });

  it("maps a post-retry Anthropic APIError to a terminal model_call_failed ExtractionError", async () => {
    // The SDK would have retried transient errors already; an APIError
    // reaching reconcile is terminal.
    createMock.mockRejectedValueOnce(new FakeAPIError("overloaded", 529));

    const err = await reconcile({
      sourceUrl: "https://www.tiktok.com/@someone/video/123",
      caption: "2 cups flour",
      asrSegments: [],
      ocrBlocks: [],
      escalationFramePaths: [],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.failureClass).toBe("model_call_failed");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("passes confidence bands and a conflict record through validation", async () => {
    const withConfidence = {
      ...validRecipe,
      title: {
        value: "Pancakes",
        evidence: [{ source_type: "caption", snippet: "easy pancakes" }],
        confidence: "high",
      },
      ingredients: [
        {
          canonical_name_en: {
            value: "flour",
            evidence: [{ source_type: "ocr", frame_ref: "frame-001", snippet: "2 cups flour" }],
            confidence: "high",
            conflict: {
              resolved_source: "ocr",
              alternatives: [{ source_type: "asr", value: "about a cup of flour" }],
            },
          },
          raw_text: "2 cups flour",
          quantity: { value: 2, unit: "cup", raw_text: "2 cups" },
          is_pantry_staple: true,
        },
      ],
    };
    createMock.mockResolvedValueOnce(textMessage(withConfidence));

    const result = await reconcile({
      sourceUrl: "https://www.tiktok.com/@someone/video/123",
      caption: "easy pancakes, 2 cups flour",
      asrSegments: [],
      ocrBlocks: [],
      escalationFramePaths: [],
    });

    expect(result.ingredients[0]?.canonical_name_en.confidence).toBe("high");
    expect(result.ingredients[0]?.canonical_name_en.conflict?.resolved_source).toBe("ocr");
    expect(result.title?.confidence).toBe("high");
  });

  it("includes escalation frame images as base64 content blocks", async () => {
    createMock.mockResolvedValueOnce(textMessage(validRecipe));

    await reconcile({
      sourceUrl: "https://www.tiktok.com/@someone/video/123",
      caption: null,
      asrSegments: [],
      ocrBlocks: [],
      escalationFramePaths: ["/tmp/frame-001.jpg"],
    });

    const callArgs = createMock.mock.calls[0]?.[0] as {
      messages: { content: { type: string }[] }[];
    };
    const userContent = callArgs.messages[0]?.content ?? [];
    expect(userContent.some((b) => b.type === "image")).toBe(true);
  });
});
