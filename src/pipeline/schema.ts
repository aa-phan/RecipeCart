// Canonical recipe schema (Spec 2 §4). This spec owns the contract; Specs 1
// and 3 consume it unchanged. Enforced by validation, not convention:
//   - every non-null field carries >=1 evidence ref
//   - quantity.value is null + raw_text preserved for vague quantities —
//     never a fabricated number
//   - dietary_attributes splits `stated` vs `inferred` (schema-level safety
//     distinction: Spec 1 must render them with different weight, Spec 3
//     must never filter on `inferred` as if it were a claim)
import { z } from "zod";

export const SCHEMA_VERSION = "2026-07-schema-v1";

export const EvidenceRefSchema = z.object({
  // "ocr" means text legible in a frame (tesseract output, or Claude reading
  // on-screen text/graphics directly from an escalation frame image) — NOT
  // general visual recognition of food/objects in a frame with no
  // accompanying text. See spec-2-tiktok-extraction.md §2.5b.
  source_type: z.enum(["asr", "ocr", "caption"]),
  timestamp: z.number().nonnegative().optional(),
  frame_ref: z.string().optional(),
  // The matched segment +/- 1 segment, capped ~200 chars (A2-5).
  snippet: z.string().max(200).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

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

export const QuantitySchema = z.object({
  // Never fabricated: null for vague quantities ("a glug"), raw_text kept.
  value: z.number().nonnegative().nullable(),
  unit: z.string().nullable(),
  raw_text: z.string(),
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
