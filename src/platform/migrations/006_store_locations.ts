// Per-user store location (multi-tenancy Slice 2, 2026-07-22). Replaces
// the old flat-file/env-var store_config.ts, which had no user dimension
// at all — a real gap once more than one account exists, since every
// account needs to search Kroger's inventory against its OWN chosen store,
// not a single global one. A DB table is also reachable from both the api
// and worker processes regardless of volumes, permanently fixing the
// earlier documented gap where the api service (no persistent volume on
// Railway) always saw a null store.
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("store_locations")
    .addColumn("user_id", "text", (c) =>
      c.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("location_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("zip_code", "text", (c) => c.notNull())
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("store_locations").ifExists().execute();
}
