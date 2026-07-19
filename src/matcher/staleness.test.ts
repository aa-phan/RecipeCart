import { describe, expect, it, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

// Real in-memory sqlite (not the generic prepared-statement stub the rest of
// index.test.ts uses) — isMatchStale/refreshIfStale's correctness hinges on
// actual sqlite datetime-string semantics (see parseSqliteUtcDatetime's doc:
// a naive `new Date(sqliteString)` parses as LOCAL time, not UTC — a real,
// live-verified ~5h skew bug in this environment), so this needs a genuine
// DB, not a mock that doesn't interpret SQL or dates at all.
let sqlite: DatabaseSync;

vi.mock("../platform/db.js", () => ({
  getDb: () => sqlite,
}));

vi.mock("../platform/config.js", () => ({
  config: {
    kroger: { searchStalenessWindowMs: 24 * 60 * 60_000 }, // 24h, matches the real default
  },
}));

vi.mock("../kroger/auth.js", () => ({ getAppToken: vi.fn() }));
vi.mock("../kroger/client.js", () => ({ searchProducts: vi.fn() }));
vi.mock("./materiality.js", () => ({ judgeMateriality: vi.fn() }));

const { getAppToken } = await import("../kroger/auth.js");
const { searchProducts } = await import("../kroger/client.js");
const { isMatchStale, refreshIfStale } = await import("./index.js");

function insertRecipeWithIngredient(recipeId: string, ingredientId: string) {
  sqlite.exec(
    `INSERT INTO recipes (id, source_url, extraction_version, status, recipe_json) VALUES ('${recipeId}', 'https://x', 'v1', 'extracted', '{}')`,
  );
  sqlite.exec(
    `INSERT INTO ingredients (id, recipe_id, canonical_name, is_pantry_staple) VALUES ('${ingredientId}', '${recipeId}', 'flour', 0)`,
  );
}

function insertMatch(ingredientId: string, updatedAtSql: string) {
  sqlite.exec(
    `INSERT INTO product_matches (id, ingredient_id, candidates_json, requires_approval, updated_at)
     VALUES ('m-${ingredientId}', '${ingredientId}', '[]', 0, ${updatedAtSql})`,
  );
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE recipes (id TEXT PRIMARY KEY, source_url TEXT, extraction_version TEXT, status TEXT, recipe_json TEXT);
    CREATE TABLE ingredients (id TEXT PRIMARY KEY, recipe_id TEXT, canonical_name TEXT, quantity_value REAL, quantity_unit TEXT, raw_text TEXT, is_pantry_staple INTEGER);
    CREATE TABLE product_matches (
      id TEXT PRIMARY KEY, ingredient_id TEXT, candidates_json TEXT, selected_product_id TEXT,
      requires_approval INTEGER, approval_reason TEXT, is_approved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  vi.clearAllMocks();
});

describe("isMatchStale", () => {
  it("is not stale when there are no persisted matches yet", () => {
    insertRecipeWithIngredient("r1", "i1");
    expect(isMatchStale("r1")).toBe(false);
  });

  it("is not stale when the match was just updated (datetime('now'))", () => {
    insertRecipeWithIngredient("r1", "i1");
    insertMatch("i1", "datetime('now')");
    expect(isMatchStale("r1")).toBe(false);
  });

  it("is stale when the match is older than the configured window", () => {
    insertRecipeWithIngredient("r1", "i1");
    // 25 hours ago — past the 24h default window.
    insertMatch("i1", "datetime('now', '-25 hours')");
    expect(isMatchStale("r1")).toBe(true);
  });

  it("is not stale at 23 hours (just under the window)", () => {
    insertRecipeWithIngredient("r1", "i1");
    insertMatch("i1", "datetime('now', '-23 hours')");
    expect(isMatchStale("r1")).toBe(false);
  });

  it("uses the OLDEST match when a recipe has multiple ingredients", () => {
    insertRecipeWithIngredient("r1", "i1");
    sqlite.exec(
      `INSERT INTO ingredients (id, recipe_id, canonical_name, is_pantry_staple) VALUES ('i2', 'r1', 'sugar', 0)`,
    );
    insertMatch("i1", "datetime('now')"); // fresh
    insertMatch("i2", "datetime('now', '-25 hours')"); // stale
    expect(isMatchStale("r1")).toBe(true);
  });
});

describe("refreshIfStale", () => {
  it("is a no-op (returns null, no Kroger call) when matches are fresh", async () => {
    insertRecipeWithIngredient("r1", "i1");
    insertMatch("i1", "datetime('now')");

    const result = await refreshIfStale("r1", "01100002", { skipMateriality: true });

    expect(result).toBeNull();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(searchProducts).not.toHaveBeenCalled();
  });

  it("re-runs matching when matches are stale", async () => {
    insertRecipeWithIngredient("r1", "i1");
    insertMatch("i1", "datetime('now', '-25 hours')");
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
    expect(isMatchStale("r1")).toBe(false);
  });
});
