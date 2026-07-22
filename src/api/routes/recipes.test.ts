// Recipes route tests (multi-tenancy Slice 1, 2026-07-21). This is the
// direct regression coverage for the tenant-isolation fix: before this
// slice, GET / listed every user's jobs, and GET/DELETE /:id + the
// ingredient/match PATCH routes trusted the URL id alone with no ownership
// check at all — any authenticated caller could read/edit/delete ANY
// user's recipe. Every test below seeds two independent users and asserts
// user B can neither see nor act on user A's data.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";

const USER_A = DEFAULT_USER_ID;
const USER_B = "11111111-1111-1111-1111-111111111111";
const TOKEN_A = "token-user-a";
const TOKEN_B = "token-user-b";
const AUTH_A = { authorization: `Bearer ${TOKEN_A}` };
const AUTH_B = { authorization: `Bearer ${TOKEN_B}` };

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function seedUsersAndTokens(): Promise<void> {
  const db = getDb();
  await db.insertInto("users").values({ id: USER_B }).execute();
  await db
    .insertInto("device_tokens")
    .values([
      { id: crypto.randomUUID(), user_id: USER_A, token_hash: hash(TOKEN_A), device_name: "A" },
      { id: crypto.randomUUID(), user_id: USER_B, token_hash: hash(TOKEN_B), device_name: "B" },
    ])
    .execute();
}

/** Seeds a recipe fully owned by USER_A: job + recipe + ingredient + match,
 * mirroring how a real awaiting_review recipe looks. */
async function seedRecipeForUserA(): Promise<{ recipeId: string; ingredientId: string }> {
  const db = getDb();
  const recipeId = "recipe-a";
  const ingredientId = "ingredient-a";
  // recipes must exist before jobs.recipe_id can reference it (FK).
  await db
    .insertInto("recipes")
    .values({
      id: recipeId,
      source_url: "https://example.com/a",
      extraction_version: "test",
      title: "User A's recipe",
      recipe_json: JSON.stringify({}),
    })
    .execute();
  await db
    .insertInto("jobs")
    .values({
      id: recipeId,
      user_id: USER_A,
      source_url: "https://example.com/a",
      recipe_id: recipeId,
      status: "awaiting_review",
      stage: "awaiting_review",
      idempotency_key: "seed-a",
    })
    .execute();
  await db
    .insertInto("ingredients")
    .values({
      id: ingredientId,
      recipe_id: recipeId,
      canonical_name: "flour",
      evidence_json: JSON.stringify([]),
    })
    .execute();
  await db
    .insertInto("product_matches")
    .values({
      id: "match-a",
      ingredient_id: ingredientId,
      candidates_json: JSON.stringify([]),
    })
    .execute();
  return { recipeId, ingredientId };
}

describe("recipes routes — multi-tenant isolation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedUsersAndTokens();
    const { buildServer } = await import("../server.js");
    app = await buildServer();
  });

  it("GET / only lists the caller's own recipes, not another user's", async () => {
    await seedRecipeForUserA();

    const asOwner = await app.inject({ method: "GET", url: "/api/recipes", headers: AUTH_A });
    expect(asOwner.json()).toHaveLength(1);

    const asOther = await app.inject({ method: "GET", url: "/api/recipes", headers: AUTH_B });
    expect(asOther.json()).toEqual([]);
  });

  it("GET /:id 404s for another user's recipe instead of returning it", async () => {
    const { recipeId } = await seedRecipeForUserA();

    const asOwner = await app.inject({
      method: "GET",
      url: `/api/recipes/${recipeId}`,
      headers: AUTH_A,
    });
    expect(asOwner.statusCode).toBe(200);

    const asOther = await app.inject({
      method: "GET",
      url: `/api/recipes/${recipeId}`,
      headers: AUTH_B,
    });
    expect(asOther.statusCode).toBe(404);
  });

  it("DELETE /:id cannot delete another user's recipe", async () => {
    const { recipeId } = await seedRecipeForUserA();

    const asOther = await app.inject({
      method: "DELETE",
      url: `/api/recipes/${recipeId}`,
      headers: AUTH_B,
    });
    expect(asOther.statusCode).toBe(404);

    // Still there, untouched.
    const stillExists = await getDb()
      .selectFrom("recipes")
      .selectAll()
      .where("id", "=", recipeId)
      .executeTakeFirst();
    expect(stillExists).toBeDefined();
  });

  it("POST /:id/reprocess cannot be driven off another user's job", async () => {
    const { recipeId } = await seedRecipeForUserA();

    const res = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/reprocess`,
      headers: AUTH_B,
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH ingredient cannot edit another user's ingredient by id alone", async () => {
    const { ingredientId } = await seedRecipeForUserA();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/recipes/recipe-a/ingredients/${ingredientId}`,
      headers: AUTH_B,
      payload: { markOwned: true },
    });
    expect(res.statusCode).toBe(404);

    const row = await getDb()
      .selectFrom("ingredients")
      .select("is_pantry_staple")
      .where("id", "=", ingredientId)
      .executeTakeFirstOrThrow();
    expect(row.is_pantry_staple).toBe(false); // untouched
  });

  it("PATCH match cannot select a match on another user's ingredient", async () => {
    const { ingredientId } = await seedRecipeForUserA();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/recipes/recipe-a/matches/${ingredientId}`,
      headers: AUTH_B,
      payload: { selectedProductId: "some-product" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /:id/ingredients cannot add to another user's recipe", async () => {
    const { recipeId } = await seedRecipeForUserA();

    const res = await app.inject({
      method: "POST",
      url: `/api/recipes/${recipeId}/ingredients`,
      headers: AUTH_B,
      payload: { canonicalName: "sneaky ingredient" },
    });
    expect(res.statusCode).toBe(404);

    const rows = await getDb()
      .selectFrom("ingredients")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .execute();
    expect(rows).toHaveLength(1); // only the original seeded one
  });

  it("the owning user's own actions on their own recipe are unaffected", async () => {
    const { recipeId, ingredientId } = await seedRecipeForUserA();

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/recipes/${recipeId}/ingredients/${ingredientId}`,
      headers: AUTH_A,
      payload: { markOwned: true },
    });
    expect(edit.statusCode).toBe(200);

    const row = await getDb()
      .selectFrom("ingredients")
      .select("is_pantry_staple")
      .where("id", "=", ingredientId)
      .executeTakeFirstOrThrow();
    expect(row.is_pantry_staple).toBe(true);
  });
});
