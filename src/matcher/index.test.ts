import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Ingredient } from "../pipeline/schema.js";
import type { KrogerProduct, KrogerProductSearchResponse } from "../kroger/types.js";

vi.mock("../kroger/auth.js", () => ({
  getAppToken: vi.fn(),
}));
vi.mock("../kroger/client.js", () => ({
  searchProducts: vi.fn(),
}));

const dbRows: Record<string, unknown> = {};
const preparedRun = vi.fn();
const preparedGet = vi.fn();
const preparedAll = vi.fn();
vi.mock("../platform/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: preparedRun, get: preparedGet, all: preparedAll })),
  })),
}));

const { getAppToken } = await import("../kroger/auth.js");
const { searchProducts } = await import("../kroger/client.js");
const { matchIngredient, matchRecipe, matchRecipeAndPersist, renderMatchesTable } =
  await import("./index.js");

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    canonical_name_en: { value: "heavy cream", evidence: [{ source_type: "caption" }] },
    raw_text: "1 cup heavy cream",
    quantity: { value: 1, unit: "cup", raw_text: "1 cup" },
    is_pantry_staple: false,
    ...overrides,
  } as Ingredient;
}

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

beforeEach(() => {
  vi.restoreAllMocks();
  dbRows.recipeId = undefined;
  preparedRun.mockReset();
  preparedGet.mockReset();
  preparedAll.mockReset();
});

describe("matchIngredient", () => {
  it("ranks, excludes out-of-stock items, and returns candidates", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product(),
        product({
          productId: "oos",
          upc: "oos",
          description: "Kroger Heavy Whipping Cream (Large)",
          items: [
            {
              itemId: "2",
              inventory: { stockLevel: "TEMPORARILY_OUT_OF_STOCK" },
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 5.99 },
              size: "32 fl oz",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "irrelevant",
          upc: "irrelevant",
          description: "Frozen Waffles",
          items: [
            {
              itemId: "3",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 4.99 },
              size: "12 oz",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 3 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.productId).toBe("0001111041700");
    expect(result.deprioritized).toBe(false);
  });

  it("marks pantry staples as deprioritized but still matches them", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [product()],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({ is_pantry_staple: true }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.deprioritized).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("falls back to raw_text and requires approval when canonical name is null", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [product()],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: null, null_reason: "unclear from ASR" },
        raw_text: "some heavy cream",
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.canonicalName).toBe("some heavy cream");
    expect(result.requiresApproval).toBe(true);
    expect(searchProducts).toHaveBeenCalledWith("some heavy cream", "01100002", "tok", 10);
  });

  it("requires approval when no candidates are found", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { pagination: { start: 0, limit: 10, total: 0 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");
    expect(result.candidates).toHaveLength(0);
    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval when the top two candidates are closely scored", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({ productId: "a", upc: "a", description: "Kroger Heavy Whipping Cream" }),
        product({ productId: "b", upc: "b", description: "Kroger Heavy Whipping Cream" }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/closely matched/);
  });

  it("does not crash and requires approval when search throws", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/network down/);
  });
});

describe("matchRecipe", () => {
  it("gets one token and reuses it across all ingredients", async () => {
    (getAppToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "tok",
      expires_in: 1800,
      token_type: "bearer",
    });
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [product()],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const results = await matchRecipe(
      [ingredient(), ingredient({ raw_text: "2 cups cream" })],
      "01100002",
    );

    expect(getAppToken).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]!.ingredientId).toBe("ing-0");
    expect(results[1]!.ingredientId).toBe("ing-1");
  });
});

describe("matchRecipeAndPersist", () => {
  it("reads ingredient rows, matches, and upserts product_matches", async () => {
    (getAppToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "tok",
      expires_in: 1800,
      token_type: "bearer",
    });
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [product()],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    preparedAll.mockReturnValue([
      {
        id: "ingredient-1",
        canonical_name: "heavy cream",
        quantity_value: 1,
        quantity_unit: "cup",
        raw_text: "1 cup heavy cream",
        is_pantry_staple: 0,
      },
    ]);
    preparedGet.mockReturnValue(undefined); // no existing product_matches row

    const results = await matchRecipeAndPersist("recipe-1", "01100002");

    expect(results).toHaveLength(1);
    expect(results[0]!.ingredientId).toBe("ingredient-1");
    expect(preparedRun).toHaveBeenCalled(); // insert happened
  });
});

describe("renderMatchesTable", () => {
  it("renders a readable table with headers and one row per ingredient", () => {
    const table = renderMatchesTable([
      {
        ingredientId: "ing-0",
        canonicalName: "heavy cream",
        candidates: [
          {
            productId: "1",
            upc: "1",
            name: "Kroger Heavy Whipping Cream",
            brand: "Kroger",
            price: 3.49,
            size: "16 fl oz",
            rankScore: 10,
          },
        ],
        requiresApproval: false,
        deprioritized: false,
      },
      {
        ingredientId: "ing-1",
        canonicalName: "salt",
        candidates: [],
        requiresApproval: true,
        approvalReason: "no in-stock candidates found",
        deprioritized: true,
      },
    ]);

    expect(table).toContain("Ingredient");
    expect(table).toContain("heavy cream");
    expect(table).toContain("$3.49");
    expect(table).toContain("salt (pantry)");
    expect(table).toContain("(no match)");
  });
});
