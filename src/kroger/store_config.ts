// Target store persistence (Spec 3 §14). DB-backed, per-user as of
// multi-tenancy Slice 2 (2026-07-22) — replaces the old flat-file/env-var
// version, which had no user dimension at all (a real gap once more than
// one account exists: each account needs its own chosen store to search
// Kroger's inventory against) and, on Railway, silently returned null from
// the api service specifically (no persistent volume there — see the
// 2026-07-20 fix this replaces). A DB is reachable from both api and
// worker regardless of volumes, fixing that permanently rather than
// working around it a second time.
import { getDb, DEFAULT_USER_ID } from "../platform/database.js";

export interface StoredStoreLocation {
  locationId: string;
  name: string;
  zipCode: string;
}

export async function saveStoreLocation(
  location: StoredStoreLocation,
  userId: string = DEFAULT_USER_ID,
): Promise<void> {
  await getDb()
    .insertInto("store_locations")
    .values({
      user_id: userId,
      location_id: location.locationId,
      name: location.name,
      zip_code: location.zipCode,
    })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({
        location_id: location.locationId,
        name: location.name,
        zip_code: location.zipCode,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Falls back to env vars ONLY for DEFAULT_USER_ID and ONLY when no DB row
 * exists yet — a one-time bootstrap path for the pre-existing single-tenant
 * deployment's store (set via STORE_LOCATION_ID/STORE_NAME/STORE_ZIP_CODE
 * before this table existed), not a general per-user fallback. Any other
 * account with no store_locations row gets null and must configure one via
 * POST /api/store-location. */
export async function loadStoreLocation(
  userId: string = DEFAULT_USER_ID,
): Promise<StoredStoreLocation | null> {
  const row = await getDb()
    .selectFrom("store_locations")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (row) {
    return { locationId: row.location_id, name: row.name, zipCode: row.zip_code };
  }

  if (userId !== DEFAULT_USER_ID) return null;
  const locationId = process.env.STORE_LOCATION_ID;
  if (!locationId) return null;
  return {
    locationId,
    name: process.env.STORE_NAME ?? "",
    zipCode: process.env.STORE_ZIP_CODE ?? "",
  };
}
