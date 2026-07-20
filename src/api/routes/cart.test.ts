import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";

// Mock addToCart (src/kroger/client.ts) — CRITICAL: this must NEVER be the
// real implementation in this test file, since the real one makes a live
// mutating call to a real Kroger customer's real cart.
const addToCartMock = vi.fn();
vi.mock("../../kroger/client.js", () => ({
  addToCart: (...args: unknown[]) => addToCartMock(...args),
}));

const loadTokenMock = vi.fn();
const saveTokenMock = vi.fn();
vi.mock("../../kroger/token_store.js", () => ({
  loadToken: (...args: unknown[]) => loadTokenMock(...args),
  saveToken: (...args: unknown[]) => saveTokenMock(...args),
  isExpiredOrMissing: (token: { expiresAt: number } | null, skewMs = 60_000) => {
    if (!token) return true;
    return Date.now() >= token.expiresAt - skewMs;
  },
}));

const refreshAccessTokenMock = vi.fn();
vi.mock("../../kroger/auth.js", () => ({
  refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
}));

const RAW_TOKEN = "test-token";
const AUTH_HEADER = { authorization: `Bearer ${RAW_TOKEN}` };

async function seedToken(): Promise<void> {
  const hash = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
  await getDb()
    .updateTable("users")
    .set({ device_token_hash: hash })
    .where("id", "=", DEFAULT_USER_ID)
    .execute();
}

const CANDIDATE = {
  productId: "prod-1",
  upc: "0001111041700",
  name: "Test Product",
  brand: "Test Brand",
  price: 2.99,
  size: "1 ct",
  rankScore: 1,
  quantityToOrder: 1,
};

async function seedRecipeWithApprovedMatch(opts: { withJobRow?: boolean } = {}): Promise<void> {
  const db = getDb();
  await db
    .insertInto("recipes")
    .values({
      id: "recipe-1",
      source_url: "https://example.com/recipe",
      extraction_version: "test",
      status: "extracted",
      recipe_json: JSON.stringify({}),
    })
    .execute();
  if (opts.withJobRow) {
    // recipeId === jobId by construction (see recipes.ts's header comment) —
    // matches how a real job row looks once it reaches awaiting_review.
    await db
      .insertInto("jobs")
      .values({
        id: "recipe-1",
        user_id: DEFAULT_USER_ID,
        source_url: "https://example.com/recipe",
        recipe_id: "recipe-1",
        status: "awaiting_review",
        stage: "awaiting_review",
        idempotency_key: "seed-job-recipe-1",
      })
      .execute();
  }
  await db
    .insertInto("ingredients")
    .values({
      id: "ingredient-1",
      recipe_id: "recipe-1",
      canonical_name: "flour",
      evidence_json: JSON.stringify([]),
    })
    .execute();
  await db
    .insertInto("product_matches")
    .values({
      id: "match-1",
      ingredient_id: "ingredient-1",
      candidates_json: JSON.stringify([CANDIDATE]),
      selected_product_id: CANDIDATE.productId,
      requires_approval: false,
      is_approved: true,
    })
    .execute();
}

describe("cart routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetDb();
    await seedToken();
    loadTokenMock.mockReturnValue({
      accessToken: "valid-access-token",
      refreshToken: "refresh-tok",
      expiresAt: Date.now() + 60 * 60_000,
    });
    addToCartMock.mockResolvedValue({ ok: true, status: 204 });
    const { buildServer } = await import("../server.js");
    app = await buildServer();
  });

  describe("POST /api/recipes/:id/cart:approve", () => {
    it("requires an Idempotency-Key header", async () => {
      await seedRecipeWithApprovedMatch();
      const res = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(400);
      expect(addToCartMock).not.toHaveBeenCalled();
    });

    it("approves the cart and returns a completed status, without calling the real Kroger API", async () => {
      await seedRecipeWithApprovedMatch();
      const res = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { ...AUTH_HEADER, "idempotency-key": "idem-key-1" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("completed");
      expect(body.results).toEqual([
        { ingredientId: "ingredient-1", upc: CANDIDATE.upc, status: "added" },
      ]);
      expect(addToCartMock).toHaveBeenCalledTimes(1);
      expect(addToCartMock).toHaveBeenCalledWith(CANDIDATE.upc, 1, "valid-access-token");

      const runs = await getDb()
        .selectFrom("cart_runs")
        .selectAll()
        .where("recipe_id", "=", "recipe-1")
        .execute();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.idempotency_key).toBe("idem-key-1");
    });

    it("updates the parent job's status to completed after a real cart run", async () => {
      // Real bug, caught live 2026-07-20: runCartApproval only ever wrote
      // to cart_runs — nothing updated the parent jobs row, so the web
      // app's CartProgress screen (which polls GET /recipes/:id, i.e.
      // jobs.status) kept showing "processing" forever even after the cart
      // run genuinely finished.
      await seedRecipeWithApprovedMatch({ withJobRow: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { ...AUTH_HEADER, "idempotency-key": "idem-key-job-status" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("completed");

      const job = await getDb()
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", "recipe-1")
        .executeTakeFirstOrThrow();
      expect(job.status).toBe("completed");
      expect(job.stage).toBe("completed");
    });

    it("replays the same result for a repeated idempotency key without re-adding", async () => {
      await seedRecipeWithApprovedMatch();
      const first = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { ...AUTH_HEADER, "idempotency-key": "idem-key-2" },
      });
      expect(first.statusCode).toBe(200);
      expect(addToCartMock).toHaveBeenCalledTimes(1);

      const second = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { ...AUTH_HEADER, "idempotency-key": "idem-key-2" },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      // Not called again — the idempotent replay short-circuits before any
      // network call.
      expect(addToCartMock).toHaveBeenCalledTimes(1);
    });

    it("rejects requests without a valid device token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { "idempotency-key": "idem-key-3" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/recipes/:id/cart", () => {
    it("returns 404 before any approval has run", async () => {
      await seedRecipeWithApprovedMatch();
      const res = await app.inject({
        method: "GET",
        url: "/api/recipes/recipe-1/cart",
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns the most recent cart run after approval", async () => {
      await seedRecipeWithApprovedMatch();
      await app.inject({
        method: "POST",
        url: "/api/recipes/recipe-1/cart:approve",
        headers: { ...AUTH_HEADER, "idempotency-key": "idem-key-4" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/recipes/recipe-1/cart",
        headers: AUTH_HEADER,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("completed");
      expect(body.results).toEqual([
        { ingredientId: "ingredient-1", upc: CANDIDATE.upc, status: "added" },
      ]);
    });

    it("rejects requests without a valid device token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/recipes/recipe-1/cart" });
      expect(res.statusCode).toBe(401);
    });
  });
});
