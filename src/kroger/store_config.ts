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

export function loadStoreLocation(): StoredStoreLocation | null {
  const p = storeConfigPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as StoredStoreLocation;
}
