// Device-token setup route (Spec 1 A1-2, WS-E Phase 4; rewired onto
// device_tokens in Slice 2). Mints a device bearer token for the default
// user and returns it once, mirroring `recipecart create-device-token`
// (src/cli.ts) exactly — same crypto.randomBytes(32) raw token, same SHA-256
// hash, now INSERTed as a new `device_tokens` row rather than overwriting a
// single-slot column. This exists so the web app's setup screen can
// provision a token without the user needing shell access to run the CLI
// (e.g. from an iOS Shortcut's initial setup step).
//
// SECURITY (2026-07-21 fix — read before reusing this pattern elsewhere):
// this route is `skipAuth: true` (it has to be — it's how the very first
// device gets a token at all), but minting now requires a correct
// `setupSecret` matching `config.secrets.setupSecret` (the `SETUP_SECRET`
// env var), verified with a timing-safe compare below. Before this fix, the
// route was fully open — anyone who could reach the URL could mint a fresh
// device token, which (since every other /api/* route trusts any valid
// device token, and this app is single-tenant) was equivalent to full
// account takeover: read access to all recipes/preferences, and — more
// seriously — cart-approval access against the real, connected Kroger
// account. A `setupSecret` mismatch OR an unconfigured server secret both
// fail closed (reject the mint) — this is still a shared-household-secret
// model, not real multi-tenant auth (see the `Architecture: multi-tenancy`
// item in files/phases.md's Phase 7 for the eventual real fix); it's scoped
// to closing the live exploitable hole for the single-household MVP this
// app actually is today.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../platform/config.js";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { unauthorized } from "../lib/errors.js";
import type { DeviceDto } from "../lib/dto.js";

const DEFAULT_DEVICE_NAME = "Unnamed device";

/** Timing-safe compare against the configured setup secret. Hashes both
 * sides first (mirrors auth.ts's hashToken idiom) so crypto.timingSafeEqual
 * — which requires equal-length buffers — never throws on a
 * different-length guess; an unconfigured server secret always fails
 * closed rather than falling back to "no gate." */
function verifySetupSecret(provided: unknown): boolean {
  const configured = config.secrets.setupSecret;
  if (!configured) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(configured).digest();
  const b = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/setup/device-token", { config: { skipAuth: true } }, async (request, reply) => {
    const body = request.body as { deviceName?: string; setupSecret?: string } | undefined;
    if (!verifySetupSecret(body?.setupSecret)) {
      throw unauthorized();
    }
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
