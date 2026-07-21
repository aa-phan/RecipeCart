// GET /api/devices, DELETE /api/devices/:id tests (Slice 2). Covers listing
// order, the ownership check on delete (can't delete another user's device
// row), and the 404 case for a missing/foreign id.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { buildServer } from "../server.js";

const RAW_TOKEN = "test-device-token-devices";
const AUTH_HEADER = { authorization: `Bearer ${RAW_TOKEN}` };

async function seedToken(): Promise<string> {
  const hash = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
  const id = crypto.randomUUID();
  await getDb()
    .insertInto("device_tokens")
    .values({
      id,
      user_id: DEFAULT_USER_ID,
      token_hash: hash,
      device_name: "Auth device",
    })
    .execute();
  return id;
}

/** A second, unrelated user + their own device token row, to exercise the
 * cross-user ownership check on DELETE. */
async function seedOtherUserDevice(): Promise<{ userId: string; deviceId: string }> {
  const userId = crypto.randomUUID();
  await getDb().insertInto("users").values({ id: userId, device_token_hash: null }).execute();
  const deviceId = crypto.randomUUID();
  await getDb()
    .insertInto("device_tokens")
    .values({
      id: deviceId,
      user_id: userId,
      token_hash: crypto.createHash("sha256").update("other-user-token").digest("hex"),
      device_name: "Other user's device",
    })
    .execute();
  return { userId, deviceId };
}

describe("devices routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await buildServer();
  });

  it("rejects requests without a valid device token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/devices" });
    expect(res.statusCode).toBe(401);
  });

  it("lists the caller's devices, newest first", async () => {
    const authDeviceId = await seedToken();

    // A second device for the same user, created after the auth device.
    const secondId = crypto.randomUUID();
    await getDb()
      .insertInto("device_tokens")
      .values({
        id: secondId,
        user_id: DEFAULT_USER_ID,
        token_hash: "second-device-hash",
        device_name: "Second device",
        created_at: new Date(Date.now() + 1000),
      })
      .execute();

    const res = await app.inject({ method: "GET", url: "/api/devices", headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(secondId);
    expect(body[1].id).toBe(authDeviceId);
    expect(body[0]).toMatchObject({ deviceName: "Second device", lastUsedAt: null });
    expect(typeof body[0].createdAt).toBe("string");
  });

  it("does not list another user's devices", async () => {
    await seedToken();
    await seedOtherUserDevice();

    const res = await app.inject({ method: "GET", url: "/api/devices", headers: AUTH_HEADER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("deletes the caller's own device and returns 204", async () => {
    await seedToken();
    const targetId = crypto.randomUUID();
    await getDb()
      .insertInto("device_tokens")
      .values({
        id: targetId,
        user_id: DEFAULT_USER_ID,
        token_hash: "target-hash",
        device_name: "To be revoked",
      })
      .execute();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${targetId}`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(204);

    const row = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("id", "=", targetId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("returns 404 and does not delete another user's device", async () => {
    await seedToken();
    const { deviceId } = await seedOtherUserDevice();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(404);

    const row = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("id", "=", deviceId)
      .executeTakeFirst();
    expect(row).toBeDefined();
  });

  it("returns 404 for a nonexistent device id", async () => {
    await seedToken();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${crypto.randomUUID()}`,
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects DELETE without a valid device token", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
