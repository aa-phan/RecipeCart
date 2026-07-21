// Per-device token schema (Slice 1 of the device-token architecture fix).
// Replaces the single `users.device_token_hash` slot (one bearer token per
// user, set by 001_initial) with a `device_tokens` table so a user can carry
// multiple concurrently-valid device tokens (e.g. phone + iPad) instead of
// signing in on one device logging out every other one.
//
// `users.device_token_hash` is deliberately left in place, unused going
// forward — dropping it is out of scope for this pass (low-risk, cheap to
// clean up later once every caller has migrated off it).
import { Kysely, sql } from "kysely";
import crypto from "node:crypto";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("device_tokens")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) =>
      c.notNull().references("users.id").onDelete("cascade"),
    )
    // Looked up on every authenticated request. UNIQUE already gives this
    // column its own btree index in Postgres, which doubles as the lookup
    // index — no separate `createIndex` needed.
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    // No nullable name: the app layer supplies a default (e.g. "Unnamed
    // device") if the user doesn't provide one, not the DB.
    .addColumn("device_name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("last_used_at", "timestamptz")
    .execute();

  // Backfill: any user with a non-null device_token_hash today has a token
  // that's currently valid in production. Carry it forward as a
  // device_tokens row so in-flight devices keep working through this
  // deploy instead of being logged out the moment this migration runs.
  const usersWithToken = await db
    .selectFrom("users" as never)
    .select(["id", "device_token_hash"] as never)
    .where("device_token_hash" as never, "is not", null)
    .execute();

  for (const row of usersWithToken as unknown as {
    id: string;
    device_token_hash: string;
  }[]) {
    await db
      .insertInto("device_tokens" as never)
      .values({
        id: crypto.randomUUID(),
        user_id: row.id,
        token_hash: row.device_token_hash,
        device_name: "Migrated token",
      } as never)
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("device_tokens").ifExists().execute();
}
