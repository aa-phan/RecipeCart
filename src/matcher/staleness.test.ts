import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDb } from "../platform/database.js";
import { resetDb } from "../platform/test-db.js";

// Real Postgres (resetDb()) — isMatchStale/refreshIfStale's correctness
// hinges on real timestamptz semantics, not a mock that doesn't interpret
// dates at all. (The old sqlite-string UTC-parse bug this test used to guard
// against — parseSqliteUtcDatetime — no longer exists: timestamptz returns a
// JS Date directly, see database.ts's conventions header.)
vi.mock("../platform/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/config.js")>();
  return {
    config: {
      ...actual.config,
      kroger: {
        ...actual.config.kroger,
        searchStalenessWindowMs: 24 * 60 * 60_000, // 24h, matches the real default
      },
    },
  };
});

vi.mock("../kroger/auth.js", () => ({ getAppToken: vi.fn() }));
vi.mock("../kroger/client.js", () => ({ searchProducts: vi.fn() }));
vi.mock("./materiality.js", () => ({ judgeMateriality: vi.fn() }));

const { getAppToken } = await import("../kroger/auth.js");
const { searchProducts } = await import("../kroger/client.js");
const { isMatchStale, refreshIfStale } = await import("./index.js");

async function insertRecipeWithIngredient(recipeId: string, ingredientId: string): Promise<void> {
  const db = getDb();
  await db
    .insertInto("recipes")
    .values({
      id: recipeId,
      source_url: "https://x",
      extraction_version: "v1",
      status: "extracted",
      recipe_json: JSON.stringify({}),
    })
    .execute();
  await db
    .insertInto("ingredients")
    .values({
      id: ingredientId,
      recipe_id: recipeId,
      canonical_name: "flour",
      is_pantry_staple: false,
      evidence_json: JSON.stringify([]),
    })
    .execute();
}

/** `hoursAgo` of 0 means "now". */
async function insertMatch(ingredientId: string, hoursAgo: number): Promise<void> {
  const updatedAt = new Date(Date.now() - hoursAgo * 60 * 60_000);
  await getDb()
    .insertInto("product_matches")
    .values({
      id: `m-${ingredientId}`,
      ingredient_id: ingredientId,
      candidates_json: JSON.stringify([]),
      requires_approval: false,
      updated_at: updatedAt,
    })
    .execute();
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe("isMatchStale", () => {
  it("is not stale when there are no persisted matches yet", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    expect(await isMatchStale("r1")).toBe(false);
  });

  it("is not stale when the match was just updated (datetime('now'))", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    await insertMatch("i1", 0);
    expect(await isMatchStale("r1")).toBe(false);
  });

  it("is stale when the match is older than the configured window", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    // 25 hours ago — past the 24h default window.
    await insertMatch("i1", 25);
    expect(await isMatchStale("r1")).toBe(true);
  });

  it("is not stale at 23 hours (just under the window)", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    await insertMatch("i1", 23);
    expect(await isMatchStale("r1")).toBe(false);
  });

  it("uses the OLDEST match when a recipe has multiple ingredients", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    await getDb()
      .insertInto("ingredients")
      .values({
        id: "i2",
        recipe_id: "r1",
        canonical_name: "sugar",
        is_pantry_staple: false,
        evidence_json: JSON.stringify([]),
      })
      .execute();
    await insertMatch("i1", 0); // fresh
    await insertMatch("i2", 25); // stale
    expect(await isMatchStale("r1")).toBe(true);
  });
});

describe("refreshIfStale", () => {
  it("is a no-op (returns null, no Kroger call) when matches are fresh", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    await insertMatch("i1", 0);

    const result = await refreshIfStale("r1", "01100002", { skipMateriality: true });

    expect(result).toBeNull();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(searchProducts).not.toHaveBeenCalled();
  });

  it("re-runs matching when matches are stale", async () => {
    await insertRecipeWithIngredient("r1", "i1");
    await insertMatch("i1", 25);
    (getAppToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "tok",
      expires_in: 1800,
      token_type: "bearer",
    });
    (searchProducts as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { pagination: { start: 0, limit: 10, total: 0 } },
    });

    const result = await refreshIfStale("r1", "01100002", { skipMateriality: true });

    expect(result).not.toBeNull();
    expect(getAppToken).toHaveBeenCalledTimes(1);
    expect(searchProducts).toHaveBeenCalledTimes(1);
    // The match's updated_at should now be fresh.
    expect(await isMatchStale("r1")).toBe(false);
  });
});
