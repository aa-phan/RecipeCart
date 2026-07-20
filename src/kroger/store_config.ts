// Target store persistence (Spec 3 §14). Flat JSON file for P1 — locationId
// isn't sensitive, so no encryption needed (contrast token_store.ts). P3+
// this becomes a `preferences` row (Spec 4 §2.4), deferred per phases.md
// Phase 1 scope ("preferences" is explicitly out until P3).
import fs from "node:fs";
import path from "node:path";
import { config } from "../platform/config.js";

export interface StoredStoreLocation {
  locationId: string;
  name: string;
  zipCode: string;
}

function storeConfigPath(): string {
  return path.join(config.dataDir, "store.json");
}

export function saveStoreLocation(location: StoredStoreLocation): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(storeConfigPath(), JSON.stringify(location, null, 2));
}

/** Falls back to env vars when the local `store.json` file isn't present —
 * real gap found 2026-07-20: the API service (unlike the worker) has no
 * persistent volume/DATA_DIR on Railway, so any API-side caller of
 * `loadStoreLocation` (e.g. the Review screen's amount-edit re-match)
 * always saw a `null` store and silently no-op'd, even though the worker's
 * own matching has a real store configured on its own volume. Same
 * single-target-store value, just reachable from a container with no
 * filesystem access to the worker's volume. */
export function loadStoreLocation(): StoredStoreLocation | null {
  const p = storeConfigPath();
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredStoreLocation;
  }
  const locationId = process.env.STORE_LOCATION_ID;
  if (!locationId) return null;
  return {
    locationId,
    name: process.env.STORE_NAME ?? "",
    zipCode: process.env.STORE_ZIP_CODE ?? "",
  };
}
