// Sign-out route (2026-07-22 — a real gap found live: nothing anywhere in
// the app let you end your own session). Registered with prefix `/api` in
// server.ts, so this is `POST /api/auth/signout`.
//
// "Sign out" means ending THIS session specifically — revoke the exact
// device_tokens row this request authenticated with (request.deviceId,
// set by lib/auth.ts) and clear the cookie, leaving every other
// device/session on this account untouched. Deliberately reuses the same
// mechanism the Devices screen's per-device "Revoke" button already uses
// (DELETE /api/devices/:id) rather than inventing a second one — this
// route's only real addition is knowing WHICH device id to revoke (its
// own) and clearing the cookie so the browser doesn't keep sending a
// now-dead token.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";
import { COOKIE_NAME } from "../lib/auth.js";

export default async function signoutRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/signout", async (request, reply) => {
    await getDb().deleteFrom("device_tokens").where("id", "=", request.deviceId).execute();
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    reply.status(204);
    return null;
  });
}
