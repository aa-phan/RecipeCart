// User preferences route (Phase 3 REST API, B4). Read/write the per-user
// `preferences` row scoped by `request.userId` (device-token auth — see
// lib/auth.ts). Intentionally stub-level: the Preferences screen is a stub
// for this slice, so a correct working CRUD endpoint is sufficient.
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import type { PreferencesDto } from "../lib/dto.js";
import { badRequest } from "../lib/errors.js";

export const DEFAULT_PREFERENCES: PreferencesDto = {
  storeBrandPreferred: false,
  organicPreferred: false,
  dietaryTags: [],
  pantryAlwaysOwned: [],
};

function toDto(row: {
  store_brand_preferred: boolean;
  organic_preferred: boolean;
  dietary_tags: string[];
  pantry_always_owned: string[];
}): PreferencesDto {
  return {
    storeBrandPreferred: row.store_brand_preferred,
    organicPreferred: row.organic_preferred,
    dietaryTags: row.dietary_tags,
    pantryAlwaysOwned: row.pantry_always_owned,
  };
}

/** Shared single-slot fetch (same pattern as device tokens/store
 * location/kroger_auth — one row per user, `DEFAULT_USER_ID` in this
 * single-household MVP) — used by the GET route below AND by matcher
 * call sites (worker/state_machine.ts, recipe_edits.ts) that need to feed a
 * user's saved preferences into product-matching/ranking. Falls back to
 * `DEFAULT_PREFERENCES` (all false/empty) when no row exists yet, exactly
 * like the GET route always has. */
export async function loadPreferences(userId: string = DEFAULT_USER_ID): Promise<PreferencesDto> {
  const row = await getDb()
    .selectFrom("preferences")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (!row) return DEFAULT_PREFERENCES;
  return toDto(row);
}

export default async function preferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/preferences", async (request) => {
    return loadPreferences(request.userId);
  });

  app.patch("/preferences", async (request) => {
    const body = request.body as Partial<PreferencesDto> | undefined;
    if (!body || typeof body !== "object") throw badRequest("Request body is required.");

    if (body.storeBrandPreferred !== undefined && typeof body.storeBrandPreferred !== "boolean") {
      throw badRequest("storeBrandPreferred must be a boolean.");
    }
    if (body.organicPreferred !== undefined && typeof body.organicPreferred !== "boolean") {
      throw badRequest("organicPreferred must be a boolean.");
    }
    if (body.dietaryTags !== undefined && !Array.isArray(body.dietaryTags)) {
      throw badRequest("dietaryTags must be an array of strings.");
    }
    if (body.pantryAlwaysOwned !== undefined && !Array.isArray(body.pantryAlwaysOwned)) {
      throw badRequest("pantryAlwaysOwned must be an array of strings.");
    }

    const insertValues = {
      user_id: request.userId,
      store_brand_preferred: body.storeBrandPreferred ?? DEFAULT_PREFERENCES.storeBrandPreferred,
      organic_preferred: body.organicPreferred ?? DEFAULT_PREFERENCES.organicPreferred,
      dietary_tags: JSON.stringify(body.dietaryTags ?? DEFAULT_PREFERENCES.dietaryTags),
      pantry_always_owned: JSON.stringify(
        body.pantryAlwaysOwned ?? DEFAULT_PREFERENCES.pantryAlwaysOwned,
      ),
      updated_at: new Date(),
    };

    const updateSet: Record<string, unknown> = { updated_at: new Date() };
    if (body.storeBrandPreferred !== undefined) {
      updateSet.store_brand_preferred = body.storeBrandPreferred;
    }
    if (body.organicPreferred !== undefined) {
      updateSet.organic_preferred = body.organicPreferred;
    }
    if (body.dietaryTags !== undefined) {
      updateSet.dietary_tags = JSON.stringify(body.dietaryTags);
    }
    if (body.pantryAlwaysOwned !== undefined) {
      updateSet.pantry_always_owned = JSON.stringify(body.pantryAlwaysOwned);
    }

    const row = await getDb()
      .insertInto("preferences")
      .values(insertValues)
      .onConflict((oc) => oc.column("user_id").doUpdateSet(updateSet))
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDto(row);
  });
}
