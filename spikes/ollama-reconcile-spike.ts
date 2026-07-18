// THROWAWAY SPIKE — tests whether a small, locally-hosted Ollama model can
// do real reconciliation work (not just re-parse a caption our heuristic
// already handles). Runs the real pipeline stages (download, probe, caption
// gate, media_split, ASR, OCR — all free/local already) against a real
// TikTok URL, then sends the SAME evidence a real Claude reconcile() call
// would get to a local Ollama model, using the SAME system prompt, and
// validates the response against the SAME real schema validator.
//
// Usage: npx tsx spikes/ollama-reconcile-spike.ts <tiktok-url> [ollama-model]

import crypto from "node:crypto";
import { tempDirFor, cleanupTempDir } from "../src/platform/db.js";
import { normalizeUrl } from "../src/pipeline/extract/normalize_url.js";
import { download } from "../src/pipeline/extract/download.js";
import { probe } from "../src/pipeline/extract/probe.js";
import { parseCaption } from "../src/pipeline/extract/parse_caption.js";
import { mediaSplit } from "../src/pipeline/extract/media_split.js";
import { dedupFrames } from "../src/pipeline/extract/dedup_frames.js";
import { ocrFrames } from "../src/pipeline/extract/ocr.js";
import { transcribeAudio } from "../src/pipeline/extract/asr.js";
import type { JobContext } from "../src/pipeline/extract/types.js";
import { validateRecipe, SCHEMA_VERSION, SchemaValidationError } from "../src/pipeline/schema.js";

const url = process.argv[2];
const model = process.argv[3] ?? "llama3.1:latest";
if (!url) {
  console.error("Usage: npx tsx spikes/ollama-reconcile-spike.ts <tiktok-url> [ollama-model]");
  process.exit(1);
}

