import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";

vi.mock("../../kroger/auth.js", () => ({
  buildAuthUrl: vi.fn(() => "https://fake-kroger-auth-url"),
  randomState: vi.fn(() => "fake-state"),
  exchangeCode: vi.fn().mockResolvedValue({
    access_token: "tok",
    refresh_token: "rtok",
    expires_in: 1800,
    token_type: "bearer",
  }),
}));

// Import after the mock so buildServer's route registration picks it up.
const { buildServer } = await import("../server.js");
const { exchangeCode } = await import("../../kroger/auth.js");

describe("kroger auth routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    app = await buildServer();
  });

  it("GET /kroger/auth/start redirects to the Kroger consent URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kroger/auth/start" });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("https://fake-kroger-auth-url");
  });

  it("GET /kroger/auth/callback with a valid state+code persists a token and redirects", async () => {
    // Establish the state server-side by calling /start first.
    await app.inject({ method: "GET", url: "/api/kroger/auth/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=auth-code-123&state=fake-state",
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("http://localhost:5173/?krogerConnected=true");
    expect(exchangeCode).toHaveBeenCalledWith("auth-code-123");

    const row = await getDb()
      .selectFrom("kroger_auth")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.encrypted_access_token).toBeDefined();
    expect(row?.encrypted_refresh_token).toBeDefined();
  });

  it("GET /kroger/auth/callback with an invalid state returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=auth-code-123&state=never-issued",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /kroger/auth/callback with a missing state returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=auth-code-123",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /kroger/auth/callback rejects a replayed (already-used) state", async () => {
    await app.inject({ method: "GET", url: "/api/kroger/auth/start" });
    await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=auth-code-123&state=fake-state",
    });
    const replay = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=auth-code-456&state=fake-state",
    });
    expect(replay.statusCode).toBe(400);
  });

  it("GET /kroger/auth/callback with ?error= (consent denied) redirects into the SPA instead of throwing", async () => {
    await app.inject({ method: "GET", url: "/api/kroger/auth/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?error=access_denied&state=fake-state",
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("http://localhost:5173/connect-kroger?error=denied");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("GET /kroger/auth/callback with ?error= and no state at all still redirects (not a 400)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?error=access_denied",
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("http://localhost:5173/connect-kroger?error=denied");
  });

  it("GET /kroger/auth/callback redirects to an exchange_failed error page instead of a raw 500 when exchangeCode throws", async () => {
    await app.inject({ method: "GET", url: "/api/kroger/auth/start" });
    vi.mocked(exchangeCode).mockRejectedValueOnce(new Error("Kroger API error 400"));

    const res = await app.inject({
      method: "GET",
      url: "/api/kroger/auth/callback?code=bad-code&state=fake-state",
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe(
      "http://localhost:5173/connect-kroger?error=exchange_failed",
    );

    // No token should have been persisted for the failed exchange.
    const row = await getDb()
      .selectFrom("kroger_auth")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
