// Device-token auth plugin (Spec 4 §2.5). A single `preHandler` hook applied
// globally in server.ts — every route is authenticated by default. Routes
// that must be reachable without a token (currently only B5's health route)
// opt out explicitly via `config: { skipAuth: true }` on the route
// registration, e.g.:
//
//   app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));
//
// This is a deliberate convention over a hardcoded path check: the plugin
// has no knowledge of specific route paths, so future unauthenticated routes
// (if any) just set the same config flag rather than requiring an edit here.
import crypto from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDb } from "../../platform/database.js";
import { unauthorized } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

const COOKIE_NAME = "recipecart_device_token";

function extractToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.length > 0) return token;
  }
  const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies;
  const cookieToken = cookies?.[COOKIE_NAME];
  if (cookieToken && cookieToken.length > 0) return cookieToken;
  return undefined;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request) => {
    if (request.routeOptions.config?.skipAuth) return;
    // The web SPA's static assets (Phase 4: served from this same process
    // via @fastify/static, see server.ts) are registered by a third-party
    // plugin that doesn't expose a way to attach `config.skipAuth` per
    // route. They're intentionally public anyway: the HTML/JS/CSS shell
    // carries no user data — AuthGate (web/src/auth/AuthGate.tsx) decides
    // client-side, after load, whether to show the paste-token form before
    // any *API* call is made. Only `/api/*` routes need the device-token
    // gate; everything else this process serves is the public app shell.
    if (!request.url.split("?")[0]!.startsWith("/api/")) return;

    const token = extractToken(request);
    if (!token) throw unauthorized();

    const hash = hashToken(token);
    const user = await getDb()
      .selectFrom("users")
      .where("device_token_hash", "=", hash)
      .selectAll()
      .executeTakeFirst();
    if (!user) throw unauthorized();

    request.userId = user.id;
  });
}

export default fp(authPlugin, { name: "auth-plugin" });
