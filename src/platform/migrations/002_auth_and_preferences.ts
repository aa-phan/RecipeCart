// Auth + user preferences schema (Phase 3 REST API slice). Adds kroger_auth
// (per-user Kroger OAuth token storage, encrypted at rest — Spec 4 §2.5) and
// preferences (per-user shopping preferences). JSON columns are jsonb;
// booleans are real booleans; timestamps are timestamptz default now() — see
// platform/database.ts conventions header.
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("kroger_auth")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) =>
      c.notNull().unique().references("users.id").onDelete("cascade"),
    )
    .addColumn("encrypted_access_token", "text", (c) => c.notNull())
    .addColumn("encrypted_refresh_token", "text", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("store_location_id", "text")
    .addColumn("last_refreshed_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("idx_kroger_auth_user_id")
    .on("kroger_auth")
    .column("user_id")
    .execute();

  await db.schema
    .createTable("preferences")
    .addColumn("user_id", "text", (c) =>
      c.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("store_brand_preferred", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("organic_preferred", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("dietary_tags", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("pantry_always_owned", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ["preferences", "kroger_auth"]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
