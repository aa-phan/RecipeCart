// POST /api/setup/device-token tests (Slice 2; setupSecret gate added
// 2026-07-21). Confirms minting INSERTs a new device_tokens row (rather
// than overwriting a single-slot column, the old behavior), returns
// { token, device } per the frozen DTO contract, that a previously-minted
// token keeps working after a second mint, and that the setupSecret gate
// actually rejects a mint without the correct shared passphrase.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

// Matches vitest.config.ts's fixed test-env SETUP_SECRET.
const SETUP_SECRET = "test-setup-secret";

describe("POST /api/setup/device-token", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await buildServer();
  });

  it("inserts a new device_tokens row and returns { token, device }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "My Phone", setupSecret: SETUP_SECRET },
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
      payload: { setupSecret: SETUP_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.deviceName).toBe("Unnamed device");
  });

  it("defaults device name when an empty string is given", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "   ", setupSecret: SETUP_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.deviceName).toBe("Unnamed device");
  });

  it("does NOT invalidate a previously-minted token — both remain valid", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "Device A", setupSecret: SETUP_SECRET },
    });
    const firstToken = first.json().token as string;

    const second = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "Device B", setupSecret: SETUP_SECRET },
    });
    const secondToken = second.json().token as string;

    expect(firstToken).not.toBe(secondToken);

    const rows = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();
    expect(rows).toHaveLength(2);

    const firstAuthed = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(firstAuthed.statusCode).toBe(200);

    const secondAuthed = await app.inject({
      method: "GET",
      url: "/api/preferences",
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(secondAuthed.statusCode).toBe(200);
  });

  it("sets the HttpOnly device-token cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { setupSecret: SETUP_SECRET },
    });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("recipecart_device_token=");
    expect(String(setCookie).toLowerCase()).toContain("httponly");
  });

  it("rejects a mint with no setupSecret at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "Intruder" },
    });
    expect(res.statusCode).toBe(401);

    const rows = await getDb().selectFrom("device_tokens").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("rejects a mint with the wrong setupSecret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/device-token",
      payload: { deviceName: "Intruder", setupSecret: "not-the-real-secret" },
    });
    expect(res.statusCode).toBe(401);

    const rows = await getDb().selectFrom("device_tokens").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
