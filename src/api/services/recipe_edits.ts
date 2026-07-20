// Ingredient mutation logic for the recipes API (Phase 3, B1 slice). Kept
// out of routes/recipes.ts so the route handlers stay thin dispatchers and
// this DB logic has a directly-testable home (mirrors matcher/index.ts's
// "service function over real Postgres" pattern).
import crypto from "node:crypto";
import { getDb } from "../../platform/database.js";
import { notFound } from "../lib/errors.js";
import type { IngredientDto, IngredientEditRequest, MatchDto } from "../lib/dto.js";
import type { EvidenceRef } from "../../pipeline/schema.js";
import { rematchIngredient } from "../../matcher/index.js";
import { loadStoreLocation } from "../../kroger/store_config.js";
import { loadPreferences } from "../routes/preferences.js";
import { toMatchDto } from "./match_edits.js";
import { logger } from "../../platform/logger.js";

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

/** Response shape for a successful (non-remove) `editIngredient` call: the
 * updated ingredient, plus — only when the edit actually changed the
 * quantity/unit and a re-match was run — the fresh `MatchDto` for that same
 * ingredient, so the frontend can update one card's product dropdown
 * without a full recipe reload. `match` is omitted (not merely undefined-y)
 * when no re-match ran, e.g. a markOwned-only edit or a manually-added
 * ingredient that was never matched in the first place. */
export type IngredientEditResult = IngredientDto & { match?: MatchDto };

/** Apply an edit to an existing ingredient: quantity fields (only those
 * present in the request), `markOwned` → `is_pantry_staple = true`, or a
 * `remove: true` delete (cascades to its product_match row via FK). Throws
 * `notFound("ingredient")` if the row doesn't exist (or was already removed
 * by this same call).
 *
 * Amount re-match (Phase 5 Slice 3): when the request actually changes
 * `quantityValue` and/or `quantityUnit` (compared to the row's PRIOR
 * values — a no-op edit that just re-sends the same amount doesn't trigger
 * this), product matching is re-driven for this one ingredient so the
 * picker reflects a product choice appropriate to the NEW amount rather
 * than sitting inert. See `rematchIngredient`'s doc (matcher/index.ts) for
 * why this deliberately does NOT preserve a prior user selection the way a
 * routine staleness refresh does — the old selection was for a different
 * quantity and may not even cover the new one. Degrades gracefully (edit
 * still saved, `match` simply omitted) when there's no store configured yet
 * or the ingredient has no existing product_matches row to begin with
 * (manually-added ingredients start unmatched). A re-match failure (e.g.
 * Kroger API outage) is logged and swallowed for the same reason — the
 * user's amount edit must not be lost just because the live re-match
 * couldn't complete. */
export async function editIngredient(
  ingredientId: string,
  edit: IngredientEditRequest,
): Promise<IngredientEditResult | null> {
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

  const quantityEdited = "quantityValue" in edit || "quantityUnit" in edit;
  const before = quantityEdited
    ? await db
        .selectFrom("ingredients")
        .select(["quantity_value", "quantity_unit"])
        .where("id", "=", ingredientId)
        .executeTakeFirst()
    : undefined;

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
  const dto = toIngredientDto(row);

  const quantityActuallyChanged =
    quantityEdited &&
    before !== undefined &&
    (before.quantity_value !== row.quantity_value || before.quantity_unit !== row.quantity_unit);
  if (!quantityActuallyChanged) return dto;

  const store = loadStoreLocation();
  if (!store) return dto; // no store configured — nothing to match against yet

  const hasExistingMatch = await db
    .selectFrom("product_matches")
    .select("id")
    .where("ingredient_id", "=", ingredientId)
    .executeTakeFirst();
  if (!hasExistingMatch) return dto; // never matched (e.g. manual add) — nothing to re-drive

  try {
    // Same single-slot fetch pattern as loadStoreLocation above — wires the
    // Preferences screen's saved settings into this re-match too (Phase 5).
    const preferences = await loadPreferences();
    await rematchIngredient(ingredientId, store.locationId, { preferences });
  } catch (err) {
    logger.error("editIngredient: re-match after amount edit failed", {
      ingredientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return dto;
  }

  const matchRow = await db
    .selectFrom("product_matches")
    .selectAll()
    .where("ingredient_id", "=", ingredientId)
    .executeTakeFirst();
  return matchRow ? { ...dto, match: toMatchDto(matchRow) } : dto;
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
