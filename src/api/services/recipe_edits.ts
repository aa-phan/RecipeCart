// Ingredient mutation logic for the recipes API (Phase 3, B1 slice). Kept
// out of routes/recipes.ts so the route handlers stay thin dispatchers and
// this DB logic has a directly-testable home (mirrors matcher/index.ts's
// "service function over real Postgres" pattern).
import crypto from "node:crypto";
import { getDb } from "../../platform/database.js";
import { notFound } from "../lib/errors.js";
import type { IngredientDto, IngredientEditRequest } from "../lib/dto.js";
import type { EvidenceRef } from "../../pipeline/schema.js";

function toIngredientDto(row: {
  id: string;
  canonical_name: string;
  quantity_value: number | null;
  quantity_unit: string | null;
  raw_text: string | null;
  is_pantry_staple: boolean;
  evidence_json: unknown[];
}): IngredientDto {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    quantityValue: row.quantity_value,
    quantityUnit: row.quantity_unit,
    rawText: row.raw_text,
    isPantryStaple: row.is_pantry_staple,
    evidence: row.evidence_json as EvidenceRef[],
  };
}

/** Apply an edit to an existing ingredient: quantity fields (only those
 * present in the request), `markOwned` → `is_pantry_staple = true`, or a
 * `remove: true` delete (cascades to its product_match row via FK). Throws
 * `notFound("ingredient")` if the row doesn't exist (or was already removed
 * by this same call). */
export async function editIngredient(
  ingredientId: string,
  edit: IngredientEditRequest,
): Promise<IngredientDto | null> {
  const db = getDb();

  if (edit.remove) {
    const deleted = await db
      .deleteFrom("ingredients")
      .where("id", "=", ingredientId)
      .returningAll()
      .executeTakeFirst();
    if (!deleted) throw notFound("ingredient");
    return null;
  }

  const patch: Record<string, unknown> = {};
  if ("quantityValue" in edit) patch.quantity_value = edit.quantityValue;
  if ("quantityUnit" in edit) patch.quantity_unit = edit.quantityUnit;
  if (edit.markOwned) patch.is_pantry_staple = true;

  const row =
    Object.keys(patch).length > 0
      ? await db
          .updateTable("ingredients")
          .set(patch)
          .where("id", "=", ingredientId)
          .returningAll()
          .executeTakeFirst()
      : await db
          .selectFrom("ingredients")
          .selectAll()
          .where("id", "=", ingredientId)
          .executeTakeFirst();

  if (!row) throw notFound("ingredient");
  return toIngredientDto(row);
}

/** Manually add an ingredient to a recipe. Per the Phase 3 plan's locked
 * decision, manual adds are inserted UNMATCHED — no product_matches row is
 * created here; that happens later via the matches endpoints. */
export async function addIngredient(
  recipeId: string,
  input: { canonicalName: string; quantityValue?: number; quantityUnit?: string },
): Promise<IngredientDto> {
  const db = getDb();
  const id = crypto.randomUUID();
  const row = await db
    .insertInto("ingredients")
    .values({
      id,
      recipe_id: recipeId,
      canonical_name: input.canonicalName,
      quantity_value: input.quantityValue ?? null,
      quantity_unit: input.quantityUnit ?? null,
      raw_text: null,
      is_pantry_staple: false,
      evidence_json: JSON.stringify([]),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toIngredientDto(row);
}

/** Delete an ingredient outright (used by DELETE-flavored call sites; the
 * PATCH `remove: true` path above covers the route contract, this is the
 * same operation exposed as its own function for a clearer test/service
 * surface). */
export async function removeIngredient(ingredientId: string): Promise<void> {
  const deleted = await getDb()
    .deleteFrom("ingredients")
    .where("id", "=", ingredientId)
    .returningAll()
    .executeTakeFirst();
  if (!deleted) throw notFound("ingredient");
}
