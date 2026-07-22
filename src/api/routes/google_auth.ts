// Google sign-in route plugin (multi-tenancy Slice 1, 2026-07-21; open
// signup as of Slice 2, 2026-07-22 — see files/phases.md's Phase 7
// "Architecture: multi-tenancy" entry and src/auth/google.ts's header
// comment). Registered with prefix `/api` in server.ts, so paths below are
// `GET /api/auth/google/start` and `GET /api/auth/google/callback`.
//
// Structure deliberately mirrors routes/kroger_auth.ts: both routes are
// `skipAuth: true` BY NECESSITY (this IS the pre-auth entry point — nothing
// could gate it), CSRF `state` is a one-time in-memory Map entry (same
// "fine for this MVP single-instance slice" tradeoff kroger_auth.ts already
// accepts), and every failure path redirects back into the SPA with an
// `?error=` param rather than throwing a bare JSON error, since this is a
// full-page browser redirect flow with no way back from a stranded JSON
// response.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildAuthUrl, randomState, exchangeCode, fetchUserinfo } from "../../auth/google.js";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { config } from "../../platform/config.js";
import { logger } from "../../platform/logger.js";
import { mintDeviceToken, setDeviceTokenCookie } from "../lib/device_tokens.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { createdAt: number }>();

function isStateValid(state: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state); // one-time use, valid or not
  return Date.now() - entry.createdAt <= STATE_TTL_MS;
}

/** Resolves a verified Google identity to a `users.id`, applying the
 * owner-claim rule (see this file's module doc). Signup is OPEN as of
 * 2026-07-22 (explicit user call: "homebrew project, don't want an
 * allowlist") — any verified Google account gets an account, no invite
 * needed. Safe specifically BECAUSE multi-tenancy Slice 2 (per-account
 * Kroger connections, shipped in the same commit) landed alongside it: a
 * stranger signing up can now only ever affect their OWN Kroger cart, never
 * the owner's — see kroger_auth.ts/cart_runner.ts. Open signup does NOT
 * remove every risk, though — unlimited account creation still means
 * unlimited recipe submissions, and each one costs real Claude API money
 * with no rate limiting anywhere on the API yet (a real, separate,
 * still-open gap — see files/phases.md's Phase 7 "Known issues"). Never
 * returns null: every verified sign-in gets an account. */
async function resolveUserId(userinfo: { sub: string; email: string }): Promise<string> {
  const email = userinfo.email.trim().toLowerCase();
  const db = getDb();

  // 1. Already-linked account — the common case for every login after the
  // first for this identity.
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("google_sub", "=", userinfo.sub)
    .executeTakeFirst();
  if (existing) return existing.id;

  // 2. Owner-claim: the one email allowed to inherit the pre-existing
  // DEFAULT_USER_ID account (and everything already attached to it —
  // recipes, jobs, preferences) instead of starting with an empty new
  // account. Only fires once — guarded by DEFAULT_USER_ID.google_sub still
  // being null. Orthogonal to signup being open: this decides which ONE
  // sign-in inherits the legacy data, not who's allowed to sign up at all.
  if (email === config.ownerEmail && config.ownerEmail.length > 0) {
    const defaultUser = await db
      .selectFrom("users")
      .select(["id", "google_sub"])
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirst();
    if (defaultUser && !defaultUser.google_sub) {
      await db
        .updateTable("users")
        .set({ google_sub: userinfo.sub, email })
        .where("id", "=", DEFAULT_USER_ID)
        .execute();
      return DEFAULT_USER_ID;
    }
  }

  // 3. Brand-new account — this IS signup, no separate registration form.
  const id = crypto.randomUUID();
  await db.insertInto("users").values({ id, google_sub: userinfo.sub, email }).execute();
  return id;
}

export default async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /auth/google/start — generates a CSRF state token, stores it
  // server-side, and 302-redirects the browser to Google's consent page.
  app.get("/auth/google/start", { config: { skipAuth: true } }, async (_request, reply) => {
    const state = randomState();
    pendingStates.set(state, { createdAt: Date.now() });
    return reply.redirect(buildAuthUrl(state));
  });

  // GET /auth/google/callback — Google redirects the browser back here with
  // `?code=` and `?state=` on success, or `?error=` if the user declined
  // consent.
  app.get("/auth/google/callback", { config: { skipAuth: true } }, async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const { code, state, error } = query;

    const stateWasValid = typeof state === "string" && state.trim().length > 0 && isStateValid(state);

    if (typeof error === "string" && error.trim().length > 0) {
      return reply.redirect(`${config.webAppUrl}/login?error=denied`);
    }
    if (typeof code !== "string" || code.trim().length === 0 || !stateWasValid) {
      return reply.redirect(`${config.webAppUrl}/login?error=invalid_request`);
    }

    let userinfo: Awaited<ReturnType<typeof fetchUserinfo>>;
    try {
      const token = await exchangeCode(code);
      userinfo = await fetchUserinfo(token.access_token);
    } catch (err) {
      logger.warn("google_auth: code exchange or userinfo fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.redirect(`${config.webAppUrl}/login?error=exchange_failed`);
    }

    if (!userinfo.email_verified) {
      return reply.redirect(`${config.webAppUrl}/login?error=email_unverified`);
    }

    const userId = await resolveUserId(userinfo);

    const { token } = await mintDeviceToken(userId, "Browser (Google sign-in)");
    setDeviceTokenCookie(reply, token);

    return reply.redirect(`${config.webAppUrl}/?loggedIn=true`);
  });
}
