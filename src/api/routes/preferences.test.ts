import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

const RAW_TOKEN = "test-device-token-preferences";
const AUTH_HEADER = { authorization: `Bearer ${RAW_TOKEN}` };

async function seedToken(): Promise<void> {
  const hash = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
  await getDb()
    .insertInto("device_tokens")
    .values({
      id: crypto.randomUUID(),
      user_id: DEFAULT_USER_ID,
      token_hash: hash,
      device_name: "Test device",
    })
    .execute();
}

describe("preferences routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedToken();
    app = await buildServer();
  });

  it("returns defaults when no preferences row exists yet, without inserting one", async () => {
    const res = await app.inject({ method: "GET", url: "/api/preferences", headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      storeBrandPreferred: false,
      organicPreferred: false,
      dietaryTags: [],
      pantryAlwaysOwned: [],
    });

    const row = await getDb()
      .selectFrom("preferences")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("rejects requests without a valid device token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/preferences" });
    expect(res.statusCode).toBe(401);
  });

  it("upserts on PATCH and returns the updated preferences", async () => {
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: AUTH_HEADER,
      payload: { storeBrandPreferred: true, dietaryTags: ["vegan", "gluten-free"] },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({
      storeBrandPreferred: true,
      organicPreferred: false,
      dietaryTags: ["vegan", "gluten-free"],
      pantryAlwaysOwned: [],
    });

    // A second partial PATCH only touches the fields it sends.
    const secondPatch = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: AUTH_HEADER,
      payload: { organicPreferred: true },
    });
    expect(secondPatch.statusCode).toBe(200);
    expect(secondPatch.json()).toEqual({
      storeBrandPreferred: true,
      organicPreferred: true,
      dietaryTags: ["vegan", "gluten-free"],
      pantryAlwaysOwned: [],
    });

    const getRes = await app.inject({ method: "GET", url: "/api/preferences", headers: AUTH_HEADER });
    expect(getRes.json()).toEqual({
      storeBrandPreferred: true,
      organicPreferred: true,
      dietaryTags: ["vegan", "gluten-free"],
      pantryAlwaysOwned: [],
    });
  });

  it("rejects malformed PATCH bodies", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: AUTH_HEADER,
      payload: { storeBrandPreferred: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("account routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedToken();
    app = await buildServer();
  });

  it("GET /account returns the calling user's own email/name", async () => {
    await getDb()
      .updateTable("users")
      .set({ email: "owner@example.com", name: "Owner" })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

    const res = await app.inject({
      method: "GET",
      url: "/api/account",
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: "owner@example.com",
      name: "Owner",
      hasStoreLocation: false,
      krogerConnected: false,
    });
  });

  it("GET /account returns nulls for an account with no Google identity yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/account",
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: null,
      name: null,
      hasStoreLocation: false,
      krogerConnected: false,
    });
  });

  it("GET /account reports hasStoreLocation/krogerConnected once configured", async () => {
    await getDb()
      .insertInto("store_locations")
      .values({ user_id: DEFAULT_USER_ID, location_id: "loc-1", name: "Store", zip_code: "1" })
      .execute();
    await getDb()
      .insertInto("kroger_auth")
      .values({
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        encrypted_access_token: "enc-access",
        encrypted_refresh_token: "enc-refresh",
        expires_at: new Date(Date.now() + 3600_000),
      })
      .execute();

    const res = await app.inject({
      method: "GET",
      url: "/api/account",
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasStoreLocation: true, krogerConnected: true });
  });

  it("GET /account rejects requests without a valid device token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/account" });
    expect(res.statusCode).toBe(401);
  });

  it("wipes recipes, jobs, kroger_auth, and preferences but keeps the user", async () => {
    const db = getDb();
    await db
      .insertInto("recipes")
      .values({
        id: "recipe-wipe-test",
        source_url: "https://example.com/r",
        extraction_version: "test",
        recipe_json: JSON.stringify({}),
      })
      .execute();
    // recipeId === jobId by construction (see routes/recipes.ts's header
    // comment) — the account-wipe route scopes recipes via jobs.user_id
    // (multi-tenancy Slice 1, 2026-07-21; recipes has no user_id column of
    // its own), so the job's id/recipe_id must actually point at the
    // recipe above for this test to exercise that scoping realistically.
    await db
      .insertInto("jobs")
      .values({
        id: "recipe-wipe-test",
        user_id: DEFAULT_USER_ID,
        source_url: "https://example.com/r",
        recipe_id: "recipe-wipe-test",
        idempotency_key: "wipe-test-key",
      })
      .execute();
    await db
      .insertInto("kroger_auth")
      .values({
        id: "kroger-auth-wipe-test",
        user_id: DEFAULT_USER_ID,
        encrypted_access_token: "enc-access",
        encrypted_refresh_token: "enc-refresh",
        expires_at: new Date(Date.now() + 3600_000),
      })
      .execute();
    await db
      .insertInto("preferences")
      .values({
        user_id: DEFAULT_USER_ID,
        store_brand_preferred: true,
        dietary_tags: JSON.stringify(["vegan"]),
        pantry_always_owned: JSON.stringify([]),
      })
      .execute();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/account/data",
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(204);

    expect(await db.selectFrom("recipes").selectAll().execute()).toEqual([]);
    expect(
      await db.selectFrom("jobs").selectAll().where("user_id", "=", DEFAULT_USER_ID).execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("kroger_auth")
        .selectAll()
        .where("user_id", "=", DEFAULT_USER_ID)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("preferences")
        .selectAll()
        .where("user_id", "=", DEFAULT_USER_ID)
        .execute(),
    ).toEqual([]);

    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirst();
    expect(user).toBeDefined();
  });

  it("rejects requests without a valid device token", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/account/data" });
    expect(res.statusCode).toBe(401);
  });
});
