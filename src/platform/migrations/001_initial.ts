// Initial Postgres schema (Spec 4 §2.4). Ports the Phase 1/2 sqlite tables
// (recipes/ingredients/product_matches/cart_runs/kroger_api_usage) verbatim in
// field names, plus the Phase 3 spine tables (users/jobs/events). JSON columns
// are jsonb; booleans are real booleans; timestamps are timestamptz default
// now() — see platform/database.ts conventions header.
import { Kysely, sql } from "kysely";
import { DEFAULT_USER_ID } from "../database.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  // users first — recipes/jobs reference it. One default single-user row is
  // seeded in a later step so recipes.user_id / jobs.user_id have a target
  // from day one (multi-user later is additive, not a migration).
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("device_token_hash", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("recipes")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("source_url", "text", (c) => c.notNull())
    .addColumn("extraction_version", "text", (c) => c.notNull())
    .addColumn("title", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("extracted"))
    .addColumn("recipe_json", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("failure_class", "text")
    .addColumn("failure_reason", "text")
    .execute();

  await db.schema
    .createTable("ingredients")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("recipe_id", "text", (c) =>
      c.notNull().references("recipes.id").onDelete("cascade"),
    )
    .addColumn("canonical_name", "text", (c) => c.notNull())
    .addColumn("quantity_value", "double precision")
    .addColumn("quantity_unit", "text")
    .addColumn("raw_text", "text")
    .addColumn("is_pantry_staple", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("evidence_json", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("product_matches")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("ingredient_id", "text", (c) =>
      c.notNull().unique().references("ingredients.id").onDelete("cascade"),
    )
    .addColumn("candidates_json", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("selected_product_id", "text")
    .addColumn("requires_approval", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("approval_reason", "text")
    .addColumn("is_approved", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("cart_runs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("recipe_id", "text", (c) =>
      c.notNull().references("recipes.id").onDelete("cascade"),
    )
    .addColumn("idempotency_key", "text", (c) => c.notNull().unique())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("results_json", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .execute();

  // Daily per-endpoint API usage counters (Spec 3 §17). Composite PK (day, endpoint).
  await db.schema
    .createTable("kroger_api_usage")
    .addColumn("day", "text", (c) => c.notNull())
    .addColumn("endpoint", "text", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("kroger_api_usage_pk", ["day", "endpoint"])
    .execute();

  // Postgres-backed job queue (Spec 4 §2.2/§2.3).
  await db.schema
    .createTable("jobs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("source_url", "text", (c) => c.notNull())
    .addColumn("recipe_id", "text", (c) => c.references("recipes.id").onDelete("set null"))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("received"))
    .addColumn("stage", "text", (c) => c.notNull().defaultTo("received"))
    .addColumn("locked_by", "text")
    .addColumn("locked_at", "timestamptz")
    .addColumn("run_after", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("idempotency_key", "text", (c) => c.notNull().unique())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Claim query index: WHERE status=? AND run_after<=now() ORDER BY run_after.
  await db.schema
    .createIndex("idx_jobs_claim")
    .on("jobs")
    .columns(["status", "run_after"])
    .execute();
  // Stale-lock sweep index.
  await db.schema.createIndex("idx_jobs_locked_at").on("jobs").column("locked_at").execute();

  // Append-only event log (Spec 2/3 event contracts). bigserial id gives a
  // total order alongside created_at.
  await db.schema
    .createTable("events")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("job_id", "text")
    .addColumn("recipe_id", "text")
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("data", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("idx_ingredients_recipe_id")
    .on("ingredients")
    .column("recipe_id")
    .execute();
  await db.schema
    .createIndex("idx_cart_runs_recipe_id")
    .on("cart_runs")
    .column("recipe_id")
    .execute();
  await db.schema.createIndex("idx_events_job_id").on("events").column("job_id").execute();

  // Seed the single default user (Spec 4 §2.5 — user_id exists from day one).
  await db
    .insertInto("users" as never)
    .values({ id: DEFAULT_USER_ID, device_token_hash: null } as never)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    "events",
    "jobs",
    "kroger_api_usage",
    "cart_runs",
    "product_matches",
    "ingredients",
    "recipes",
    "users",
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
