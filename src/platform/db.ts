// Local-first storage (Spec 4 §2.1 / §2.4 subset).
// SQLite under ./data via Node's built-in node:sqlite (no native build step —
// deliberately avoids the better-sqlite3 node-gyp dependency). Schema mirrors
// the field names of the eventual Postgres tables (recipes/ingredients/
// product_matches/cart_runs) so the Phase 3 migration is mechanical.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.tempMediaDir, { recursive: true });

  db = new DatabaseSync(config.sqliteDbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      extraction_version TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'extracted', -- extracted | awaiting_review | approved | completed | failed
      recipe_json TEXT NOT NULL,  -- full canonical Spec 2 schema, evidence included
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      canonical_name TEXT NOT NULL,
      quantity_value REAL,
      quantity_unit TEXT,
      raw_text TEXT,
      is_pantry_staple INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_matches (
      id TEXT PRIMARY KEY,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
      candidates_json TEXT NOT NULL DEFAULT '[]', -- ranked Kroger Products API candidates
      selected_product_id TEXT,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approval_reason TEXT,
      is_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cart_runs (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | partially_completed | failed | requires_user_intervention
      results_json TEXT NOT NULL DEFAULT '[]', -- itemized per-item outcomes
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ingredients_recipe_id ON ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_product_matches_ingredient_id ON product_matches(ingredient_id);
    CREATE INDEX IF NOT EXISTS idx_cart_runs_recipe_id ON cart_runs(recipe_id);
  `);
}

export function tempDirFor(jobId: string): string {
  const dir = path.join(config.tempMediaDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Delete a job's temp media dir. Called at every terminal state — nothing
 * lingers on disk after a run finishes, fails, or is abandoned. */
export function cleanupTempDir(jobId: string): void {
  const dir = path.join(config.tempMediaDir, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
}
