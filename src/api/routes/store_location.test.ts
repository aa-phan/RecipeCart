// Store location route tests (multi-tenancy Slice 2, 2026-07-22). Confirms
// each account's store is genuinely isolated — the real point of this
// slice — and that GET/POST round-trip through the real store_locations
// table (src/kroger/store_config.ts), not a mock of it.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";

const getAppTokenMock = vi.fn();
vi.mock("../../kroger/auth.js", () => ({
  getAppToken: (...args: unknown[]) => getAppTokenMock(...args),
}));

const searchLocationsMock = vi.fn();
vi.mock("../../kroger/client.js", () => ({
  searchLocations: (...args: unknown[]) => searchLocationsMock(...args),
}));

const { buildServer } = await import("../server.js");

const RAW_TOKEN_A = "token-user-a";
const RAW_TOKEN_B = "token-user-b";
const AUTH_A = { authorization: `Bearer ${RAW_TOKEN_A}` };
const AUTH_B = { authorization: `Bearer ${RAW_TOKEN_B}` };
const USER_B = "33333333-3333-3333-3333-333333333333";

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function seedTokens(): Promise<void> {
  const db = getDb();
  await db.insertInto("users").values({ id: USER_B }).execute();
  await db
    .insertInto("device_tokens")
    .values([
      {
        id: crypto.randomUUID(),
        user_id: DEFAULT_USER_ID,
        token_hash: hash(RAW_TOKEN_A),
        device_name: "A",
      },
      { id: crypto.randomUUID(), user_id: USER_B, token_hash: hash(RAW_TOKEN_B), device_name: "B" },
    ])
    .execute();
}

const KROGER_STORE = {
  locationId: "loc-123",
  storeNumber: "123",
  chain: "KROGER",
  name: "Kroger on Main St",
  address: { addressLine1: "1 Main St", city: "Dallas", state: "TX", zipCode: "75201" },
};

describe("store location routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    await seedTokens();
    vi.clearAllMocks();
    getAppTokenMock.mockResolvedValue({ access_token: "app-tok" });
    searchLocationsMock.mockResolvedValue({
      data: [KROGER_STORE],
      meta: { pagination: { start: 0, limit: 5, total: 1 } },
    });
    app = await buildServer();
  });

  it("GET /store-location 404s when nothing is configured yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/store-location",
      headers: AUTH_A,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /store-location searches by zip and saves the nearest result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/store-location",
      headers: AUTH_A,
      payload: { zipCode: "75201" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      locationId: "loc-123",
      name: "Kroger on Main St",
      zipCode: "75201",
    });
    expect(searchLocationsMock).toHaveBeenCalledWith("75201", "app-tok");

    const getRes = await app.inject({
      method: "GET",
      url: "/api/store-location",
      headers: AUTH_A,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().locationId).toBe("loc-123");
  });

  it("POST /store-location with no matches returns 400, saves nothing", async () => {
    searchLocationsMock.mockResolvedValue({
      data: [],
      meta: { pagination: { start: 0, limit: 5, total: 0 } },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/store-location",
      headers: AUTH_A,
      payload: { zipCode: "00000" },
    });
    expect(res.statusCode).toBe(400);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/store-location",
      headers: AUTH_A,
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("POST /store-location requires a zipCode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/store-location",
      headers: AUTH_A,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(searchLocationsMock).not.toHaveBeenCalled();
  });

  // The actual point of this slice: each account's store is independent.
  it("one account's store does not leak to or overwrite another's", async () => {
    await app.inject({
      method: "POST",
      url: "/api/store-location",
      headers: AUTH_A,
      payload: { zipCode: "75201" },
    });

    searchLocationsMock.mockResolvedValue({
      data: [
        {
          ...KROGER_STORE,
          locationId: "loc-456",
          name: "Kroger on Elm St",
          address: { ...KROGER_STORE.address, zipCode: "10001" },
        },
      ],
      meta: { pagination: { start: 0, limit: 5, total: 1 } },
    });

    await app.inject({
      method: "POST",
      url: "/api/store-location",
      headers: AUTH_B,
      payload: { zipCode: "10001" },
    });

    const storeA = await app.inject({
      method: "GET",
      url: "/api/store-location",
      headers: AUTH_A,
    });
    const storeB = await app.inject({
      method: "GET",
      url: "/api/store-location",
      headers: AUTH_B,
    });

    expect(storeA.json().locationId).toBe("loc-123");
    expect(storeB.json().locationId).toBe("loc-456");
  });

  it("rejects requests without a valid device token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/store-location" });
    expect(res.statusCode).toBe(401);
  });
});
