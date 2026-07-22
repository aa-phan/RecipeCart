// POST /api/auth/signout tests (2026-07-22). Confirms sign-out revokes
// ONLY the calling session's own token, clears its cookie, and leaves
// every other device on the same account untouched.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

const RAW_TOKEN_A = "session-a-token";
const RAW_TOKEN_B = "session-b-token";
const AUTH_A = { authorization: `Bearer ${RAW_TOKEN_A}` };
const AUTH_B = { authorization: `Bearer ${RAW_TOKEN_B}` };

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function seedTwoSessions(): Promise<void> {
  await getDb()
    .insertInto("device_tokens")
    .values([
      {
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: hash(RAW_TOKEN_A),
        device_name: "Session A",
      },
      {
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: hash(RAW_TOKEN_B),
        device_name: "Session B",
      },
    ])
    .execute();
}

describe("POST /api/auth/signout", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedTwoSessions();
    app = await buildServer();
  });

  it("revokes only the calling session's own token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/signout", headers: AUTH_A });
    expect(res.statusCode).toBe(204);

    const rows = await getDb()
      .selectFrom("device_tokens")
      .select("token_hash")
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hash(RAW_TOKEN_B)); // session B untouched
  });

  it("the revoked token no longer authenticates", async () => {
    await app.inject({ method: "POST", url: "/api/auth/signout", headers: AUTH_A });

    const res = await app.inject({ method: "GET", url: "/api/devices", headers: AUTH_A });
    expect(res.statusCode).toBe(401);
  });

  it("the other session's token still works after this one signs out", async () => {
    await app.inject({ method: "POST", url: "/api/auth/signout", headers: AUTH_A });

    const res = await app.inject({ method: "GET", url: "/api/devices", headers: AUTH_B });
    expect(res.statusCode).toBe(200);
  });

  it("clears the auth cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/signout", headers: AUTH_A });
    const setCookie = String(res.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("recipecart_device_token=");
    // Cleared cookies are sent with an empty value / immediate expiry.
    expect(setCookie).toMatch(/recipecart_device_token=;|Expires=Thu, 01 Jan 1970/);
  });

  it("rejects a sign-out attempt with no auth at all", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/signout" });
    expect(res.statusCode).toBe(401);
  });
});
