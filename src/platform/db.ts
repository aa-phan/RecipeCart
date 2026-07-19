// Temp-media filesystem helpers. The DB layer moved to platform/database.ts
// (Postgres/Kysely, Spec 4 §2.2) — this module now only owns the per-job temp
// media directory lifecycle, which is filesystem, not database, state.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

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