// Same system prompt reconcile.ts sends to Claude — copied verbatim so this
// is a fair, apples-to-apples test of the MODEL, not a weaker prompt.
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
      "raw_text": string,
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
6. Output raw JSON only. No markdown fences, no explanation before or after.`;

function isVideoFile(p: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(p);
}

async function main() {
  const jobId = crypto.randomUUID();
  const jobDir = tempDirFor(jobId);
  const ctx: JobContext = { jobId, jobDir, sourceUrl: url };

  console.log(`=== Gathering REAL evidence (free/local stages) for ${url} ===\n`);

  try {
    const normalized = normalizeUrl(url);
    console.log("videoId:", normalized.videoId);

    const downloadResult = await download(ctx);
    const videoPath = downloadResult.mediaFiles.find(isVideoFile) ?? null;
    const caption = downloadResult.info?.description ?? null;
    console.log("caption:", caption?.slice(0, 200));

    const probeResult = videoPath
      ? await probe(videoPath, downloadResult.info?.duration ?? null)
      : { durationS: null, hasAudio: false, hasVideo: false, isPhotoMode: true };

    const captionCheck = parseCaption(caption);
    const extractFrames = !captionCheck.captionSufficient;
    console.log(
      "captionSufficient:",
      captionCheck.captionSufficient,
      "-> extractFrames:",
      extractFrames,
    );

    const splitResult = await mediaSplit({
      jobDir,
      videoPath,
      imagePaths: [],
      hasAudio: probeResult.hasAudio,
      extractFrames,
    });
    const dedupedFramePaths = extractFrames ? await dedupFrames(splitResult.rawFramePaths) : [];

    const [asrSegments, ocrBlocks] = await Promise.all([
      transcribeAudio(splitResult.audioPath),
      extractFrames ? ocrFrames(dedupedFramePaths) : Promise.resolve([]),
    ]);

    console.log(`asrSegments: ${asrSegments.length}, ocrBlocks: ${ocrBlocks.length}\n`);

    const transcriptText =
      asrSegments.length > 0
        ? asrSegments
            .map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text}`)
            .join("\n")
        : "(no speech detected / no audio)";
    const ocrText =
      ocrBlocks.length > 0
        ? ocrBlocks.map((b) => `frame_ref=${b.frame_ref} tag=${b.tag} text="${b.text}"`).join("\n")
        : "(no on-screen text OCR — caption alone was judged sufficient, or text-only spike)";

    const userContent = [
      `source_url: ${url}`,
      "",
      "=== CAPTION ===",
      caption ?? "(no caption)",
      "",
      "=== SPEECH TRANSCRIPT (asr, with timestamps) ===",
      transcriptText,
      "",
      "=== ON-SCREEN TEXT (ocr, with frame_ref + chrome tag) ===",
      ocrText,
      "",
      "(text-only spike — no escalation frame images sent, unlike the real reconcile() call)",
    ].join("\n");

    console.log("=== EXACT user content sent to the model (full, untruncated) ===");
    console.log(userContent);
    console.log(`\n(user content length: ${userContent.length} chars)\n`);
    console.log("=== EXACT system prompt sent (full, untruncated) ===");
    console.log(SYSTEM_PROMPT);
    console.log();

    // Grammar-constrained structured output: a real JSON Schema (not just
    // format:"json", which only guarantees syntactically-valid JSON, not
    // this shape). Ollama constrains token-level sampling to match this.
    // Can't express the "evidence required iff value non-null" refinement
    // JSON Schema draft-07-style, so schema validation afterward is still
    // the real correctness check — this only forces the STRUCTURAL shape.
    const evidenceRefSchema = {
      type: "object",
      properties: {
        source_type: { type: "string", enum: ["asr", "ocr", "caption"] },
        timestamp: { type: "number" },
        frame_ref: { type: "string" },
        snippet: { type: "string" },
      },
      required: ["source_type"],
    };
    const evidencedFieldSchema = (valueType: object) => ({
      type: "object",
      properties: {
        value: { anyOf: [valueType, { type: "null" }] },
        evidence: { type: "array", items: evidenceRefSchema },
        null_reason: { type: "string" },
      },
      required: ["value"],
    });
    const recipeJsonSchema = {
      type: "object",
      properties: {
        extraction_version: { type: "string", const: SCHEMA_VERSION },
        source_url: { type: "string" },
        result_type: { type: "string", enum: ["recipe", "not_a_recipe"] },
        not_a_recipe_reason: { type: "string" },
        title: evidencedFieldSchema({ type: "string" }),
        ingredients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              canonical_name_en: evidencedFieldSchema({ type: "string" }),
              raw_text: { type: "string" },
              quantity: {
                type: "object",
                properties: {
                  value: { anyOf: [{ type: "number" }, { type: "null" }] },
                  unit: { anyOf: [{ type: "string" }, { type: "null" }] },
                  raw_text: { type: "string" },
                },
                required: ["value", "unit", "raw_text"],
              },
              prep_note: { anyOf: [{ type: "string" }, { type: "null" }] },
              is_pantry_staple: { type: "boolean" },
            },
            required: ["canonical_name_en", "raw_text", "quantity", "is_pantry_staple"],
          },
        },
      },
      required: ["extraction_version", "source_url", "result_type", "ingredients"],
    };

    console.log(
      `=== Sending to Ollama model "${model}" (text-only, no vision frames, JSON-Schema-constrained) ===\n`,
    );
    const start = Date.now();

    const response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        format: recipeJsonSchema,
        options: { temperature: 0 },
        stream: false,
      }),
    });

    if (!response.ok) {
      console.error(`Ollama API error ${response.status}:`, await response.text());
      process.exit(1);
    }

    const result = (await response.json()) as { message: { content: string } };
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Response received in ${elapsedS}s\n`);

    console.log("=== Raw model output ===");
    console.log(result.message.content);
    console.log();

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.message.content);
    } catch (err) {
      console.log("=== VERDICT: FAILED — not valid JSON ===");
      console.log(err);
      return;
    }

    try {
      const recipe = validateRecipe(parsed);
      console.log("=== VERDICT: PASSED real schema validation ===");
      console.log(`title: ${recipe.title?.value}`);
      console.log(`ingredients (${recipe.ingredients.length}):`);
      for (const ing of recipe.ingredients) {
        console.log(
          `  - ${ing.canonical_name_en.value ?? "(null)"} | qty: ${ing.quantity.value ?? "null"} ${ing.quantity.unit ?? ""} | raw: "${ing.raw_text}"`,
        );
      }
    } catch (err) {
      console.log("=== VERDICT: FAILED schema validation ===");
      if (err instanceof SchemaValidationError) {
        console.log(JSON.stringify(err.issues, null, 2));
      } else {
        console.log(err);
      }
    }
  } finally {
    cleanupTempDir(jobId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
