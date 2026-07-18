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
  (searchProducts as ReturnType<typeof vi.fn>).mockReset();
  (getAppToken as ReturnType<typeof vi.fn>).mockReset();
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
    expect(searchProducts).toHaveBeenCalledWith("some heavy cream", "01100002", "tok", 50);
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

  it("auto-resolves a genuine tie (identical size and price) deterministically rather than requiring approval", async () => {
    // Both candidates fully cover the 1-cup need at the same size/price —
    // there's nothing to actually decide between them, so this should
    // resolve rather than block (same philosophy as the seasoning/
    // no-quantity default: a real tie means the choice doesn't matter).
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({ productId: "a", upc: "a", description: "Kroger Heavy Whipping Cream" }),
        product({ productId: "b", upc: "b", description: "Kroger Heavy Whipping Cream" }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");
    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.productId).toBe("a");
  });

  it("auto-resolves by buying multiple packages when one alone doesn't cover the need", async () => {
    // Needs 800g of chicken breast; only 1 lb (453.6g) packages are
    // available — buying 2 covers it (906g, 113% of need), which is the
    // normal "closest-over" outcome, not something that needs a human.
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "a",
          upc: "a",
          description: "Kroger Chicken Breast",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 5.0 },
              size: "1 lb",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "chicken breast", evidence: [{ source_type: "caption" }] },
        raw_text: "800g chicken breast",
        quantity: { value: 800, unit: "g", raw_text: "800g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.quantityToOrder).toBe(2);
  });

  it("prefers a better name match over a numerically tighter multi-package fit", async () => {
    // Real regression found via live data: "Kroger Shaved Chicken" (10oz,
    // deli-style — "breast" doesn't appear anywhere in its name) needs 3
    // units to reach 106% of the 800g need; real "Chicken Breast" (1lb)
    // needs 2 units to reach 113%. Ranking on fit-tightness alone picked
    // the deli product purely because 106% is numerically closer to 100%
    // than 113% — text relevance must win this, since "chicken breast" is
    // an unambiguously better name match than "shaved chicken."
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "shaved",
          upc: "shaved",
          description: "Kroger Shaved Chicken",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 4.99 },
              size: "10 oz",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "real",
          upc: "real",
          description: "Heritage Farm Boneless Skinless Chicken Breasts",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 2.69 },
              size: "1 lb",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "chicken breast", evidence: [{ source_type: "caption" }] },
        raw_text: "800g chicken breast",
        quantity: { value: 800, unit: "g", raw_text: "800g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.productId).toBe("real");
  });

  it("requires approval when no reasonable purchase (even multiple packages) covers the needed quantity", async () => {
    // Needs 5000g of chicken breast from only 1 lb packages — 12+ units
    // exceeds the auto-purchase cap, so this genuinely needs a human rather
    // than silently generating an oddly large cart line.
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "a",
          upc: "a",
          description: "Kroger Chicken Breast",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 5.0 },
              size: "1 lb",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "chicken breast", evidence: [{ source_type: "caption" }] },
        raw_text: "5000g chicken breast",
        quantity: { value: 5000, unit: "g", raw_text: "5000g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/no reasonable purchase covers/);
  });

  it("falls back to a broadened search when even multi-buy can't cover the need, but still flags the result for approval", async () => {
    // Real case: "garlic & herb cream cheese" (1000g needed — enough that
    // even buying multiple 7.5oz packages exceeds the auto-purchase cap)
    // has no in-stock package under its own name that reasonably covers it,
    // but a larger, covering-size alternative turns up under a broadened
    // query ("garlic & herb cream") — it should now be found and surfaced,
    // but NOT silently auto-approved, since it's a different-named product
    // (Spec 3 §2.2: materiality is Claude-delegated, not this deterministic
    // ranking's call to make alone).
    (searchProducts as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: [
          product({
            productId: "small",
            upc: "small",
            description: "Philadelphia Garlic & Herb Cream Cheese",
            items: [
              {
                itemId: "1",
                fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
                price: { regular: 4.39 },
                size: "7.5 oz",
                soldBy: "UNIT",
              },
            ],
          }),
        ],
        meta: { pagination: { start: 0, limit: 10, total: 1 } },
      } satisfies KrogerProductSearchResponse)
      .mockResolvedValueOnce({
        data: [
          product({
            productId: "alt",
            upc: "alt",
            description: "President Rondelé Creamy Whipped Garlic & Herbs Spreadable Cheese",
            items: [
              {
                itemId: "1",
                fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
                price: { regular: 5.99 },
                size: "16 oz",
                soldBy: "UNIT",
              },
            ],
          }),
        ],
        meta: { pagination: { start: 0, limit: 10, total: 1 } },
      } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: {
          value: "garlic & herb cream cheese",
          evidence: [{ source_type: "caption" }],
        },
        raw_text: "1000g garlic & herb cream cheese",
        quantity: { value: 1000, unit: "g", raw_text: "1000g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(searchProducts).toHaveBeenNthCalledWith(
      2,
      "garlic & herb cream",
      "01100002",
      "tok",
      50,
    );
    expect(result.candidates[0]!.productId).toBe("alt");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/found via a broadened search/);
  });

  it("does not attempt a broadened search when the specific-name search already covers the need", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "covers",
          upc: "covers",
          description: "Kroger Garlic & Herb Cream Cheese",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 4.99 },
              size: "16 oz",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: {
          value: "garlic & herb cream cheese",
          evidence: [{ source_type: "caption" }],
        },
        raw_text: "250g garlic & herb cream cheese",
        quantity: { value: 250, unit: "g", raw_text: "250g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(searchProducts).toHaveBeenCalledTimes(1);
    expect(result.requiresApproval).toBe(false);
  });

  it("broadens the search when the specific-name search returns zero results outright (core ingredient)", async () => {
    // Real case: Kroger's own search API returned 0 results for "Light
    // Garlic & Herb Cream Cheese" (verbatim from a caption) — dropping just
    // "Light" found real candidates for the same underlying product. This
    // is a completely empty primary result set, not "found some candidates
    // but none cover the need" — a distinct trigger from the multi-buy test
    // above.
    (searchProducts as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: [],
        meta: { pagination: { start: 0, limit: 10, total: 0 } },
      } satisfies KrogerProductSearchResponse)
      .mockResolvedValueOnce({
        data: [
          product({
            productId: "found-via-broadening",
            upc: "found-via-broadening",
            description: "Philadelphia Garlic & Herb Cream Cheese",
            items: [
              {
                itemId: "1",
                fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
                price: { regular: 4.39 },
                size: "16 oz",
                soldBy: "UNIT",
              },
            ],
          }),
        ],
        meta: { pagination: { start: 0, limit: 10, total: 1 } },
      } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: {
          value: "Light Garlic & Herb Cream Cheese",
          evidence: [{ source_type: "caption" }],
        },
        raw_text: "250g Light Garlic & Herb Cream Cheese",
        quantity: { value: 250, unit: "g", raw_text: "250g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(searchProducts).toHaveBeenNthCalledWith(
      2,
      "Light Garlic & Herb Cream Cheese".split(" ").slice(0, -1).join(" "),
      "01100002",
      "tok",
      50,
    );
    expect(result.candidates[0]!.productId).toBe("found-via-broadening");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/found via a broadened search/);
  });

  it("broadens the search when a seasoning's specific-name search returns zero results, still flagging materiality", async () => {
    // Same zero-result trigger, but for a seasoning (useSmallestPackageDefault
    // path) — confirms that branch also checks fromBroadenedSearch rather
    // than always auto-resolving once broadening is extended to fire there.
    (searchProducts as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: [],
        meta: { pagination: { start: 0, limit: 10, total: 0 } },
      } satisfies KrogerProductSearchResponse)
      .mockResolvedValueOnce({
        data: [
          product({
            productId: "seasoning-via-broadening",
            upc: "seasoning-via-broadening",
            description: "Kroger Smoked Paprika",
            items: [
              {
                itemId: "1",
                fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
                price: { regular: 2.99 },
                size: "2 oz",
                soldBy: "UNIT",
              },
            ],
          }),
        ],
        meta: { pagination: { start: 0, limit: 10, total: 1 } },
      } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: {
          value: "Fancy Smoked Paprika",
          evidence: [{ source_type: "caption" }],
        },
        raw_text: "1 tsp Fancy Smoked Paprika",
        quantity: { value: 1, unit: "tsp", raw_text: "1 tsp" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]!.productId).toBe("seasoning-via-broadening");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/found via a broadened search/);
  });

  it("falls back to the text-score + margin check when quantity is stated but unparseable", async () => {
    // "2 knobs" of butter — a real quantity value, but "knob" isn't a
    // recognized unit, so quantityFitScore can never produce a fit for any
    // candidate here; must fall back to the old margin-based check rather
    // than silently defaulting to smallest-package (which is reserved for
    // genuinely no-quantity/seasoning cases).
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({ productId: "a", upc: "a", description: "Kroger Butter" }),
        product({ productId: "b", upc: "b", description: "Kroger Butter" }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "butter", evidence: [{ source_type: "caption" }] },
        raw_text: "2 knobs butter",
        quantity: { value: 2, unit: "knob", raw_text: "2 knobs" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/closely matched/);
  });

  it("does not crash and requires approval when search throws", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const result = await matchIngredient(ingredient(), "ing-1", "01100002", "tok");
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReason).toMatch(/network down/);
  });

  it("defaults to the cheapest well-matched product (NOT the physically smallest) when no quantity is stated", async () => {
    // The physically larger package is cheaper — cheapest-price must win,
    // proving the default is price-driven, not smallest-size-driven (which
    // previously picked absurd tiny specialty items).
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "big-cheap",
          upc: "big-cheap",
          description: "Kroger Heavy Whipping Cream (Large)",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 3.49 },
              size: "32 fl oz",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "small-pricey",
          upc: "small-pricey",
          description: "Kroger Heavy Whipping Cream (Small)",
          items: [
            {
              itemId: "2",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 5.99 },
              size: "8 fl oz",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({ quantity: { value: null, unit: null, raw_text: "a splash" } }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.productId).toBe("big-cheap");
    expect(result.candidates[0]!.reason).toMatch(/no quantity stated/);
  });

  it("excludes items that are out of stock or have no available fulfillment method", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "nofulfill",
          upc: "nofulfill",
          description: "Kroger Heavy Whipping Cream (No Fulfillment)",
          items: [
            {
              itemId: "1",
              inventory: { stockLevel: "HIGH" },
              // all four false — reported in stock, but not orderable anywhere
              fulfillment: { curbside: false, delivery: false, inStore: false, shipToHome: false },
              price: { regular: 1.99 },
              size: "16 fl oz",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "orderable",
          upc: "orderable",
          description: "Kroger Heavy Whipping Cream",
          items: [
            {
              itemId: "2",
              fulfillment: { curbside: true, delivery: false, inStore: false, shipToHome: false },
              price: { regular: 3.49 },
              size: "16 fl oz",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({ quantity: { value: null, unit: null, raw_text: "a splash" } }),
      "ing-1",
      "01100002",
      "tok",
    );

    // The cheaper no-fulfillment item must not win — or even appear.
    expect(result.candidates.map((c) => c.productId)).toEqual(["orderable"]);
  });

  it("prefers a plain product over a prepared/pre-flavored one of the same base ingredient", async () => {
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "seasoned",
          upc: "seasoned",
          description: "El Rey Achiote Seasoned Boneless Chicken Thighs",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 3.0 }, // cheaper — must still lose to the plain one
              size: "1 lb",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "plain",
          upc: "plain",
          description: "Kroger Frozen Raw Boneless Skinless Chicken Thighs",
          items: [
            {
              itemId: "2",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 3.99 },
              size: "3 lb",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: {
          value: "boneless chicken thighs",
          evidence: [{ source_type: "caption" }],
        },
        raw_text: "800g boneless chicken thighs",
        quantity: { value: 800, unit: "g", raw_text: "800g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.candidates[0]!.productId).toBe("plain");
  });

  it("orders one variable-weight package (qty 1) for a WEIGHT-sold item instead of multiplying its price-basis size", async () => {
    // "1 lb" on a WEIGHT-sold item is a price-per-lb basis, not the package
    // size — must NOT become "buy 2" of an 800g need.
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "weightcut",
          upc: "weightcut",
          description: "Heritage Farm Boneless Skinless Chicken Breasts",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 2.69 },
              size: "1 lb",
              soldBy: "WEIGHT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 1 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "chicken breast", evidence: [{ source_type: "caption" }] },
        raw_text: "800g chicken breast",
        quantity: { value: 800, unit: "g", raw_text: "800g" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );
    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.quantityToOrder).toBe(1);
    expect(result.candidates[0]!.reason).toMatch(/sold by weight/);
  });

  it("routes a known seasoning to the cheapest well-matched product even with a real stated quantity", async () => {
    // The physically LARGER pack ("big", 48oz) is the cheapest — it must win
    // for a seasoning, proving seasonings default to cheapest price, not
    // smallest package (which previously picked tiny specialty items).
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        product({
          productId: "big",
          upc: "big",
          description: "Kroger Iodized Salt (Large)",
          items: [
            {
              itemId: "1",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 0.99 },
              size: "48 oz",
              soldBy: "UNIT",
            },
          ],
        }),
        product({
          productId: "small-specialty",
          upc: "small-specialty",
          description: "Kroger Iodized Salt (Small)",
          items: [
            {
              itemId: "2",
              fulfillment: { curbside: true, delivery: true, inStore: true, shipToHome: false },
              price: { regular: 3.29 },
              size: "1.75 oz",
              soldBy: "UNIT",
            },
          ],
        }),
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    } satisfies KrogerProductSearchResponse);

    const result = await matchIngredient(
      ingredient({
        canonical_name_en: { value: "salt", evidence: [{ source_type: "caption" }] },
        raw_text: "3 tsp salt",
        quantity: { value: 3, unit: "tsp", raw_text: "3 tsp" },
      }),
      "ing-1",
      "01100002",
      "tok",
    );

    expect(result.requiresApproval).toBe(false);
    expect(result.candidates[0]!.productId).toBe("big");
    expect(result.candidates[0]!.reason).toMatch(/seasoning/);
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
            quantityToOrder: 1,
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
