// Fastify server factory (Spec 4 §2.5). Builds the app instance, registers
// shared plugins (cookie parsing, device-token auth), and installs the
// global error handler that enforces Spec 1's "never raw errors" rule.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import authPlugin from "./lib/auth.js";
import { AppError } from "./lib/errors.js";
import { logger } from "../platform/logger.js";

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

// TODO(B4): uncomment once routes/preferences.ts and routes/account.ts exist
import preferencesRoutes from "./routes/preferences.js";
import accountRoutes from "./routes/account.js";

// TODO(B5): uncomment once routes/health.ts exists. Remember: that route
// must set `config: { skipAuth: true }` (see lib/auth.ts) since GET /health
// is exempt from device-token auth.
import healthRoutes from "./routes/health.js";

export async function buildServer(): Promise<FastifyInstance> {
  // Fastify's own logger is pino-based; our platform logger is a bespoke
  // redacting JSON logger with a different call shape (msg, fields) rather
  // than pino's (fields, msg). Forcing pino to wrap it isn't worth it here —
  // use Fastify's built-in logger for request/response logging, and the
  // platform logger explicitly in the error handler below (where redaction
  // of any secret-shaped field actually matters).
  const app = Fastify({ logger: true });

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

  // TODO(B4): uncomment once routes/preferences.ts and routes/account.ts exist
  await app.register(preferencesRoutes, { prefix: "/api" });
  await app.register(accountRoutes, { prefix: "/api" });

  // TODO(B5): uncomment once routes/health.ts exists. Remember: this route
  // must set `config: { skipAuth: true }` (see lib/auth.ts) since GET /health
  // is exempt from device-token auth.
  await app.register(healthRoutes);

  return app;
}
