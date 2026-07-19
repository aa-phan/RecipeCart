// Cart route plugin (Phase 3, B2 slice — Spec 4 §2.5). Registered with
// prefix `/api` in server.ts, so paths below are e.g.
// `POST /api/recipes/:id/cart:approve` and `GET /api/recipes/:id/cart`.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";
import { badRequest, notFound } from "../lib/errors.js";
import type { CartResultDto } from "../lib/dto.js";
import type { CartItemResult, CartRunStatus } from "../../kroger/cart_runner.js";
import { runCartApproval } from "../../kroger/cart_runner.js";
import { buildApprovedItems } from "../lib/cart_selection.js";

export default async function cartRoutes(app: FastifyInstance): Promise<void> {
  // POST /recipes/:id/cart:approve — runs (or idempotently replays/resumes)
  // a cart approval for the recipe's currently-approved product matches.
  app.post("/recipes/:id/cart:approve", async (request) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw badRequest("Idempotency-Key header is required");
    }

    const recipeId = (request.params as { id: string }).id;
    const approvedItems = await buildApprovedItems(recipeId);
    const result = await runCartApproval(recipeId, approvedItems, idempotencyKey);

    return { status: result.status, results: result.results } satisfies CartResultDto;
  });

  // GET /recipes/:id/cart — the most recent cart_runs row for this recipe.
  app.get("/recipes/:id/cart", async (request) => {
    const recipeId = (request.params as { id: string }).id;
    const row = await getDb()
      .selectFrom("cart_runs")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    if (!row) throw notFound("cart result");

    // results_json is jsonb — already parsed on read (no JSON.parse).
    return {
      status: row.status as CartRunStatus,
      results: row.results_json as CartItemResult[],
    } satisfies CartResultDto;
  });
}
