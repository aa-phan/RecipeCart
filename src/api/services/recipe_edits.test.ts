import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { editIngredient, addIngredient, removeIngredient } from "./recipe_edits.js";

const RECIPE_ID = "11111111-1111-1111-1111-111111111111";
const INGREDIENT_ID = "22222222-2222-2222-2222-222222222222";

async function seedRecipeWithIngredient(): Promise<void> {
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
}

describe("recipe_edits", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRecipeWithIngredient();
  });

  describe("editIngredient", () => {
    it("updates quantity fields present in the request", async () => {
      const result = await editIngredient(INGREDIENT_ID, {
        quantityValue: 2,
        quantityUnit: "tbsp",
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: INGREDIENT_ID,
          quantityValue: 2,
          quantityUnit: "tbsp",
        }),
      );
    });

    it("leaves fields not present in the request untouched", async () => {
      const result = await editIngredient(INGREDIENT_ID, { markOwned: true });
      expect(result).toEqual(
        expect.objectContaining({
          quantityValue: 1,
          quantityUnit: "cup",
          isPantryStaple: true,
        }),
      );
    });

    it("marks an ingredient as owned via is_pantry_staple", async () => {
      await editIngredient(INGREDIENT_ID, { markOwned: true });
      const row = await getDb()
        .selectFrom("ingredients")
        .selectAll()
        .where("id", "=", INGREDIENT_ID)
        .executeTakeFirstOrThrow();
      expect(row.is_pantry_staple).toBe(true);
    });

    it("removes the ingredient when remove: true, cascading to product_matches", async () => {
      await getDb()
        .insertInto("product_matches")
        .values({
          id: "33333333-3333-3333-3333-333333333333",
          ingredient_id: INGREDIENT_ID,
          candidates_json: JSON.stringify([]),
          selected_product_id: null,
        })
        .execute();

      const result = await editIngredient(INGREDIENT_ID, { remove: true });
      expect(result).toBeNull();

      const ingredientRow = await getDb()
        .selectFrom("ingredients")
        .selectAll()
        .where("id", "=", INGREDIENT_ID)
        .executeTakeFirst();
      expect(ingredientRow).toBeUndefined();

      const matchRow = await getDb()
        .selectFrom("product_matches")
        .selectAll()
        .where("ingredient_id", "=", INGREDIENT_ID)
        .executeTakeFirst();
      expect(matchRow).toBeUndefined();
    });

    it("throws notFound for a nonexistent ingredient", async () => {
      await expect(
        editIngredient("00000000-0000-0000-0000-000000000000", { quantityValue: 5 }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("addIngredient", () => {
    it("inserts a new unmatched ingredient row", async () => {
      const result = await addIngredient(RECIPE_ID, {
        canonicalName: "garlic",
        quantityValue: 3,
        quantityUnit: "cloves",
      });
      expect(result).toEqual(
        expect.objectContaining({
          canonicalName: "garlic",
          quantityValue: 3,
          quantityUnit: "cloves",
          isPantryStaple: false,
          evidence: [],
        }),
      );

      const matchRow = await getDb()
        .selectFrom("product_matches")
        .selectAll()
        .where("ingredient_id", "=", result.id)
        .executeTakeFirst();
      expect(matchRow).toBeUndefined();
    });
  });

  describe("removeIngredient", () => {
    it("deletes the ingredient row", async () => {
      await removeIngredient(INGREDIENT_ID);
      const row = await getDb()
        .selectFrom("ingredients")
        .selectAll()
        .where("id", "=", INGREDIENT_ID)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("throws notFound for a nonexistent ingredient", async () => {
      await expect(removeIngredient("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });
});
