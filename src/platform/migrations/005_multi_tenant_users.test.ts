// Migration effect tests for 005_multi_tenant_users. The suite's
// globalSetup (test-setup.ts) already runs migrateToLatest() once, so the
// new users columns exist by the time any test file runs — each test here
// drops them first, then re-runs this migration's up() directly and
// inspects the result, mirroring 004_device_tokens.test.ts's approach.
import { describe, expect, it, beforeEach } from "vitest";
import { resetDb } from "../test-db.js";
import { getDb, DEFAULT_USER_ID } from "../database.js";
import { up, down } from "./005_multi_tenant_users.js";

beforeEach(async () => {
  await resetDb();
  await down(getDb() as never);
});

describe("005_multi_tenant_users up()", () => {
  it("adds google_sub/email/name columns, all nullable", async () => {
    await up(getDb() as never);

    const row = await getDb()
      .selectFrom("users")
      .select(["id", "google_sub", "email", "name"])
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();

    // resetDb() re-seeds the default user with only id/device_token_hash —
    // the new columns must have come back null, not required.
    expect(row.google_sub).toBeNull();
    expect(row.email).toBeNull();
    expect(row.name).toBeNull();
  });

  it("enforces uniqueness on google_sub", async () => {
    await up(getDb() as never);

    await getDb()
      .updateTable("users")
      .set({ google_sub: "dupe-sub" })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

    await expect(
      getDb()
        .insertInto("users")
        .values({ id: "second-user", google_sub: "dupe-sub" })
        .execute(),
    ).rejects.toThrow();
  });

  it("allows the same account to be claimed by setting google_sub/email", async () => {
    await up(getDb() as never);

    const row = await getDb()
      .updateTable("users")
      .set({ google_sub: "google-sub-123", email: "owner@example.com" })
      .where("id", "=", DEFAULT_USER_ID)
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.google_sub).toBe("google-sub-123");
    expect(row.email).toBe("owner@example.com");
  });
});

describe("005_multi_tenant_users down()", () => {
  it("drops the three columns, then restores them for the rest of the suite", async () => {
    await up(getDb() as never);
    await down(getDb() as never);

    await expect(
      getDb().selectFrom("users").select("google_sub" as never).execute(),
    ).rejects.toThrow();

    // Recreate for subsequent tests / globalSetup's schema expectation.
    await up(getDb() as never);
  });
});
