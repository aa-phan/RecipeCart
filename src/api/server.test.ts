// Real-token-probe test (Spec 4 §7 checklist item: "Log redaction verified
// with a real token/key probe"). Boots the REAL server via buildServer()
// (no mocking of Fastify or the router), injects a real request carrying a
// real-shaped device token in both the Authorization header and the auth
// cookie, and asserts the planted token value never appears verbatim
// anywhere in Fastify's own captured log output.
//
// This exercises the gap-closer added in server.ts: Fastify's built-in
// pino logger is a separate logging path from src/platform/logger.ts (which
// is already covered by its own redaction unit tests) and previously had no
// redaction configured at all.
import crypto from "node:crypto";
import type { Writable } from "node:stream";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../platform/database.js";
import { resetDb } from "../platform/test-db.js";
import { buildServer } from "./server.js";

// Real-shaped device token: same format as lib/auth.ts expects (an opaque
// bearer string, sha256-hashed and compared against `device_tokens.token_hash`).
const PLANTED_TOKEN = "rc_live_9f3a1d7c2b6e4589a0d1f2c3b4a5968712345678";

class CapturingStream {
  lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

async function seedPlantedToken(): Promise<void> {
  const hash = crypto.createHash("sha256").update(PLANTED_TOKEN).digest("hex");
  await getDb()
    .insertInto("device_tokens")
    .values({
      id: crypto.randomUUID(),
      user_id: DEFAULT_USER_ID,
      token_hash: hash,
      device_name: "Test device",
    })
    .execute();
}

describe("server log redaction (real token probe)", () => {
  let app: FastifyInstance;
  let capture: CapturingStream;

  beforeEach(async () => {
    await resetDb();
    await seedPlantedToken();
    capture = new CapturingStream();
    app = await buildServer({ loggerStream: capture as unknown as Writable });
  });

  it("never logs the planted token verbatim via Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${PLANTED_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    expect(capture.lines.length).toBeGreaterThan(0);
    expect(capture.text).not.toContain(PLANTED_TOKEN);
  });

  it("never logs the planted token verbatim via the device-token cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { cookie: `recipecart_device_token=${PLANTED_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    expect(capture.lines.length).toBeGreaterThan(0);
    expect(capture.text).not.toContain(PLANTED_TOKEN);
  });

  it("redacts a Kroger OAuth `code` query parameter from the logged request URL", async () => {
    // /api/kroger/auth/callback is unauthenticated and validates `state`
    // before doing anything else, so an invalid/never-issued state (400) is
    // enough to exercise request logging without needing a real Kroger
    // token exchange.
    const plantedCode = "kroger-oauth-code-abcdef123456";
    const res = await app.inject({
      method: "GET",
      url: `/api/kroger/auth/callback?code=${plantedCode}&state=never-issued`,
    });
    expect(res.statusCode).toBe(400);

    expect(capture.lines.length).toBeGreaterThan(0);
    expect(capture.text).not.toContain(plantedCode);
  });
});
