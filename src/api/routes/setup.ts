// Device-token setup route (Spec 1 A1-2, WS-E Phase 4; rewired onto
// device_tokens in Slice 2). Mints a device bearer token for the default
// user and returns it once, mirroring `recipecart create-device-token`
// (src/cli.ts) exactly — same crypto.randomBytes(32) raw token, same SHA-256
// hash, now INSERTed as a new `device_tokens` row rather than overwriting a
// single-slot column. This exists so the web app's setup screen can
// provision a token without the user needing shell access to run the CLI
// (e.g. from an iOS Shortcut's initial setup step).
//
// SECURITY TRADEOFF (read before reusing this pattern elsewhere): this route
// is `skipAuth: true` — completely unauthenticated. Anyone who can reach
// this URL can mint a fresh device token for the account. Since minting now
// ADDS a new device_tokens row instead of overwriting the old one, it no
// longer silently invalidates other devices' tokens — but it's still an
// open mint endpoint, acceptable only because this project is currently a
// single-household MVP beta with exactly one user row (DEFAULT_USER_ID) and
// no multi-tenancy. Before onboarding any untrusted user, this needs a real
// gate: e.g. require an authenticated admin session to mint a *new* device's
// token, or a one-time "setup mode" flag (cleared after first use) instead
// of a permanently-open mint endpoint.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import type { DeviceDto } from "../lib/dto.js";

const DEFAULT_DEVICE_NAME = "Unnamed device";

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/setup/device-token", { config: { skipAuth: true } }, async (request, reply) => {
    const body = request.body as { deviceName?: string } | undefined;
    const deviceName =
      typeof body?.deviceName === "string" && body.deviceName.trim().length > 0
        ? body.deviceName.trim()
        : DEFAULT_DEVICE_NAME;

    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");

    const row = await getDb()
      .insertInto("device_tokens")
      .values({
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: hash,
        device_name: deviceName,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Also log the CURRENT browser in immediately via an HttpOnly cookie —
    // the original AuthGate design (web/src/auth/AuthGate.tsx) required a
    // separate manual copy-paste-into-a-form step because it had no server
    // route to hand the cookie off from; this route now IS that server
    // route, so there's no reason to keep the extra hop. The response body
    // still returns the raw token too — that's still needed for copying
    // into the iOS Shortcut, a completely separate consumer that can't read
    // an HttpOnly cookie (nor should it: Shortcuts stores it as plain
    // config, not a cookie jar).
    reply.setCookie("recipecart_device_token", token, {
      httpOnly: true,
      path: "/",
      maxAge: 31536000,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    const device: DeviceDto = {
      id: row.id,
      deviceName: row.device_name,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    };

    return { token, device };
  });
}
