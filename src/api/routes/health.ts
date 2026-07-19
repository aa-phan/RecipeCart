// Health check route (Spec 4 §2.5, B5). Exempt from device-token auth via
// `config: { skipAuth: true }` — see lib/auth.ts for the convention.
import type { FastifyInstance } from "fastify";
import { getDb } from "../../platform/database.js";

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", { config: { skipAuth: true } }, async (_request, reply) => {
    try {
      await getDb().selectFrom("users").select("id").limit(1).execute();
    } catch {
      reply.status(503);
      return { ok: false, error: "db unreachable" };
    }
    return { ok: true };
  });
}
