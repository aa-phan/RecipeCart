// store_config.ts unit tests (multi-tenancy Slice 2, 2026-07-22) — DB-backed,
// per-user store location. Covers the env-var bootstrap fallback (only for
// DEFAULT_USER_ID) and real per-user isolation directly against Postgres.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_USER_ID } from "../platform/database.js";
import { getDb } from "../platform/database.js";
import { resetDb } from "../platform/test-db.js";
import { loadStoreLocation, saveStoreLocation } from "./store_config.js";

const ENV_KEYS = ["STORE_LOCATION_ID", "STORE_NAME", "STORE_ZIP_CODE"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  await resetDb();
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("loadStoreLocation / saveStoreLocation", () => {
  it("returns null when nothing is configured and no env fallback is set", async () => {
    expect(await loadStoreLocation()).toBeNull();
  });

  it("saves and loads a store for the default user", async () => {
    await saveStoreLocation({ locationId: "loc-1", name: "Store 1", zipCode: "75201" });
    expect(await loadStoreLocation()).toEqual({
      locationId: "loc-1",
      name: "Store 1",
      zipCode: "75201",
    });
  });

  it("upserts — saving again for the same user replaces, not duplicates", async () => {
    await saveStoreLocation({ locationId: "loc-1", name: "Store 1", zipCode: "75201" });
    await saveStoreLocation({ locationId: "loc-2", name: "Store 2", zipCode: "10001" });

    expect(await loadStoreLocation()).toEqual({
      locationId: "loc-2",
      name: "Store 2",
      zipCode: "10001",
    });
    const rows = await getDb()
      .selectFrom("store_locations")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("falls back to STORE_LOCATION_ID env vars for DEFAULT_USER_ID when no row exists", async () => {
    process.env.STORE_LOCATION_ID = "env-loc";
    process.env.STORE_NAME = "Env Store";
    process.env.STORE_ZIP_CODE = "99999";

    expect(await loadStoreLocation()).toEqual({
      locationId: "env-loc",
      name: "Env Store",
      zipCode: "99999",
    });
  });

  it("a real DB row takes priority over the env var fallback", async () => {
    process.env.STORE_LOCATION_ID = "env-loc";
    await saveStoreLocation({ locationId: "db-loc", name: "DB Store", zipCode: "75201" });

    expect(await loadStoreLocation()).toMatchObject({ locationId: "db-loc" });
  });

  it("does NOT fall back to env vars for any user other than DEFAULT_USER_ID", async () => {
    process.env.STORE_LOCATION_ID = "env-loc";
    await getDb().insertInto("users").values({ id: "other-user" }).execute();

    expect(await loadStoreLocation("other-user")).toBeNull();
  });

  it("keeps different users' stores fully independent", async () => {
    await getDb().insertInto("users").values({ id: "other-user" }).execute();

    await saveStoreLocation({ locationId: "loc-a", name: "A", zipCode: "1" }, DEFAULT_USER_ID);
    await saveStoreLocation({ locationId: "loc-b", name: "B", zipCode: "2" }, "other-user");

    expect(await loadStoreLocation(DEFAULT_USER_ID)).toMatchObject({ locationId: "loc-a" });
    expect(await loadStoreLocation("other-user")).toMatchObject({ locationId: "loc-b" });
  });
});
