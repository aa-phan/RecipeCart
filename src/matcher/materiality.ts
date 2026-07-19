// Claude-delegated materiality judgment (Spec 3 §2.2, the "Claude-delegated
// judgments" paragraph). The matcher's deterministic flags (a broadened-search
// pick, or a close-match ambiguity — see IngredientMatch.substitutionCase's
// doc in types.ts) are a LOCAL SAFETY NET, not the real judgment call: "same
// ingredient/different brand-size = safe; different ingredient as stand-in =
// material; when in doubt → material." This module makes that actual call.
//
// GATED + BATCHED for cost: zero flagged cases means zero API calls (most
// clean-match recipes never touch this), and every flagged case in a recipe
// rides in ONE Claude call rather than one call per ingredient — load-bearing
// given the Sonnet-5 pricing-cliff margin on the (separate) reconcile call.
//
// FAIL-SAFE: any API error, unparseable response, or missing verdict falls
// back to `material: true` for every case in the batch — this can only ever
// ADD a requires_approval flag the deterministic pass would have cleared, and
// can never auto-approve on an uncertain judgment.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../platform/config.js";
import { logger } from "../platform/logger.js";

export interface MaterialityCase {
  ingredientId: string;
  ingredientName: string;
  candidate: { name: string; brand: string | null; size: string | null };
}

export interface MaterialityVerdict {
  material: boolean;
  reason: string;
}

const FAIL_SAFE_REASON = "could not verify substitution safety — flagged for manual review";

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config.secrets.anthropicApiKey,
      maxRetries: config.matching.claudeMaxRetries,
    });
  }
  return client;
}

const SYSTEM_PROMPT = `You are judging grocery-substitution materiality for a recipe shopping assistant. For each numbered case, an ingredient the recipe called for was matched to a Kroger product that was NOT found under the ingredient's own exact name (found via a broadened search or as one of several closely-scored candidates). Decide whether that substitution is SAFE or MATERIAL:

- SAFE: the product is genuinely the same ingredient, just a different brand, size, or minor packaging variant (e.g. ingredient "cream cheese" matched to a specific brand's "garlic & herb spreadable cheese" that is actually cream cheese under a different marketing name).
- MATERIAL: the product is a meaningfully different ingredient being offered as a stand-in (e.g. ingredient "chicken breast" matched to a deli "shaved chicken" product, or "cream cheese" matched to a chicken product that only shares a fuzzy text match).
- WHEN IN DOUBT, judge MATERIAL. A false "safe" verdict risks a wrong item silently reaching a real cart; a false "material" verdict only costs the user one extra manual confirmation.

Output ONLY a JSON array, one entry per case in the same order given, no markdown fences, no prose:
[{"index": <case number>, "material": true|false, "reason": "<one short sentence>"}, ...]`;

function buildUserPrompt(cases: MaterialityCase[]): string {
  return cases
    .map((c, i) => {
      const cand = c.candidate;
      const candDesc = [cand.brand, cand.name, cand.size].filter(Boolean).join(" — ");
      return `${i + 1}. Ingredient: "${c.ingredientName}"\n   Matched product: ${candDesc}`;
    })
    .join("\n\n");
}

function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

interface RawVerdict {
  index: unknown;
  material: unknown;
  reason: unknown;
}

function failSafeAll(cases: MaterialityCase[]): Map<string, MaterialityVerdict> {
  const map = new Map<string, MaterialityVerdict>();
  for (const c of cases) {
    map.set(c.ingredientId, { material: true, reason: FAIL_SAFE_REASON });
  }
  return map;
}

/** Judge safe-vs-material for every flagged substitution case in a recipe,
 * ONE batched Claude call total. Returns an empty map (no API call at all)
 * when `cases` is empty. On any failure, every case falls back to
 * `material: true` (fail-safe — never auto-approves on an uncertain
 * judgment). */
export async function judgeMateriality(
  cases: MaterialityCase[],
): Promise<Map<string, MaterialityVerdict>> {
  if (cases.length === 0) return new Map();

  let response: Anthropic.Message;
  try {
    const anthropic = getClient();
    response = await anthropic.messages.create({
      model: config.matching.materialityModel,
      max_tokens: config.matching.materialityMaxTokens,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(cases) }],
    });
  } catch (err) {
    logger.warn("materiality: Claude call failed, falling back to material for all cases", {
      caseCount: cases.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return failSafeAll(cases);
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) {
    logger.warn("materiality: response had no text block, falling back to material for all cases");
    return failSafeAll(cases);
  }

  let parsed: unknown;
  try {
    parsed = parseJson(textBlock.text);
  } catch (err) {
    logger.warn("materiality: response was not valid JSON, falling back to material for all cases", {
      error: err instanceof Error ? err.message : String(err),
    });
    return failSafeAll(cases);
  }

  if (!Array.isArray(parsed) || parsed.length !== cases.length) {
    logger.warn(
      "materiality: response array shape/length mismatch, falling back to material for all cases",
      { expected: cases.length, got: Array.isArray(parsed) ? parsed.length : typeof parsed },
    );
    return failSafeAll(cases);
  }

  const result = new Map<string, MaterialityVerdict>();
  for (const raw of parsed as RawVerdict[]) {
    const idx = typeof raw.index === "number" ? raw.index - 1 : NaN;
    const target = cases[idx];
    if (!target || typeof raw.material !== "boolean" || typeof raw.reason !== "string") {
      // A malformed individual entry only fails that one case, not the batch
      // — but we don't know WHICH case it was meant for if index is bad, so
      // fail safe for everything not already resolved below the loop.
      continue;
    }
    result.set(target.ingredientId, { material: raw.material, reason: raw.reason });
  }

  // Any case the response didn't resolve (malformed entry, dropped index,
  // etc.) still needs a verdict — fail safe for exactly those, not the whole
  // batch, so one bad entry doesn't discard otherwise-good verdicts.
  for (const c of cases) {
    if (!result.has(c.ingredientId)) {
      logger.warn("materiality: no usable verdict for case, falling back to material", {
        ingredientId: c.ingredientId,
      });
      result.set(c.ingredientId, { material: true, reason: FAIL_SAFE_REASON });
    }
  }

  return result;
}
