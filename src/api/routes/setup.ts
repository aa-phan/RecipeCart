// Shortcut-token mint route (Spec 1 A1-2, WS-E Phase 4; multi-tenancy Slice
// 1 rewrite, 2026-07-21; re-scoped to the Shortcut specifically, 2026-07-22
// — see files/phases.md's Phase 7 "Architecture: multi-tenancy" entry).
// Mints an ADDITIONAL device bearer token for the CALLING user. A BROWSER
// never needs this anymore — it should just sign in with Google directly
// (routes/google_auth.ts), which mints its own token/cookie automatically.
// The one real remaining use case is the iOS Shortcut: it can't do a
// browser OAuth redirect or read an HttpOnly cookie, so it needs a raw
// copyable token, minted here once you're already signed in elsewhere.
//
// SECURITY HISTORY (read before reusing this pattern elsewhere): this route
// used to be `skipAuth: true` — completely unauthenticated. Anyone who
// could reach the URL could mint a fresh device token for the (at the time,
// only ever one) account, which — since every other /api/* route trusts
// any valid device token — was equivalent to full account takeover. A
// standalone shared-passphrase gate was built and deployed as a stopgap,
// then explicitly reverted in favor of this real fix: now that Google
// sign-in (google_auth.ts) gives every account a genuine identity, this
// route just needs the SAME device-token auth every other route already
// requires — no more skipAuth, no bespoke gate of its own.
import type { FastifyInstance } from "fastify";
import { mintDeviceToken } from "../lib/device_tokens.js";

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/setup/device-token", async (request) => {
    const body = request.body as { deviceName?: string } | undefined;
    // Deliberately does NOT call setDeviceTokenCookie — the calling
    // browser is already authenticated (it had to be, to reach this
    // route) and should stay on its own session/cookie. This mint exists
    // purely to hand a raw token to a non-browser consumer (the Shortcut),
    // not to re-authenticate the browser making the request.
    const { token, device } = await mintDeviceToken(request.userId, body?.deviceName);
    return { token, device };
  });
}
