// Migration effect tests for 004_device_tokens. The suite's globalSetup
// (test-setup.ts) already runs migrateToLatest() once against the test DB,
// so device_tokens exists by the time any test file runs. To exercise the
// backfill logic itself (rather than just the resulting schema), each test
// drops device_tokens, seeds users.device_token_hash directly, then re-runs
// this migration's exported up() against the live test DB and inspects the
// result — the same "call the migration logic directly" approach used
// wherever this project doesn't have a dedicated migration-test harness.
import { describe, expect, it, beforeEach } from "vitest";
import crypto from "node:crypto";
import { resetDb } from "../test-db.js";
import { getDb, DEFAULT_USER_ID } from "../database.js";
import { up } from "./004_device_tokens.js";

beforeEach(async () => {
  await resetDb();
  // resetDb() truncates users (CASCADE also drops any device_tokens rows,
  // but the table itself still exists from globalSetup's migration run).
  // Drop it so up() can freely recreate it, mirroring a real from-scratch run.
  await getDb().schema.dropTable("device_tokens").ifExists().execute();
});

describe("004_device_tokens up()", () => {
  it("creates the device_tokens table with the expected columns", async () => {
    await up(getDb() as never);

    const row = await getDb()
      .insertInto("device_tokens")
      .values({
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: "hash-abc",
        device_name: "Test device",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.token_hash).toBe("hash-abc");
    expect(row.device_name).toBe("Test device");
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.last_used_at).toBeNull();
  });

  it("backfills a device_tokens row when users.device_token_hash is already set", async () => {
    await getDb()
      .updateTable("users")
      .set({ device_token_hash: "legacy-hash-123" })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

    await up(getDb() as never);

    const rows = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();

    expect(rows).toHaveLength(1);
    const row = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toBe("legacy-hash-123");
    expect(row.device_name).toBe("Migrated token");
    expect(row.last_used_at).toBeNull();

    // The old single-slot column is left in place, unused going forward.
    const user = await getDb()
      .selectFrom("users")
      .select("device_token_hash")
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(user.device_token_hash).toBe("legacy-hash-123");
  });

  it("backfills nothing when users.device_token_hash is null", async () => {
    await up(getDb() as never);

    const rows = await getDb().selectFrom("device_tokens").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("enforces uniqueness on token_hash", async () => {
    await up(getDb() as never);

    await getDb()
      .insertInto("device_tokens")
      .values({
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: "dupe-hash",
        device_name: "Device A",
      })
      .execute();

    await expect(
      getDb()
        .insertInto("device_tokens")
        .values({
          id: crypto.randomUUID(),
          user_id: DEFAULT_USER_ID,
          token_hash: "dupe-hash",
          device_name: "Device B",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("cascades device_tokens deletion when the owning user is deleted", async () => {
    await up(getDb() as never);
    await getDb()
      .insertInto("device_tokens")
      .values({
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: "cascade-hash",
        device_name: "Device C",
      })
      .execute();

    await getDb().deleteFrom("users").where("id", "=", DEFAULT_USER_ID).execute();

    const rows = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("token_hash", "=", "cascade-hash")
      .execute();
    expect(rows).toHaveLength(0);
  });
});

describe("004_device_tokens down()", () => {
  it("drops the device_tokens table", async () => {
    await up(getDb() as never);
    const { down } = await import("./004_device_tokens.js");
    await down(getDb() as never);

    await expect(
      getDb().selectFrom("device_tokens").selectAll().execute(),
    ).rejects.toThrow();

    // Recreate it so subsequent tests / globalSetup's schema expectation
    // for the rest of the suite are unaffected by this file.
    await up(getDb() as never);
  });
});
