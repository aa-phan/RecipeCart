// reconcile stage (Spec 2 §2.5). The one Claude call that turns caption +
// transcript + OCR blocks + escalation-frame images into the canonical
// Recipe JSON (schema.ts). Evidence-source priority on conflict: on-screen
// text (ocr) > caption > narration (asr) — on-screen text is what the
// creator deliberately wrote out as the definitive ingredient/quantity, a
// caption is close behind, narration is the least precise (people round
// numbers and skip amounts when talking).
//
// On a SchemaValidationError, exactly ONE corrective re-prompt is made
// (P1 has no broader retry policy yet — that's P2). If the corrected
// response still doesn't validate, this throws ReconcileFailedError, a
// terminal failure for this job.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";
import { validateRecipe, SchemaValidationError, SCHEMA_VERSION, type Recipe } from "../schema.js";
import type { AsrSegment } from "./asr.js";
import type { OcrBlock } from "./ocr.js";
import fs from "node:fs";
import path from "node:path";

export class ReconcileFailedError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown,
  ) {
    super(message);
    this.name = "ReconcileFailedError";
  }
}

export interface ReconcileInput {
  sourceUrl: string;
  caption: string | null;
  asrSegments: AsrSegment[];
  /** Cleaned OCR blocks (empty when the caption-sufficiency gate skipped
   * OCR entirely). */
  ocrBlocks: OcrBlock[];
  /** Up to config.extraction.maxEscalationFrames frame file paths, sent as
   * base64 images. Empty when captionSufficient. */
  escalationFramePaths: string[];
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.secrets.anthropicApiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You are extracting a structured recipe from a TikTok video's evidence (caption text, speech transcript, on-screen text OCR, and video frame images). You must output ONLY a single JSON object matching this exact schema — no prose, no markdown code fences, just the raw JSON object.

Schema (TypeScript-shape description):

{
  "extraction_version": "${SCHEMA_VERSION}",   // literal, always this exact string
  "source_url": string,                         // the source URL given to you, verbatim
  "result_type": "recipe" | "not_a_recipe",     // "not_a_recipe" if the video isn't actually a recipe
  "not_a_recipe_reason"?: string,                // required if result_type is "not_a_recipe"
  "title"?: {
    "value": string | null,
    "evidence"?: [{ "source_type": "asr"|"ocr"|"caption", "timestamp"?: number, "frame_ref"?: string, "snippet"?: string }],
    "null_reason"?: string
  },
  "ingredients": [
    {
      "canonical_name_en": { "value": string | null, "evidence"?: [...], "null_reason"?: string },
      "raw_text": string,                        // source-language text, preserved as written/spoken
      "quantity": { "value": number | null, "unit": string | null, "raw_text": string },
      "prep_note"?: string | null,
      "is_pantry_staple": boolean,
      "dietary_attributes"?: { "stated": string[], "inferred": string[] }
    }
  ],
  "steps"?: [{ "value": string | null, "evidence"?: [...], "null_reason"?: string }],
  "dietary_attributes"?: { "stated": string[], "inferred": string[] }
}

CRITICAL RULES:
1. EVERY field that is an { value, evidence, null_reason } object ("evidenced field") MUST follow exactly one of these two forms:
   - value is non-null AND evidence has at least 1 entry pointing at where that value came from (asr timestamp, ocr frame_ref, or caption snippet).
   - value is null AND null_reason is a short string explaining why (e.g. "not stated in caption, transcript, or on-screen text").
   Never provide a non-null value without evidence. Never leave a null value without a null_reason.
2. NEVER infer or guess a quantity, ingredient, or amount that isn't actually stated in the evidence. If a quantity is vague ("a glug of olive oil", "some salt"), set quantity.value to null and quantity.unit to null, but KEEP quantity.raw_text as the literal text ("a glug", "some"). Do not convert vague amounts into fabricated numbers.
3. Evidence-source priority when sources conflict on the same fact: on-screen text (ocr) > caption > narration (asr). If OCR shows "2 cups flour" but narration says "about a cup of flour", trust the OCR value and evidence it with the ocr source.
4. is_pantry_staple: leave this false unless you have strong evidence it's a common pantry staple (salt, pepper, oil, water, sugar, flour) — a later postprocessing step will also apply a fixed staple list, so it's fine to leave ambiguous cases false.
5. dietary_attributes.stated is ONLY for attributes the video explicitly claims (e.g. narration says "this is vegan"). dietary_attributes.inferred is for attributes you can reasonably infer from the ingredient list (e.g. no meat/dairy/eggs present) but that were never explicitly claimed — never put an inferred attribute into "stated".
6. Frame images are evidence of on-screen TEXT/graphics only (ingredient labels, quantity call-outs, a printed recipe card or slide) — they are NOT a general visual-recognition input. Do not name an ingredient because you can visually recognize the food in a frame (e.g. "that looks like raw beef and scallions in a bowl") unless legible on-screen text, the caption, or narration also names it. A frame showing food being prepared with no legible text is not valid evidence for what that food is — treat it as unstated (value: null, with a null_reason like "only shown in video footage, not named in caption, transcript, or legible on-screen text") rather than guessing from appearance. Only tag evidence source_type "ocr" when it reflects text actually legible in that frame.
7. Output raw JSON only. No markdown fences, no explanation before or after.`;

function buildUserContent(input: ReconcileInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];

  const transcriptText =
    input.asrSegments.length > 0
      ? input.asrSegments
          .map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text}`)
          .join("\n")
      : "(no speech detected / no audio)";

  const ocrText =
    input.ocrBlocks.length > 0
      ? input.ocrBlocks
          .map(
            (b) =>
              `frame_ref=${b.frame_ref} tag=${b.tag} confidence=${b.confidence ?? "n/a"} text="${b.text}"`,
          )
          .join("\n")
      : "(no on-screen text OCR — caption alone was judged sufficient)";

  blocks.push({
    type: "text",
    text: [
      `source_url: ${input.sourceUrl}`,
      "",
      "=== CAPTION ===",
      input.caption ?? "(no caption)",
      "",
      "=== SPEECH TRANSCRIPT (asr, with timestamps) ===",
      transcriptText,
      "",
      "=== ON-SCREEN TEXT (ocr, with frame_ref + chrome tag) ===",
      ocrText,
      "",
      input.escalationFramePaths.length > 0
        ? `${input.escalationFramePaths.length} escalation frame image(s) follow, in the order listed above by frame_ref.`
        : "(no escalation frame images)",
    ].join("\n"),
  });

  for (const framePath of input.escalationFramePaths) {
    const mediaType = mediaTypeForPath(framePath);
    const base64 = fs.readFileSync(framePath).toString("base64");
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    });
    blocks.push({ type: "text", text: `(frame_ref: ${framePath})` });
  }

  return blocks;
}

