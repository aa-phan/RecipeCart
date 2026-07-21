// Canonical recipe schema (Spec 2 §4). This spec owns the contract; Specs 1
// and 3 consume it unchanged. Enforced by validation, not convention:
//   - every non-null field carries >=1 evidence ref (quantity.value included
//     — see QuantitySchema)
//   - quantity.value is null + null_reason stated + raw_text preserved for
//     vague quantities — never a fabricated number
//   - a quantity conflict between evidence sources (e.g. narration "1 cup"
//     vs on-screen "3/4 cup") is retained on quantity.conflict, never
//     silently resolved without a trace
//   - dietary_attributes splits `stated` vs `inferred` (schema-level safety
//     distinction: Spec 1 must render them with different weight, Spec 3
//     must never filter on `inferred` as if it were a claim)
import { z } from "zod";

export const SCHEMA_VERSION = "2026-07-schema-v1";

export const SOURCE_TYPES = ["asr", "ocr", "caption"] as const;

export const EvidenceRefSchema = z.object({
  // "ocr" means text legible in a frame (tesseract output, or Claude reading
  // on-screen text/graphics directly from an escalation frame image) — NOT
  // general visual recognition of food/objects in a frame with no
  // accompanying text. See spec-2-tiktok-extraction.md §2.5b.
  source_type: z.enum(SOURCE_TYPES),
  timestamp: z.number().nonnegative().optional(),
  frame_ref: z.string().optional(),
  // The matched segment +/- 1 segment, capped ~200 chars (A2-5).
  snippet: z.string().max(200).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// Per-field confidence band (Spec 2 §2 P2 / A2-4): high >=0.85, medium
// 0.5-0.85, low <0.5. Emitted as a band label, not a raw score — the bands
// only need to be consistent, not numerically precise (A2-4), and a label is
// cheaper in output tokens than a float + keeps the model from over-anchoring
// on spurious precision.
export const ConfidenceBandSchema = z.enum(["high", "medium", "low"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

// Structural record of an evidence-source conflict (Spec 2 §2.5 conflict
// rule): when two sources disagreed on the same field, the winning value is
// resolved per priority (ocr > caption > asr) and kept as the field's value,
// while the discarded alternative(s) are retained here rather than silently
// dropped — "all retained" per the spec, so the resolution is auditable.
export const ConflictRecordSchema = z.object({
  resolved_source: z.enum(SOURCE_TYPES),
  alternatives: z
    .array(
      z.object({
        source_type: z.enum(SOURCE_TYPES),
        value: z.string(),
      }),
    )
    .min(1),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

// A field that is either populated WITH evidence, or explicitly null WITH a
// stated reason — never populated with no evidence, and never silently
// missing. This is the mechanical enforcement of "no unsupported inference";
// the refinement below is what actually makes it a rule rather than a hope.
function evidencedField<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      evidence: z.array(EvidenceRefSchema).optional(),
      null_reason: z.string().optional(),
      // Optional per-field confidence band (A2-4) and conflict record — both
      // additive and optional so recipes persisted before Phase 2 still
      // validate. Present on non-null fields the model was asked to grade.
      confidence: ConfidenceBandSchema.optional(),
      conflict: ConflictRecordSchema.optional(),
    })
    .superRefine((field, ctx) => {
      if (field.value !== null) {
        if (!field.evidence || field.evidence.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "a non-null value requires at least one evidence ref",
            path: ["evidence"],
          });
        }
      } else if (!field.null_reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a null value requires a stated null_reason",
          path: ["null_reason"],
        });
      }
    });
}

// Quantity carries the same "populated WITH evidence, or explicitly null
// WITH a stated reason" discipline as evidencedField() — but isn't built by
// wrapping evidencedField() directly, since a quantity is several related
// sub-fields (value, unit, raw_text) rather than one scalar `value`.
// raw_text is deliberately OUTSIDE the gate and unconditionally required:
// it's the literal source text ("a glug", "2 cups") and must be preserved
// whether or not `value` ends up evidenced or null — never fabricated,
// never dropped. `value`/`unit` are gated together (they're set to null as
// a pair for vague quantities, per rule 2 in the reconcile prompt) using
// the exact same evidence/null_reason/confidence/conflict shape as every
// other evidenced field, reusing EvidenceRefSchema/ConfidenceBandSchema/
// ConflictRecordSchema unchanged.
export const QuantitySchema = z
  .object({
    // Never fabricated: null for vague quantities ("a glug"), raw_text kept.
    value: z.number().nonnegative().nullable(),
    unit: z.string().nullable(),
    raw_text: z.string(),
    evidence: z.array(EvidenceRefSchema).optional(),
    null_reason: z.string().optional(),
    // Optional per-field confidence band (A2-4) and conflict record — see
    // evidencedField() above for why both are optional. Present on non-null
    // quantities the model was asked to grade/reconcile.
    confidence: ConfidenceBandSchema.optional(),
    conflict: ConflictRecordSchema.optional(),
  })
  .superRefine((field, ctx) => {
    if (field.value !== null) {
      if (!field.evidence || field.evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a non-null quantity value requires at least one evidence ref",
          path: ["evidence"],
        });
      }
    } else if (!field.null_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a null quantity value requires a stated null_reason",
        path: ["null_reason"],
      });
    }
  });

export const DietaryAttributesSchema = z.object({
  // Schema-level safety distinction — never collapse these into one list.
  stated: z.array(z.string()).default([]),
  inferred: z.array(z.string()).default([]),
});

export const IngredientSchema = z.object({
  canonical_name_en: evidencedField(z.string()),
  raw_text: z.string(), // source-language text preserved
  quantity: QuantitySchema,
  prep_note: z.string().nullable().optional(),
  is_pantry_staple: z.boolean().default(false),
  dietary_attributes: DietaryAttributesSchema.optional(),
});
export type Ingredient = z.infer<typeof IngredientSchema>;

export const RecipeSchema = z.object({
  extraction_version: z.literal(SCHEMA_VERSION),
  source_url: z.string().url(),
  result_type: z.enum(["recipe", "not_a_recipe"]),
  title: evidencedField(z.string()).optional(),
  ingredients: z.array(IngredientSchema),
  steps: z.array(evidencedField(z.string())).optional(),
  dietary_attributes: DietaryAttributesSchema.optional(),
  not_a_recipe_reason: z.string().optional(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export class SchemaValidationError extends Error {
  constructor(public issues: z.ZodIssue[]) {
    super(`Recipe schema validation failed: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "SchemaValidationError";
  }
}

/** Validate a raw (e.g. Claude-produced) object against the canonical
 * schema. Throws SchemaValidationError on failure — callers (the
 * `reconcile` stage) catch this to drive the one-corrective-re-prompt rule
 * before falling to the terminal `schema_validation_failed` failure class. */
export function validateRecipe(raw: unknown): Recipe {
  const result = RecipeSchema.safeParse(raw);
  if (!result.success) {
    throw new SchemaValidationError(result.error.issues);
  }
  return result.data;
}
