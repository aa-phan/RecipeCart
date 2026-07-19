// Kysely migration runner (Spec 4 §2.2). A static in-code migration provider
// (rather than FileMigrationProvider) so it works uniformly under tsx/ESM and
// after a tsc build without any filesystem-path juggling. Add new migrations
// by importing them into the `migrations` map below, keyed by an ordered name.
// kysely 0.29 moved the migration API to the `kysely/migration` subpath (the
// root barrel deprecated it) — verified against the installed package.
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { type Kysely } from "kysely";
import { getDb, closeDb, type DB } from "./database.js";
import * as m001 from "./migrations/001_initial.js";
import * as m002 from "./migrations/002_auth_and_preferences.js";

const migrations: Record<string, Migration> = {
  "001_initial": m001,
  "002_auth_and_preferences": m002,
};

class StaticProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export function makeMigrator(db: Kysely<DB>): Migrator {
  return new Migrator({ db, provider: new StaticProvider() });
}

/** Run all pending migrations. Idempotent — safe to call on every boot. */
export async function migrateToLatest(db: Kysely<DB> = getDb()): Promise<void> {
  const { error, results } = await makeMigrator(db).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Success") {
      console.log(`migration "${r.migrationName}" applied`);
    } else if (r.status === "Error") {
      console.error(`migration "${r.migrationName}" FAILED`);
    }
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

// `tsx src/platform/migrate.ts` (or the built dist entry) runs migrations then
// exits — used by `npm run migrate` and the docker-compose worker start.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateToLatest()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
