// Test DB helpers. DB-touching tests import resetDb() and call it in
// beforeEach so each case starts from a clean, migrated schema. The migration
// itself runs once in globalSetup (test-setup.ts). File parallelism is
// disabled (vitest.config.ts) so TRUNCATE between files never races.
import { sql } from "kysely";
import { getDb, DEFAULT_USER_ID } from "./database.js";

const ALL_TABLES = [
  "events",
  "jobs",
  "cart_runs",
  "product_matches",
  "ingredients",
  "recipes",
  "kroger_api_usage",
  "users",
] as const;

/** Truncate every table and re-seed the default user. RESTART IDENTITY resets
 * the events bigserial; CASCADE handles FK order. */
export async function resetDb(): Promise<void> {
  const db = getDb();
  await sql`TRUNCATE TABLE ${sql.raw(ALL_TABLES.join(", "))} RESTART IDENTITY CASCADE`.execute(db);
  await db.insertInto("users").values({ id: DEFAULT_USER_ID, device_token_hash: null }).execute();
}
