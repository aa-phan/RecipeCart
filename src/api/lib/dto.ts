// Frozen API request/response contract (Spec 4 §2.5, PRD C1 §18). Type-only
// exports — no runtime code — so the web app can `import type { ... } from
// "../../../src/api/lib/dto.js"` (real path:
// /Users/aphan/GroceriesGPT/src/api/lib/dto.ts) with zero drift between
// backend and frontend. Route handlers (B1/B2/B3/B4/B5) build objects
// shaped like these; they do not need to satisfy them structurally via
// `implements` (interfaces, not classes) but should return exactly this
// shape from JSON responses.
//
// Reuses existing pipeline/matcher/cart types rather than redefining them —
// see the imports below.
import type { EvidenceRef } from "../../pipeline/schema.js";
import type { ProductCandidate } from "../../matcher/types.js";
import type { CartItemResult, CartRunStatus } from "../../kroger/cart_runner.js";

// Re-exported so consumers (esp. the web app, which imports only from this
// barrel per its own doc comment) don't need a second import path for types
// this file's own interfaces reference in their fields.
export type { EvidenceRef, ProductCandidate, CartItemResult, CartRunStatus };

// ── Recipes ─────────────────────────────────────────────────────────────

export interface RecipeListItemDto {
  id: string;
  title: string | null;
  status: string;
  stage: string;
  createdAt: string;
  /** Plain-language progress line derived from `stage` (Spec 1 "no raw
   * status codes shown to the user") — e.g. "Matching ingredients to
   * products…" */
  stageLine: string;
}

export interface RecipeDetailDto extends RecipeListItemDto {
  sourceUrl: string;
  ingredients: IngredientDto[];
  /** One entry per ingredient that has been matched against Kroger's
   * catalog (manually-added ingredients have none yet). Keyed by
   * `ingredientId`, matching `IngredientDto.id`. */
  matches: MatchDto[];
  /** Present only when status === "failed". */
  failureClass?: string;
  failureReason?: string;
}

export interface IngredientDto {
  id: string;
  canonicalName: string;
  quantityValue: number | null;
  quantityUnit: string | null;
  rawText: string | null;
  isPantryStaple: boolean;
  evidence: EvidenceRef[];
  /** canonical_name_en's confidence band (ConfidenceBandSchema), when the
   * extraction produced one. Absent for manually-added ingredients and rows
   * persisted before this field existed. */
  confidence?: "high" | "medium" | "low";
}

// ── Matches ─────────────────────────────────────────────────────────────

export interface MatchDto {
  ingredientId: string;
  candidates: ProductCandidate[];
  requiresApproval: boolean;
  approvalReason?: string;
  isApproved: boolean;
  selectedProductId: string | null;
}

// ── Cart ────────────────────────────────────────────────────────────────

export interface CartResultDto {
  status: CartRunStatus;
  results: CartItemResult[];
}

// ── Requests ────────────────────────────────────────────────────────────

export interface SubmitRecipeRequest {
  sourceUrl: string;
}

export interface SubmitRecipeResponse {
  jobId: string;
  status: string;
  created: boolean;
}

export interface IngredientEditRequest {
  quantityValue?: number | null;
  quantityUnit?: string | null;
  markOwned?: boolean;
  remove?: boolean;
}

/** Response for PATCH /:id/ingredients/:ingredientId (Phase 5 Slice 3 —
 * amount edits re-drive product matching). `match` is present only when the
 * edit actually changed quantityValue/quantityUnit AND a re-match ran
 * (a store is configured and the ingredient already had a product_matches
 * row) — see recipe_edits.ts's editIngredient doc for the full decision
 * tree. Absent `match` does NOT mean the edit failed; it just means there's
 * nothing new to show in the product picker for this edit. */
export type IngredientEditResponseDto = IngredientDto & { match?: MatchDto };

export interface MatchEditRequest {
  /** The chosen candidate's productId, or `null` meaning "skip this match". */
  selectedProductId?: string | null;
}

// ── Preferences ─────────────────────────────────────────────────────────

export interface PreferencesDto {
  storeBrandPreferred: boolean;
  organicPreferred: boolean;
  dietaryTags: string[];
  pantryAlwaysOwned: string[];
}
