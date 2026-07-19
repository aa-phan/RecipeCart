// Health check route (Spec 4 §2.5, B5; deploy-check wiring per Spec 4 §2.7).
// Exempt from device-token auth via `config: { skipAuth: true }` — see
// lib/auth.ts for the convention. Railway's rolling-restart gate polls this
// during deploys and only cuts traffic over to the new instance once it
// returns 200 — so a false "ok: true" here can wedge a broken deploy into
// production, and a false 503 can block an otherwise-good deploy forever.
//
// Deliberately DB-reachability-only, not worker-liveness. Considered adding
// a worker-heartbeat check (e.g. "most recent `jobs.locked_at` is recent"),
// but rejected it: `locked_at` is per-job (null whenever the queue is
// simply empty, which is a perfectly healthy idle state, not a dead
// worker), and src/platform/jobs.ts has no dedicated worker-heartbeat row
// to check instead. More fundamentally, this route lives in the API
// service's image, while the worker is a SEPARATE Railway service in
// Phase 4's deploy model (see railway.toml vs railway.worker.toml) with its
// own process lifecycle — a shared `/health` route in the API image can't
// meaningfully reflect the worker's health, and Railway checks each
// service's health independently anyway. If worker liveness ever needs a
// deploy gate, it belongs on a `/health` route served BY the worker
// process, not bolted onto this one.
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
