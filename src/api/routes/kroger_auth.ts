// Kroger OAuth2 callback route plugin (Phase 3, B3 slice — Spec 4 §2.5).
// Registered with prefix `/api` in server.ts, so paths below are
// `GET /api/kroger/auth/start` and `GET /api/kroger/auth/callback`.
//
// Both routes are unauthenticated (`config: { skipAuth: true }`) BY
// NECESSITY: this is a browser redirect flow through Kroger's own consent
// page, which can't carry a device-token bearer header. That means, in this
// MVP model, connecting a Kroger account does not require the app's own
// device auth to already be established — a deliberate but real tradeoff,
// not one to silently smooth over. A production hardening pass might tie
// `/start` to an existing device-token session (e.g. via a short-lived
// cookie) before allowing the redirect, but that's out of scope here.
import type { FastifyInstance } from "fastify";
import { buildAuthUrl, randomState, exchangeCode } from "../../kroger/auth.js";
import { saveToken } from "../../kroger/token_store.js";
import { badRequest } from "../lib/errors.js";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";

// CSRF `state` bookkeeping. A browser-redirect OAuth flow is stateless
// across the round trip (the browser leaves and comes back later), so we
// stash each generated `state` value server-side keyed by itself and check
// it on callback: one-time use, rejected once ~10 minutes old. This
// in-memory Map is fine for this MVP single-instance slice; a multi-instance
// production deployment would need this in Redis/Postgres instead, but
// that's explicitly out of scope for now.
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { createdAt: number }>();

function isStateValid(state: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state); // one-time use, valid or not
  return Date.now() - entry.createdAt <= STATE_TTL_MS;
}

export default async function krogerAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /kroger/auth/start — generates a CSRF state token, stores it
  // server-side, and 302-redirects the browser to Kroger's consent page.
  app.get("/kroger/auth/start", { config: { skipAuth: true } }, async (_request, reply) => {
    const state = randomState();
    pendingStates.set(state, { createdAt: Date.now() });
    return reply.redirect(buildAuthUrl(state));
  });

  // GET /kroger/auth/callback — Kroger redirects the browser back here with
  // `?code=` and `?state=` on success, or `?error=` (e.g. `access_denied`,
  // no `code` at all) if the user declined consent. Validate state
  // (CSRF/replay guard), exchange the code for a token pair, persist it,
  // then redirect into the SPA. Every failure path below redirects back into
  // the SPA (`/connect-kroger?error=...`) instead of throwing a raw JSON
  // error — this is a full-page browser redirect flow, so a thrown
  // badRequest/500 would strand the user on a bare JSON response with no way
  // back into the app (the bug this route plugin was fixed for).
  //
  // Note on resumeRecipeId: ConnectKroger.tsx already stashes
  // `?resumeRecipeId` into sessionStorage BEFORE the user ever clicks
  // through to `/kroger/auth/start` (a plain `<a>` with no query params of
  // its own), and sessionStorage survives the full same-tab OAuth redirect
  // round trip. So there's no need for this route to thread resumeRecipeId
  // through the `state` map itself — the client-side value already survives
  // untouched all the way back to whichever `/connect-kroger?error=...`
  // landing this callback redirects to.
  app.get("/kroger/auth/callback", { config: { skipAuth: true } }, async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const { code, state, error } = query;

    // Consume the state token (one-time use) up front, before either the
    // error check or the success-path validation below re-reads it —
    // isStateValid() deletes the entry on first lookup, so it must only be
    // called once per request no matter which branch follows.
    const stateWasValid = typeof state === "string" && state.trim().length > 0 && isStateValid(state);

    if (typeof error === "string" && error.trim().length > 0) {
      return reply.redirect(`${config.webAppUrl}/connect-kroger?error=denied`);
    }

    if (typeof code !== "string" || code.trim().length === 0) {
      throw badRequest("code query parameter is required");
    }
    if (typeof state !== "string" || state.trim().length === 0) {
      throw badRequest("state query parameter is required");
    }
    if (!stateWasValid) {
      throw badRequest("state is missing, invalid, or expired");
    }

    try {
      const token = await exchangeCode(code);
      await saveToken({
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? "",
        expiresAt: Date.now() + token.expires_in * 1000,
      });
    } catch (err) {
      // Bad/expired code, or the token exchange itself failing — surface as
      // a redirect back into the SPA, not an unhandled 500.
      logger.warn("kroger_auth: code exchange or token save failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.redirect(`${config.webAppUrl}/connect-kroger?error=exchange_failed`);
    }

    // MUST be absolute: a relative path would resolve against this API
    // server's own origin, not the (possibly different-origin, e.g. local
    // dev's Vite server) web app — see config.webAppUrl's doc comment.
    return reply.redirect(`${config.webAppUrl}/?krogerConnected=true`);
  });
}
