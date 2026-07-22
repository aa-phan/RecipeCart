// Tenant-ownership checks (multi-tenancy Slice 1, 2026-07-21). Shared by
// every route/service that acts on a recipe or one of its ingredients, so
// "does this belong to the calling user" is checked the same way
// everywhere instead of re-derived per call site.
import { getDb, type JobsTable } from "../../platform/database.js";
import type { Selectable } from "kysely";
import { notFound } from "./errors.js";

/** Verifies `recipeId` (== its job id, by construction — see
 * routes/recipes.ts's header comment) belongs to `userId`, returning the
 * job row if so. Throws notFound() otherwise — a recipe that exists but
 * belongs to someone else reads identically to one that doesn't exist at
 * all, standard tenant-isolation practice (never leak existence across
 * tenants via a 403 vs. 404 distinction). */
export async function requireOwnedJob(
  recipeId: string,
  userId: string,
): Promise<Selectable<JobsTable>> {
  const job = await getDb()
    .selectFrom("jobs")
    .selectAll()
    .where("id", "=", recipeId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!job) throw notFound("recipe");
  return job;
}

/** Verifies `ingredientId`'s parent recipe belongs to `userId`, via
 * ingredients.recipe_id -> jobs.id (same construction as above). Throws
 * notFound() otherwise. Used by the ingredient/match edit routes, which
 * only ever receive an ingredientId in the URL, not the parent recipe id —
 * without this, any authenticated user could edit/remove/rematch any
 * ingredient by id alone, regardless of which recipe or tenant owns it. */
export async function requireOwnedIngredient(ingredientId: string, userId: string): Promise<void> {
  const row = await getDb()
    .selectFrom("ingredients as i")
    .innerJoin("jobs as j", "j.id", "i.recipe_id")
    .select("i.id")
    .where("i.id", "=", ingredientId)
    .where("j.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw notFound("ingredient");
}
