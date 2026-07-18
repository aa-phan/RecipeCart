// Local encrypted storage for the user's Kroger OAuth token pair (Spec 3
// §2.4, P1: "refresh token stored in a local encrypted file"). P3+ moves
// this to the `kroger_auth` Postgres table (Spec 4 §2.4) behind the same
// interface shape.
import fs from "node:fs";
import { config } from "../platform/config.js";
import { encrypt, decrypt } from "../platform/crypto.js";

export interface StoredKrogerToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export function saveToken(token: StoredKrogerToken): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const payload = encrypt(JSON.stringify(token), config.secrets.krogerTokenKey);
  fs.writeFileSync(config.krogerTokenStatePath, payload, { mode: 0o600 });
}

export function loadToken(): StoredKrogerToken | null {
  if (!fs.existsSync(config.krogerTokenStatePath)) return null;
  const payload = fs.readFileSync(config.krogerTokenStatePath, "utf8");
  const decrypted = decrypt(payload, config.secrets.krogerTokenKey);
  return JSON.parse(decrypted) as StoredKrogerToken;
}

export function clearToken(): void {
  if (fs.existsSync(config.krogerTokenStatePath)) {
    fs.rmSync(config.krogerTokenStatePath);
  }
}

/** True when the token is missing or expires within `skewMs` (default 60s)
 * — proactive check before starting a cart job (Spec 3 §2.3 pre-flight). */
export function isExpiredOrMissing(token: StoredKrogerToken | null, skewMs = 60_000): boolean {
  if (!token) return true;
  return Date.now() >= token.expiresAt - skewMs;
}
