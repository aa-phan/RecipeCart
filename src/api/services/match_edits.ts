// Product-match mutation logic for the recipes API (Phase 3, B1 slice).
// Mirrors recipe_edits.ts's split: keeps routes/recipes.ts a thin dispatcher
// and gives the product_matches mutation a directly-testable home.
import { getDb } from "../../platform/database.js";
import { notFound } from "../lib/errors.js";
import type { MatchDto } from "../lib/dto.js";
import type { ProductCandidate } from "../../matcher/types.js";

export function toMatchDto(row: {
  ingredient_id: string;
  candidates_json: unknown[];
  requires_approval: boolean;
  approval_reason: string | null;
  is_approved: boolean;
  selected_product_id: string | null;
}): MatchDto {
  return {
    ingredientId: row.ingredient_id,
    candidates: row.candidates_json as ProductCandidate[],
    requiresApproval: row.requires_approval,
    approvalReason: row.approval_reason ?? undefined,
    isApproved: row.is_approved,
    selectedProductId: row.selected_product_id,
  };
}

/** Update the selected product for an ingredient's match (Phase 3 plan's
 * locked decision A3): a non-null `selectedProductId` picks that candidate
 * and marks the match approved; `null` means "skip this ingredient" —
 * clears the selection and marks it not-approved. Throws
 * `notFound("match")` if there's no product_matches row for this ingredient
 * (e.g. the ingredient was manually added and never matched). */
export async function updateMatchSelection(
  ingredientId: string,
  selectedProductId: string | null,
): Promise<MatchDto> {
  const isApproved = selectedProductId !== null;
  const row = await getDb()
    .updateTable("product_matches")
    .set({
      selected_product_id: selectedProductId,
      is_approved: isApproved,
      updated_at: new Date(),
    })
    .where("ingredient_id", "=", ingredientId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw notFound("match");
  return toMatchDto(row);
}

/** Convenience wrapper: select a specific candidate product. */
export function selectMatch(ingredientId: string, productId: string): Promise<MatchDto> {
  return updateMatchSelection(ingredientId, productId);
}

/** Convenience wrapper: skip this ingredient's match entirely. */
export function skipMatch(ingredientId: string): Promise<MatchDto> {
  return updateMatchSelection(ingredientId, null);
}
