// Vitest globalSetup (see vitest.config.ts). Runs migrations once against the
// TEST database before the suite. Individual DB tests then call resetDb()
// (test-db.ts) in beforeEach to truncate between cases. Point tests at a
// dedicated test DB via TEST_DATABASE_URL — never the dev DB.
export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set — the test suite needs a dedicated Postgres " +
        "database (see .env.example). Refusing to run against the default DB.",
    );
  }
  // Force config/getDb (which read DATABASE_URL) to the test DB *before* any
  // app module that imports config is loaded. dotenv does not override an
  // already-set env var, so this wins over .env.
  process.env.DATABASE_URL = testUrl;

  const { migrateToLatest } = await import("./migrate.js");
  const { closeDb } = await import("./database.js");
  await migrateToLatest();
  await closeDb();
}
