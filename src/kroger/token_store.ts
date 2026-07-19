// Encrypted storage for the user's Kroger OAuth token pair (Spec 3 §2.4,
// P1: "refresh token stored in a local encrypted file"). P3 moved this to
// the `kroger_auth` Postgres table (Spec 4 §2.4) behind the same interface
// shape — access and refresh tokens are encrypted separately (two columns)
// rather than as one JSON blob, and rows are keyed by `user_id`.
import crypto from "node:crypto";
import { config } from "../platform/config.js";
import { encrypt, decrypt } from "../platform/crypto.js";
import { getDb, DEFAULT_USER_ID } from "../platform/database.js";

export interface StoredKrogerToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export async function saveToken(
  token: StoredKrogerToken,
  userId: string = DEFAULT_USER_ID,
): Promise<void> {
  const encryptedAccessToken = encrypt(token.accessToken, config.secrets.krogerTokenKey);
  const encryptedRefreshToken = encrypt(token.refreshToken, config.secrets.krogerTokenKey);
  const expiresAt = new Date(token.expiresAt);

  await getDb()
    .insertInto("kroger_auth")
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      encrypted_access_token: encryptedAccessToken,
      encrypted_refresh_token: encryptedRefreshToken,
      expires_at: expiresAt,
    })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        expires_at: expiresAt,
        last_refreshed_at: new Date(),
      }),
    )
    .execute();
}

export async function loadToken(
  userId: string = DEFAULT_USER_ID,
): Promise<StoredKrogerToken | null> {
  const row = await getDb()
    .selectFrom("kroger_auth")
    .select(["encrypted_access_token", "encrypted_refresh_token", "expires_at"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return null;

  return {
    accessToken: decrypt(row.encrypted_access_token, config.secrets.krogerTokenKey),
    refreshToken: decrypt(row.encrypted_refresh_token, config.secrets.krogerTokenKey),
    expiresAt: row.expires_at.getTime(),
  };
}

export async function clearToken(userId: string = DEFAULT_USER_ID): Promise<void> {
  await getDb().deleteFrom("kroger_auth").where("user_id", "=", userId).execute();
}

/** True when the token is missing or expires within `skewMs` (default 60s)
 * — proactive check before starting a cart job (Spec 3 §2.3 pre-flight). */
export function isExpiredOrMissing(token: StoredKrogerToken | null, skewMs = 60_000): boolean {
  if (!token) return true;
  return Date.now() >= token.expiresAt - skewMs;
}