function mediaTypeForPath(p: string): "image/jpeg" | "image/png" | "image/webp" {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function extractJsonText(message: Anthropic.Message): string {
  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) {
    throw new ReconcileFailedError("Claude response had no text content block", null);
  }
  return textBlock.text;
}

function parseJson(text: string): unknown {
  // Defensive: strip markdown fences if the model added them despite
  // instructions not to.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

export async function reconcile(input: ReconcileInput): Promise<Recipe> {
  const anthropic = getClient();
  const userContent = buildUserContent(input);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  const first = await anthropic.messages.create({
    model: config.extraction.claudeModel,
    max_tokens: config.extraction.claudeMaxTokens,
    system: SYSTEM_PROMPT,
    messages,
  });

  const firstText = extractJsonText(first);
  let candidate: unknown;
  try {
    candidate = parseJson(firstText);
  } catch (err) {
    logger.warn("reconcile: first response was not valid JSON, treating as validation failure", {
      error: err instanceof Error ? err.message : String(err),
    });
    candidate = null;
  }

  try {
    if (candidate === null) throw new SchemaValidationError([]);
    return validateRecipe(candidate);
  } catch (err) {
    if (!(err instanceof SchemaValidationError)) throw err;

    logger.warn(
      "reconcile: first response failed schema validation, sending one corrective re-prompt",
      {
        issueCount: err.issues.length,
      },
    );

    messages.push({ role: "assistant", content: firstText });
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "That response failed schema validation with these errors:\n" +
            JSON.stringify(err.issues, null, 2) +
            "\n\nFix the JSON to satisfy every rule above and output the corrected JSON object only.",
        },
      ],
    });

    const second = await anthropic.messages.create({
      model: config.extraction.claudeModel,
      max_tokens: config.extraction.claudeMaxTokens,
      system: SYSTEM_PROMPT,
      messages,
    });

    const secondText = extractJsonText(second);
    let secondCandidate: unknown;
    try {
      secondCandidate = parseJson(secondText);
    } catch (parseErr) {
      throw new ReconcileFailedError(
        "corrective re-prompt response was not valid JSON",
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
    }

    try {
      return validateRecipe(secondCandidate);
    } catch (secondErr) {
      if (secondErr instanceof SchemaValidationError) {
        throw new ReconcileFailedError(
          "recipe still failed schema validation after one corrective re-prompt",
          secondErr.issues,
        );
      }
      throw secondErr;
    }
  }
}
