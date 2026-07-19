// Account data-wipe route (Phase 3 REST API, B4). DELETE /account/data does
// a full wipe of the authenticated device's data — recipes/ingredients/
// product_matches/cart_runs (via cascade), jobs, kroger_auth, and
// preferences — but leaves the `users` row itself intact (the device stays
// registered, just wiped).
//
// KNOWN MVP SIMPLIFICATION: `recipes` (and its cascaded children) has no
// `user_id` column — this app runs single-user (DEFAULT_USER_ID) in normal
// operation, so "the user's data" is treated as ALL recipes. A genuinely
// multi-user future would need a `user_id` column on `recipes` to scope this
// deletion correctly; today it is NOT scoped per-user for that table.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.delete("/account/data", async (request, reply) => {
    await getDb().transaction().execute(async (trx) => {
      // recipes cascades to ingredients -> product_matches, and to cart_runs
      // (see migrations/001_initial.ts). Not scoped by user_id — see header.
      await trx.deleteFrom("recipes").execute();

      // jobs.recipe_id is ON DELETE SET NULL, so deleting recipes first
      // doesn't block this, but delete explicitly regardless of order for
      // full cleanup of this user's jobs.
      await trx.deleteFrom("jobs").where("user_id", "=", request.userId).execute();

      await trx.deleteFrom("kroger_auth").where("user_id", "=", request.userId).execute();

      await trx.deleteFrom("preferences").where("user_id", "=", request.userId).execute();
    });

    reply.status(204);
    return null;
  });
}
