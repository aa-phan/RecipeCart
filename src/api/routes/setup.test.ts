// POST /api/setup/device-token tests (Slice 2; multi-tenancy Slice 1
// rewrite, 2026-07-21). This route now mints an ADDITIONAL device token for
// the ALREADY-authenticated caller (routes/google_auth.ts mints the FIRST
// one, for a fresh sign-in) — every case here seeds a device token first
// and authenticates with it, mirroring cart.test.ts's seedToken() pattern.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

const RAW_TOKEN = "test-existing-token";
const AUTH_HEADER = { authorization: `Bearer ${RAW_TOKEN}` };

async function seedToken(): Promise<void> {
  const hash = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
  await getDb()
    .insertInto("device_tokens")
    .values({
      id: crypto.randomUUID(),
      user_id: DEFAULT_USER_ID,
      token_hash: hash,
      device_name: "Existing device",
    })
    .execute();
}

describe("POST /api/setup/device-token", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedToken();
    app = await buildServer();
  });

  it("inserts a new device_tokens row and returns { token, device }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: AUTH_HEADER,
      payload: { deviceName: "My Phone" },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.device).toMatchObject({ deviceName: "My Phone" });
    expect(typeof body.device.id).toBe("string");
    expect(typeof body.device.createdAt).toBe("string");
    expect(body.device.lastUsedAt).toBeNull();

    const hash = crypto.createHash("sha256").update(body.token).digest("hex");
    const row = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("token_hash", "=", hash)
      .executeTakeFirstOrThrow();
    expect(row.id).toBe(body.device.id);
    expect(row.user_id).toBe(DEFAULT_USER_ID);
    expect(row.device_name).toBe("My Phone");
  });

  it("defaults device name to 'Unnamed device' when omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: AUTH_HEADER,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.deviceName).toBe("Unnamed device");
  });

  it("defaults device name when an empty string is given", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: AUTH_HEADER,
      payload: { deviceName: "   " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.deviceName).toBe("Unnamed device");
  });

  it("does NOT invalidate the existing token — both remain valid", async () => {
    const minted = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: AUTH_HEADER,
      payload: { deviceName: "Device B" },
    });
    const mintedToken = minted.json().token as string;

    expect(mintedToken).not.toBe(RAW_TOKEN);

    const rows = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();
    expect(rows).toHaveLength(2);

    const existingStillWorks = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: AUTH_HEADER,
    });
    expect(existingStillWorks.statusCode).toBe(200);

    const mintedWorks = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${mintedToken}` },
    });
    expect(mintedWorks.statusCode).toBe(200);
  });

  it("sets the HttpOnly device-token cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: AUTH_HEADER,
      payload: {},
    });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("recipecart_device_token=");
    expect(String(setCookie).toLowerCase()).toContain("httponly");
  });

  // The actual point of the multi-tenancy Slice 1 rewrite: minting used to
  // be `skipAuth: true` (anyone could mint a token with full account
  // access — the vulnerability this whole rewrite closes). Now it requires
  // the same device-token auth as every other route.
  it("rejects a mint attempt with no auth at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "Intruder" },
    });
    expect(res.statusCode).toBe(401);

    const rows = await getDb().selectFrom("device_tokens").selectAll().execute();
    expect(rows).toHaveLength(1); // only the seeded one — nothing minted
  });

  it("rejects a mint attempt with an invalid token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: { deviceName: "Intruder" },
    });
    expect(res.statusCode).toBe(401);

    const rows = await getDb().selectFrom("device_tokens").selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
