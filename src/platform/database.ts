// Postgres data-access layer (Spec 4 §2.2 / §2.4). Replaces the Phase 1/2
// node:sqlite store (formerly platform/db.ts's getDb()). Kysely typed query
// builder over the `pg` driver.
//
// ─────────────────────────────────────────────────────────────────────────
// CONVENTIONS — every module that touches the DB must follow these so the
// Postgres migration stays consistent across the codebase:
//
//  1. JSON columns are `jsonb`, typed here as `JSONColumnType<T>`:
//       • WRITE:  pass a `JSON.stringify(...)` STRING on insert/update
//                 (Kysely's Insert/Update type for JSONColumnType is `string`;
//                 passing a raw JS array to a jsonb param makes node-postgres
//                 encode it as a Postgres ARRAY, which is wrong — always
//                 stringify).
//       • READ:   `pg` auto-parses jsonb, so SELECT returns the parsed `T`
//                 (no `JSON.parse` needed — that was a sqlite-era habit).
//  2. Booleans are real `boolean`, NOT 0/1 integers. Write `true`/`false`,
//     read booleans. (SQLite stored 0/1; Postgres does not.)
//  3. Timestamps are `timestamptz` with a `now()` default, returned as JS
//     `Date`. This removes the sqlite `datetime('now')` local-vs-UTC parsing
//     hazard entirely — do NOT reintroduce string date parsing
//     (`parseSqliteUtcDatetime` is obsolete under Postgres).
// ─────────────────────────────────────────────────────────────────────────
import { Kysely, PostgresDialect, type Generated, type JSONColumnType } from "kysely";
import pg from "pg";
import { config } from "./config.js";

/** The seeded single-user id used until the API slice issues real device
 * tokens (Spec 4 §2.5 — `user_id` exists from day one; multi-user later is
 * additive, not a migration). Job creation and the CLI reference this. */
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

// ── Table row types (mirror Spec 4 §2.4) ──────────────────────────────────

export interface RecipesTable {
  id: string;
  source_url: string;
  extraction_version: string;
  title: string | null;
  /** extracted | awaiting_review | approved | completed | failed */
  status: Generated<string>;
  /** full canonical Spec 2 schema, evidence included */
  recipe_json: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  failure_class: string | null;
  failure_reason: string | null;
}

export interface IngredientsTable {
  id: string;
  recipe_id: string;
  canonical_name: string;
  quantity_value: number | null;
  quantity_unit: string | null;
  raw_text: string | null;
  is_pantry_staple: Generated<boolean>;
  evidence_json: JSONColumnType<unknown[]>;
  created_at: Generated<Date>;
}

export interface ProductMatchesTable {
  id: string;
  ingredient_id: string;
  /** ranked Kroger Products API candidates (matcher's ProductCandidate[]) */
  candidates_json: JSONColumnType<unknown[]>;
  selected_product_id: string | null;
  requires_approval: Generated<boolean>;
  approval_reason: string | null;
  is_approved: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CartRunsTable {
  id: string;
  recipe_id: string;
  idempotency_key: string;
  /** pending | completed | partially_completed | failed | requires_user_intervention */
  status: Generated<string>;
  /** itemized per-item outcomes */
  results_json: JSONColumnType<unknown[]>;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface KrogerApiUsageTable {
  /** UTC date, YYYY-MM-DD */
  day: string;
  /** 'products' | 'locations' | 'cart' */
  endpoint: string;
  count: Generated<number>;
}

export interface UsersTable {
  id: string;
  /** device-bound bearer token, hashed at rest (Spec 4 §2.5). Nullable until
   * the API slice issues device tokens; the seeded default user has null. */
  device_token_hash: string | null;
  created_at: Generated<Date>;
}

export interface JobsTable {
  id: string;
  user_id: string;
  source_url: string;
  recipe_id: string | null;
  /** job-state machine (Spec 4 §2.3): received | validating | downloading |
   * processing_media | extracting_recipe | matching_products |
   * awaiting_review | approved | adding_to_cart | completed |
   * partially_completed | failed | requires_user_intervention | expired */
  status: Generated<string>;
  /** progress representation surfaced to the UI (Spec 4 §2.3) — no percentage */
  stage: Generated<string>;
  locked_by: string | null;
  locked_at: Date | null;
  run_after: Generated<Date>;
  attempt_count: Generated<number>;
  last_error: string | null;
  /** duplicate-URL derived key (token + url + time window) — a double submit
   * surfaces the existing job (Spec 4 §2.5). */
  idempotency_key: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EventsTable {
  id: Generated<number>;
  job_id: string | null;
  recipe_id: string | null;
  type: string;
  data: JSONColumnType<Record<string, unknown>> | null;
  created_at: Generated<Date>;
}

export interface KrogerAuthTable {
  id: string;
  user_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  expires_at: Date;
  store_location_id: string | null;
  last_refreshed_at: Generated<Date>;
}

export interface PreferencesTable {
  user_id: string;
  store_brand_preferred: Generated<boolean>;
  organic_preferred: Generated<boolean>;
  dietary_tags: JSONColumnType<string[]>;
  pantry_always_owned: JSONColumnType<string[]>;
  updated_at: Generated<Date>;
}

export interface DB {
  recipes: RecipesTable;
  ingredients: IngredientsTable;
  product_matches: ProductMatchesTable;
  cart_runs: CartRunsTable;
  kroger_api_usage: KrogerApiUsageTable;
  users: UsersTable;
  jobs: JobsTable;
  events: EventsTable;
  kroger_auth: KrogerAuthTable;
  preferences: PreferencesTable;
}

// ── Instance (lazy singleton, mirrors the old getDb() shape) ───────────────

let instance: Kysely<DB> | undefined;
let pool: pg.Pool | undefined;

/** The single app-wide Kysely instance. Lazy so importing this module doesn't
 * open a connection before one is needed (e.g. `recipecart --help`). */
export function getDb(): Kysely<DB> {
  if (instance) return instance;
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  instance = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return instance;
}

/** Close the pool — for graceful worker shutdown (Spec 4 §2.2 SIGTERM) and
 * test teardown. Safe to call when never opened. */
export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy(); // also ends the underlying pool
    instance = undefined;
    pool = undefined;
  }
}
