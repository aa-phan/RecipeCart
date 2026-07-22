// Kroger OAuth2 callback route plugin (Phase 3, B3 slice — Spec 4 §2.5;
// per-user threading added multi-tenancy Slice 2, 2026-07-22).
// Registered with prefix `/api` in server.ts, so paths below are
// `GET /api/kroger/auth/start` and `GET /api/kroger/auth/callback`.
//
// `/start` requires normal device-token auth (cookie or bearer) as of
// Slice 2 — connecting Kroger now needs to know WHICH account is
// connecting, so the account's own store/cart stop landing on
// DEFAULT_USER_ID regardless of who's actually signed in. `ConnectKroger.tsx`
// already navigates here via a plain `<a href="/api/kroger/auth/start">`
// browser click, which carries the session cookie same as any other
// same-origin navigation — no frontend change needed for this.
//
// `/callback` STAYS `skipAuth: true` BY NECESSITY: Kroger's redirect back
// to this URL doesn't carry our own auth cookie/header in a way we can rely
// on cross-provider, so it resolves the account via the `state` map entry
// `/start` created instead (which DOES know the account, from its own
// auth) — same CSRF one-time-use design as before, now carrying `userId`
// alongside `createdAt`.
import type { FastifyInstance } from "fastify";
import { buildAuthUrl, randomState, exchangeCode } from "../../kroger/auth.js";
import { saveToken } from "../../kroger/token_store.js";
import { badRequest } from "../lib/errors.js";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { createdAt: number; userId: string }>();

/** One-time-use lookup: returns the userId that started this OAuth flow, or
 * undefined if the state is missing, already consumed, or expired. */
function consumeState(state: string): string | undefined {
  const entry = pendingStates.get(state);
  if (!entry) return undefined;
  pendingStates.delete(state); // one-time use, valid or not
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return undefined;
  return entry.userId;
}

export default async function krogerAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /kroger/auth/start — generates a CSRF state token, stashes it
  // server-side alongside the CALLING account's id, and 302-redirects the
  // browser to Kroger's consent page.
  app.get("/kroger/auth/start", async (request, reply) => {
    const state = randomState();
    pendingStates.set(state, { createdAt: Date.now(), userId: request.userId });
    return reply.redirect(buildAuthUrl(state));
  });

  // GET /kroger/auth/callback — Kroger redirects the browser back here with
  // `?code=` and `?state=` on success, or `?error=` (e.g. `access_denied`,
  // no `code` at all) if the user declined consent. Resolves state to the
  // account that started the flow (CSRF/replay guard, same one-time-use
  // discipline as before), exchanges the code for a token pair, persists it
  // for THAT account, then redirects into the SPA. Every failure path below
  // redirects back into the SPA (`/connect-kroger?error=...`) instead of
  // throwing a raw JSON error — this is a full-page browser redirect flow,
  // so a thrown badRequest/500 would strand the user on a bare JSON
  // response with no way back into the app (the bug this route plugin was
  // fixed for).
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
    // consumeState() deletes the entry on first lookup, so it must only be
    // called once per request no matter which branch follows.
    const stateUserId =
      typeof state === "string" && state.trim().length > 0 ? consumeState(state) : undefined;

    if (typeof error === "string" && error.trim().length > 0) {
      return reply.redirect(`${config.webAppUrl}/connect-kroger?error=denied`);
    }

    if (typeof code !== "string" || code.trim().length === 0) {
      throw badRequest("code query parameter is required");
    }
    if (typeof state !== "string" || state.trim().length === 0) {
      throw badRequest("state query parameter is required");
    }
    if (!stateUserId) {
      throw badRequest("state is missing, invalid, or expired");
    }

    try {
      const token = await exchangeCode(code);
      await saveToken(
        {
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? "",
          expiresAt: Date.now() + token.expires_in * 1000,
        },
        stateUserId,
      );
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
