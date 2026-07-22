// Account routes (Phase 3 REST API, B4; GET added 2026-07-22 for the
// Account screen's "signed in as" line; onboarding-status fields added the
// same day — multi-tenancy Slice 3, closing the "new sign-ins aren't
// prompted to connect Kroger or set a store" gap tracked in
// files/phases.md). DELETE /account/data does a full wipe of the
// authenticated user's data — recipes/ingredients/product_matches/
// cart_runs (via cascade), jobs, kroger_auth, and preferences — but leaves
// the `users` row itself intact (the account stays registered, just
// wiped).
//
// FIXED 2026-07-21 (multi-tenancy Slice 1): `recipes` has no `user_id`
// column of its own (see migrations/005_multi_tenant_users.ts's header for
// why — recipes.id === jobs.id by construction, so scoping goes through
// jobs instead of a redundant column), which used to mean this deleted
// EVERY user's recipes, not just the caller's — a real, previously-shipped
// bug (also the same root cause as the "delete my data wipes everyone's
// data" Phase 7 backlog item, closed by this same fix). Now scoped via a
// subquery through jobs.user_id.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";
import { notFound } from "../lib/errors.js";
import type { AccountDto } from "../lib/dto.js";
import { loadStoreLocation } from "../../kroger/store_config.js";

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  // GET /account — the calling user's own identity (email/name from their
  // Google sign-in) plus onboarding status (hasStoreLocation/
  // krogerConnected). Used by the Account screen's "Signed in as X" line
  // AND by RecipesList's onboarding banner/submit-guard (multi-tenancy
  // Slice 3) — one call gives the frontend everything it needs to decide
  // what to nudge a freshly-signed-in account to do next.
  app.get("/account", async (request): Promise<AccountDto> => {
    const db = getDb();
    const [user, store, krogerAuth] = await Promise.all([
      db.selectFrom("users").select(["email", "name"]).where("id", "=", request.userId).executeTakeFirst(),
      // loadStoreLocation() (not a raw store_locations query) deliberately —
      // it also covers the legacy DEFAULT_USER_ID env-var bootstrap
      // fallback (kroger/store_config.ts), so the pre-existing owner
      // account doesn't get wrongly flagged as "needs onboarding" just
      // because it predates the store_locations table.
      loadStoreLocation(request.userId),
      db
        .selectFrom("kroger_auth")
        .select("user_id")
        .where("user_id", "=", request.userId)
        .executeTakeFirst(),
    ]);
    if (!user) throw notFound("account");
    return {
      email: user.email,
      name: user.name,
      hasStoreLocation: store !== null,
      krogerConnected: krogerAuth !== undefined,
    };
  });

  app.delete("/account/data", async (request, reply) => {
    await getDb().transaction().execute(async (trx) => {
      // recipes cascades to ingredients -> product_matches, and to cart_runs
      // (see migrations/001_initial.ts). Scoped to this user's recipes via
      // the same jobs.id === recipes.id relationship every other
      // recipe-scoping query uses (see api/lib/ownership.ts).
      await trx
        .deleteFrom("recipes")
        .where("id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("recipe_id")
            .where("user_id", "=", request.userId)
            .where("recipe_id", "is not", null),
        )
        .execute();

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
