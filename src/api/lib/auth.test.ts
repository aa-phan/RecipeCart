// Auth preHandler tests (Slice 2 rewire onto device_tokens). Confirms the
// lookup now goes through device_tokens.token_hash (not users.device_token_hash),
// that request.userId comes from the owning row's user_id, that an unknown
// token is rejected, and that a successful auth bumps last_used_at
// best-effort without blocking the response.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

const RAW_TOKEN = "test-device-token-auth";

async function seedToken(): Promise<string> {
  const hash = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
  const id = crypto.randomUUID();
  await getDb()
    .insertInto("device_tokens")
    .values({ id, user_id: DEFAULT_USER_ID, token_hash: hash, device_name: "Auth test device" })
    .execute();
  return id;
}

describe("auth preHandler", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await buildServer();
  });

  it("authenticates a request whose bearer token matches a device_tokens row", async () => {
    await seedToken();
    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a token with no matching device_tokens row", async () => {
    await seedToken();
    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with no token at all", async () => {
    const res = await app.inject({ method: "GET", url: "/api/preferences" });
    expect(res.statusCode).toBe(401);
  });

  it("no longer authenticates via the legacy users.device_token_hash column", async () => {
    const legacyHash = crypto.createHash("sha256").update("legacy-token").digest("hex");
    await getDb()
      .updateTable("users")
      .set({ device_token_hash: legacyHash })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: "Bearer legacy-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("bumps last_used_at on a successful auth (best-effort, eventually visible)", async () => {
    const deviceId = await seedToken();

    const before = await getDb()
      .selectFrom("device_tokens")
      .select("last_used_at")
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
    expect(before.last_used_at).toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    // Fire-and-forget update — give it a tick to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await getDb()
      .selectFrom("device_tokens")
      .select("last_used_at")
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
    expect(after.last_used_at).not.toBeNull();
  });
});
