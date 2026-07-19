import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { updateMatchSelection, selectMatch, skipMatch } from "./match_edits.js";

const RECIPE_ID = "11111111-1111-1111-1111-111111111111";
const INGREDIENT_ID = "22222222-2222-2222-2222-222222222222";
const MATCH_ID = "33333333-3333-3333-3333-333333333333";

async function seedRecipeIngredientMatch(): Promise<void> {
  const db = getDb();
  await db
    .insertInto("recipes")
    .values({
      id: RECIPE_ID,
      source_url: "https://x",
      extraction_version: "v1",
      status: "extracted",
      recipe_json: JSON.stringify({}),
    })
    .execute();
  await db
    .insertInto("ingredients")
    .values({
      id: INGREDIENT_ID,
      recipe_id: RECIPE_ID,
      canonical_name: "heavy cream",
      quantity_value: 1,
      quantity_unit: "cup",
      raw_text: "1 cup heavy cream",
      is_pantry_staple: false,
      evidence_json: JSON.stringify([]),
    })
    .execute();
  await db
    .insertInto("product_matches")
    .values({
      id: MATCH_ID,
      ingredient_id: INGREDIENT_ID,
      candidates_json: JSON.stringify([
        { productId: "p1", upc: "u1", name: "Cream A", price: 3.5, size: "16 fl oz", rankScore: 1, quantityToOrder: 1 },
      ]),
      selected_product_id: null,
      requires_approval: true,
      approval_reason: "ambiguous match",
      is_approved: false,
    })
    .execute();
}

describe("match_edits", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRecipeIngredientMatch();
  });

  describe("updateMatchSelection", () => {
    it("selects a candidate and marks the match approved", async () => {
      const result = await updateMatchSelection(INGREDIENT_ID, "p1");
      expect(result).toEqual(
        expect.objectContaining({
          ingredientId: INGREDIENT_ID,
          selectedProductId: "p1",
          isApproved: true,
        }),
      );

      const row = await getDb()
        .selectFrom("product_matches")
        .selectAll()
        .where("ingredient_id", "=", INGREDIENT_ID)
        .executeTakeFirstOrThrow();
      expect(row.selected_product_id).toBe("p1");
      expect(row.is_approved).toBe(true);
    });

    it("skips (clears selection, unapproves) when selectedProductId is null", async () => {
      await updateMatchSelection(INGREDIENT_ID, "p1");
      const result = await updateMatchSelection(INGREDIENT_ID, null);
      expect(result.selectedProductId).toBeNull();
      expect(result.isApproved).toBe(false);

      const row = await getDb()
        .selectFrom("product_matches")
        .selectAll()
        .where("ingredient_id", "=", INGREDIENT_ID)
        .executeTakeFirstOrThrow();
      expect(row.selected_product_id).toBeNull();
      expect(row.is_approved).toBe(false);
    });

    it("throws notFound when the ingredient has no product_matches row", async () => {
      await expect(
        updateMatchSelection("00000000-0000-0000-0000-000000000000", "p1"),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("selectMatch / skipMatch convenience wrappers", () => {
    it("selectMatch picks a product", async () => {
      const result = await selectMatch(INGREDIENT_ID, "p1");
      expect(result.selectedProductId).toBe("p1");
      expect(result.isApproved).toBe(true);
    });

    it("skipMatch clears the selection", async () => {
      await selectMatch(INGREDIENT_ID, "p1");
      const result = await skipMatch(INGREDIENT_ID);
      expect(result.selectedProductId).toBeNull();
      expect(result.isApproved).toBe(false);
    });
  });
});
