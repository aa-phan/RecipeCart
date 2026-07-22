// Fastify server factory (Spec 4 §2.5). Builds the app instance, registers
// shared plugins (cookie parsing, device-token auth), and installs the
// global error handler that enforces Spec 1's "never raw errors" rule.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import authPlugin from "./lib/auth.js";
import { AppError } from "./lib/errors.js";
import { logger } from "../platform/logger.js";

// Phase 4: the web SPA is served from this same process (one Railway
// service instead of a separate static host — see docs/deploy-railway.md).
// Resolves correctly both under tsx (src/api/server.ts) and the compiled
// build (dist/api/server.js): both live one level under a top-level api/
// directory, so ../../web/dist lands on the repo root / image root either
// way. `web/dist` only exists after `cd web && npm run build` has run (the
// Dockerfile does this — see its builder stage); local API-only dev without
// that build simply skips static serving rather than crashing on a missing
// root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.join(__dirname, "../../web/dist");

// ── Route plugin imports ────────────────────────────────────────────────
// None of these files exist yet. Each owning subagent uncomments ONLY its
// own import (ES imports must be top-level — that's why these live up here,
// not next to the `app.register(...)` calls below) once its route file
// lands. A missing import throws at process start, so leave the rest
// commented until they exist.

// TODO(B1): uncomment once routes/recipes.ts exists
import recipesRoutes from "./routes/recipes.js";

// TODO(B2): uncomment once routes/cart.ts exists
import cartRoutes from "./routes/cart.js";

// TODO(B3): uncomment once routes/kroger_auth.ts exists
import krogerAuthRoutes from "./routes/kroger_auth.js";

// Multi-tenancy Slice 1 (2026-07-21): Google sign-in, the front door for a
// device-token session (routes/setup.ts mints ADDITIONAL tokens once
// already signed in — this route mints the FIRST one).
import googleAuthRoutes from "./routes/google_auth.js";

// TODO(B4): uncomment once routes/preferences.ts and routes/account.ts exist
import preferencesRoutes from "./routes/preferences.js";
import accountRoutes from "./routes/account.js";
import devicesRoutes from "./routes/devices.js";

// Multi-tenancy Slice 2 (2026-07-22): per-account store location.
import storeLocationRoutes from "./routes/store_location.js";

// Sign-out (2026-07-22).
import signoutRoutes from "./routes/signout.js";

// TODO(B5): uncomment once routes/health.ts exists. Remember: that route
// must set `config: { skipAuth: true }` (see lib/auth.ts) since GET /health
// is exempt from device-token auth.
import healthRoutes from "./routes/health.js";

// TODO(WS-E, Phase 4): uncomment once routes/setup.ts exists (mints/returns
// the device token on first visit for the web token-setup page, Spec 1 A1-2).
// Must set `config: { skipAuth: true }` — issuing the first token can't
// itself require a token. Touch ONLY this import + its registration below;
// no other subagent owns routes/setup.ts.
import setupRoutes from "./routes/setup.js";

// ── Fastify request-logger redaction (gap-closer) ──────────────────────────
// Two SEPARATE logging paths exist in this codebase: the platform's bespoke
// redacting logger (src/platform/logger.ts, field-NAME pattern matching,
// used explicitly in the error handler below), and Fastify's own built-in
// pino-based request/response logger enabled via the `logger` option passed
// to `Fastify({...})`. The platform logger's redaction only ever sees
// objects that are explicitly passed to it — it has no visibility into what
// Fastify logs on its own for every request. That's this section's job.
//
// Fastify's default `req` serializer (fastify/lib/logger-pino.js) does NOT
// include `req.headers` — only method/url/host/remoteAddress/remotePort —
// so `Authorization`/`Cookie` header values are not actually serialized
// today. Even so, we configure pino's `redact` option for those paths as
// defense-in-depth: a future custom serializer (ours or a dependency's)
// that starts including headers must not silently reintroduce the leak.
//
// The REAL, currently-live leak surface is `req.url`: Fastify logs it
// verbatim, and routes/kroger_auth.ts's OAuth callback
// (GET /api/kroger/auth/callback?code=...&state=...) carries a single-use
// authorization `code` as a query parameter — a credential-shaped value
// (it's directly exchanged for Kroger access/refresh tokens in
// kroger_auth.ts) that must not land verbatim in logs. `state` is a CSRF
// nonce, not a credential, and is left as-is for debuggability. We install a
// custom `req` serializer that mirrors Fastify's default shape but redacts
// known sensitive query parameters from the logged URL first.
const SENSITIVE_QUERY_PARAM_PATTERNS = [/code/i, /token/i, /secret/i, /password/i];

function redactSensitiveQueryParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const path = url.slice(0, queryStart);
  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAM_PATTERNS.some((pattern) => pattern.test(key))) {
      params.set(key, "[REDACTED]");
    }
  }
  return `${path}?${params.toString()}`;
}

export async function buildServer(opts: { loggerStream?: Writable } = {}): Promise<FastifyInstance> {
  // Fastify's own logger is pino-based; our platform logger is a bespoke
  // redacting JSON logger with a different call shape (msg, fields) rather
  // than pino's (fields, msg). Forcing pino to wrap it isn't worth it here —
  // use Fastify's built-in logger for request/response logging, and the
  // platform logger explicitly in the error handler below (where redaction
  // of any secret-shaped field actually matters). `loggerStream` is only
  // ever supplied by tests, to capture log output in memory instead of
  // writing to stdout (see server.test.ts's real-token-probe test).
  const app = Fastify({
    logger: {
      stream: opts.loggerStream,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[REDACTED]",
      },
      serializers: {
        req(request: { method: string; url: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
          return {
            method: request.method,
            url: redactSensitiveQueryParams(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
  });

  await app.register(cookie);
  await app.register(authPlugin);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
      return;
    }
    logger.error("api: unhandled error", {
      method: request.method,
      url: request.url,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    reply
      .status(500)
      .send({ error: { code: "internal_error", message: "Something went wrong." } });
  });

  // ── Route plugin registrations ───────────────────────────────────────
  // Each is a Fastify plugin exported as:
  //   export default async function xRoutes(app: FastifyInstance) { ... }
  // Uncomment the registration below in step with uncommenting its import
  // above, once the corresponding route file exists.

  // TODO(B1): uncomment once routes/recipes.ts exists
  await app.register(recipesRoutes, { prefix: "/api/recipes" });

  // TODO(B2): uncomment once routes/cart.ts exists
  await app.register(cartRoutes, { prefix: "/api" });

  // TODO(B3): uncomment once routes/kroger_auth.ts exists
  await app.register(krogerAuthRoutes, { prefix: "/api" });

  // Multi-tenancy Slice 1 (2026-07-21)
  await app.register(googleAuthRoutes, { prefix: "/api" });

  // TODO(B4): uncomment once routes/preferences.ts and routes/account.ts exist
  await app.register(preferencesRoutes, { prefix: "/api" });
  await app.register(accountRoutes, { prefix: "/api" });
  await app.register(devicesRoutes, { prefix: "/api" });

  // Multi-tenancy Slice 2 (2026-07-22)
  await app.register(storeLocationRoutes, { prefix: "/api" });

  // Sign-out (2026-07-22)
  await app.register(signoutRoutes, { prefix: "/api" });

  // TODO(B5): uncomment once routes/health.ts exists. Remember: this route
  // must set `config: { skipAuth: true }` (see lib/auth.ts) since GET /health
  // is exempt from device-token auth.
  await app.register(healthRoutes);

  // TODO(WS-E, Phase 4): uncomment once routes/setup.ts exists.
  await app.register(setupRoutes, { prefix: "/api" });

  // ── Web SPA static serving (Phase 4) ─────────────────────────────────
  // Registered last so it never shadows an /api/* route above. Auth is
  // intentionally skipped for these routes (see lib/auth.ts's `/api/`
  // prefix check) — the app shell has no user data, AuthGate decides
  // client-side whether to prompt for a token before calling the API.
  if (fs.existsSync(webDistDir)) {
    await app.register(fastifyStatic, { root: webDistDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
        return;
      }
      // Client-side routes (e.g. /recipes/:id) aren't real files — serve
      // the SPA shell and let react-router handle the path.
      reply.sendFile("index.html");
    });
  }

  return app;
}
