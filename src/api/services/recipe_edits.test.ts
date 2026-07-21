import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDb } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import type { KrogerProduct } from "../../kroger/types.js";

vi.mock("../../kroger/auth.js", () => ({
  getAppToken: vi.fn(),
}));
vi.mock("../../kroger/client.js", () => ({
  searchProducts: vi.fn(),
}));
vi.mock("../../kroger/store_config.js", () => ({
  loadStoreLocation: vi.fn(),
}));
vi.mock("../../matcher/materiality.js", () => ({
  judgeMateriality: vi.fn().mockResolvedValue(new Map()),
}));

const { getAppToken } = await import("../../kroger/auth.js");
const { searchProducts } = await import("../../kroger/client.js");
const { loadStoreLocation } = await import("../../kroger/store_config.js");
const { editIngredient, addIngredient, removeIngredient } = await import("./recipe_edits.js");

const RECIPE_ID = "11111111-1111-1111-1111-111111111111";
const INGREDIENT_ID = "22222222-2222-2222-2222-222222222222";

function product(overrides: Partial<KrogerProduct> = {}): KrogerProduct {
  return {
    productId: "0001111041700",
    upc: "0001111041700",
    productPageURI: "/p/x",
    description: "Kroger Heavy Whipping Cream",
    brand: "Kroger",
    categories: ["Dairy"],
    aisleLocations: [],
    items: [
      {
        itemId: "1",
        fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
        price: { regular: 3.49 },
        size: "16 fl oz",
        soldBy: "UNIT",
      },
    ],
    ...overrides,
  } as KrogerProduct;
}

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
      confidence: "medium",
    })
    .execute();
}

describe("recipe_edits", () => {
  beforeEach(async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockReset();
    (getAppToken as ReturnType<typeof vi.fn>).mockReset();
    (loadStoreLocation as ReturnType<typeof vi.fn>).mockReset();
    (loadStoreLocation as ReturnType<typeof vi.fn>).mockReturnValue(null); // no re-match unless a test opts in
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

    // PRD C1 §21: the DTO must carry the persisted confidence band through so
    // Review can render ConfidenceBadge for real (non-"amount unclear")
    // confidence, not just derive it from a column edit not touching it.
    it("carries the ingredient's confidence band through in the DTO", async () => {
      const result = await editIngredient(INGREDIENT_ID, { markOwned: true });
      expect(result).toEqual(expect.objectContaining({ confidence: "medium" }));
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

    describe("amount-edit re-match (Phase 5 Slice 3)", () => {
      beforeEach(async () => {
        await getDb()
          .insertInto("product_matches")
          .values({
            id: "33333333-3333-3333-3333-333333333333",
            ingredient_id: INGREDIENT_ID,
            candidates_json: JSON.stringify([]),
            selected_product_id: null,
          })
          .execute();
        (loadStoreLocation as ReturnType<typeof vi.fn>).mockReturnValue({
          locationId: "01100002",
          name: "Test Store",
          zipCode: "75201",
        });
        (getAppToken as ReturnType<typeof vi.fn>).mockResolvedValue({ access_token: "tok" });
      });

      it("re-matches and returns a fresh, pre-selected match when quantity actually changes", async () => {
        (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
          data: [product()],
        });

        const result = await editIngredient(INGREDIENT_ID, { quantityValue: 2, quantityUnit: "cup" });

        expect(searchProducts).toHaveBeenCalled();
        expect(result?.match).toBeDefined();
        expect(result?.match?.candidates).toHaveLength(1);
        // A single unambiguous candidate is confident (requiresApproval false)
        // — per the Slice 1 pre-selection fix, a fresh re-match pre-selects it.
        expect(result?.match?.isApproved).toBe(true);
        expect(result?.match?.selectedProductId).toBe("0001111041700");
      });

      it("does not re-match when the edit doesn't change quantity/unit", async () => {
        await editIngredient(INGREDIENT_ID, { markOwned: true });
        expect(searchProducts).not.toHaveBeenCalled();
      });

      it("does not re-match when the new quantity equals the existing one", async () => {
        await editIngredient(INGREDIENT_ID, { quantityValue: 1, quantityUnit: "cup" });
        expect(searchProducts).not.toHaveBeenCalled();
      });

      it("saves the edit but omits match when no store is configured", async () => {
        (loadStoreLocation as ReturnType<typeof vi.fn>).mockReturnValue(null);
        const result = await editIngredient(INGREDIENT_ID, { quantityValue: 3 });
        expect(result).toEqual(expect.objectContaining({ quantityValue: 3 }));
        expect(result?.match).toBeUndefined();
        expect(searchProducts).not.toHaveBeenCalled();
      });

      it("saves the edit but omits match when the ingredient was never matched", async () => {
        await getDb()
          .deleteFrom("product_matches")
          .where("ingredient_id", "=", INGREDIENT_ID)
          .execute();
        const result = await editIngredient(INGREDIENT_ID, { quantityValue: 3 });
        expect(result).toEqual(expect.objectContaining({ quantityValue: 3 }));
        expect(result?.match).toBeUndefined();
        expect(searchProducts).not.toHaveBeenCalled();
      });

      it("saves the edit and surfaces a flagged, empty match when Kroger search itself fails", async () => {
        // matchIngredient (matcher/index.ts) is fail-safe on a search error —
        // it returns a degraded, requires-approval match rather than
        // throwing, mirroring the same "when in doubt, flag it" philosophy
        // as the materiality pass. rematchIngredient's own try/catch exists
        // for errors outside matchIngredient itself (e.g. a DB write
        // failure), not this path — so the amount edit is saved and the
        // (empty, flagged) match still comes back, not omitted.
        (searchProducts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Kroger down"));
        const result = await editIngredient(INGREDIENT_ID, { quantityValue: 3 });
        expect(result).toEqual(expect.objectContaining({ quantityValue: 3 }));
        expect(result?.match?.candidates).toEqual([]);
        expect(result?.match?.requiresApproval).toBe(true);
        expect(result?.match?.isApproved).toBe(false);
      });
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

      // Manually-added ingredients never went through extraction, so there's
      // no confidence band for Claude to have produced — the DTO field must
      // be omitted (undefined), not a fabricated value.
      expect(result.confidence).toBeUndefined();
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
