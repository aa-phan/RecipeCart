// Shared device-token minting logic (multi-tenancy Slice 1, 2026-07-21).
// Extracted out of routes/setup.ts so routes/google_auth.ts's callback can
// mint the FIRST device token for a freshly-resolved identity the same way
// setup.ts mints an ADDITIONAL one for an already-logged-in user — one
// mint implementation, two entry points.
import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { getDb } from "../../platform/database.js";
import type { DeviceDto } from "./dto.js";

// setup.ts (the only caller that ever omits a name — google_auth.ts always
// passes an explicit "Browser (Google sign-in)") is scoped to the Shortcut
// as of 2026-07-22, so that's the sensible default rather than a generic
// "Unnamed device".
const DEFAULT_DEVICE_NAME = "iOS Shortcut";
const COOKIE_NAME = "recipecart_device_token";

/** Mints a device_tokens row for `userId`, returning the raw token (shown
 * once, e.g. for pasting into the iOS Shortcut) and its DTO. Does NOT set
 * the auth cookie — call setDeviceTokenCookie separately, since not every
 * caller wants to (e.g. minting a token purely for the Shortcut from an
 * already-authenticated browser shouldn't silently swap that browser's own
 * session cookie to the new token). */
export async function mintDeviceToken(
  userId: string,
  deviceName: string | undefined,
): Promise<{ token: string; device: DeviceDto }> {
  const name = deviceName && deviceName.trim().length > 0 ? deviceName.trim() : DEFAULT_DEVICE_NAME;
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");

  const row = await getDb()
    .insertInto("device_tokens")
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: hash,
      device_name: name,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    token,
    device: {
      id: row.id,
      deviceName: row.device_name,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    },
  };
}

/** Sets the HttpOnly auth cookie for `token` on the current browser. */
export function setDeviceTokenCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
