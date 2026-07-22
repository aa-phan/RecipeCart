// Device-token mint route (Spec 1 A1-2, WS-E Phase 4; multi-tenancy Slice 1
// rewrite, 2026-07-21). Mints an ADDITIONAL device bearer token for the
// CALLING user — e.g. adding the iOS Shortcut as a second device once
// you're already signed in via Google in a browser (routes/google_auth.ts
// mints the FIRST token, for that same reason: there's no "already signed
// in" state yet at that point).
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
import { mintDeviceToken, setDeviceTokenCookie } from "../lib/device_tokens.js";

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/setup/device-token", async (request, reply) => {
    const body = request.body as { deviceName?: string } | undefined;
    const { token, device } = await mintDeviceToken(request.userId, body?.deviceName);

    // Also logs the CURRENT browser in via the HttpOnly cookie — harmless
    // when the caller is minting a token purely for the Shortcut (this
    // browser was already authenticated to make this call at all; setting
    // the same identity's cookie again is a no-op in practice). The
    // response body still returns the raw token too — needed for copying
    // into the iOS Shortcut, a completely separate consumer that can't
    // read an HttpOnly cookie (nor should it: Shortcuts stores it as plain
    // config, not a cookie jar).
    setDeviceTokenCookie(reply, token);

    return { token, device };
  });
}
