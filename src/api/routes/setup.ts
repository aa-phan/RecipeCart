// Device-token setup route (Spec 1 A1-2, WS-E Phase 4). Mints a device
// bearer token for the default user and returns it once, mirroring
// `recipecart create-device-token` (src/cli.ts) exactly — same
// crypto.randomBytes(32) raw token, same SHA-256 hash stored in
// `users.device_token_hash`. This exists so the web app's setup screen can
// provision a token without the user needing shell access to run the CLI
// (e.g. from an iOS Shortcut's initial setup step).
//
// SECURITY TRADEOFF (read before reusing this pattern elsewhere): this route
// is `skipAuth: true` — completely unauthenticated. Anyone who can reach
// this URL can mint a fresh token and take over the single account, since
// minting OVERWRITES `users.device_token_hash`, silently invalidating
// whatever token was previously issued. That's only acceptable because this
// project is currently a single-household MVP beta with exactly one user
// row (DEFAULT_USER_ID) and no multi-tenancy — the CLI command this mirrors
// already has this same no-auth property as a local dev/ops command, so this
// route doesn't introduce a new class of exposure, it just moves an
// existing capability onto HTTP. Before onboarding any untrusted user, this
// needs a real gate: e.g. require an authenticated admin session to mint a
// *new* device's token, or a one-time "setup mode" flag (cleared after first
// use) instead of a permanently-open mint endpoint.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/setup/device-token", { config: { skipAuth: true } }, async (_request, reply) => {
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");

    await getDb()
      .updateTable("users")
      .set({ device_token_hash: hash })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

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

    return { token };
  });
}
