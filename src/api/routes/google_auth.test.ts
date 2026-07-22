// Google sign-in route tests (multi-tenancy Slice 1, 2026-07-21; open
// signup as of Slice 2, 2026-07-22 — the allowlist was removed by explicit
// user call). Mirrors kroger_auth.test.ts's structure (mock the OAuth
// client module, drive the real start/callback routes via app.inject). The
// identity-resolution branches — already-linked, owner-claim, brand-new
// account for ANY verified email — are the actual point of this file; the
// OAuth mechanics themselves are just the existing kroger_auth.ts pattern
// reused.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getDb, DEFAULT_USER_ID } from "../../platform/database.js";
import { resetDb } from "../../platform/test-db.js";
import { config } from "../../platform/config.js";

const userinfoMock = vi.fn();
vi.mock("../../auth/google.js", () => ({
  buildAuthUrl: vi.fn(() => "https://fake-google-auth-url"),
  randomState: vi.fn(() => "fake-state"),
  exchangeCode: vi.fn().mockResolvedValue({ access_token: "tok", expires_in: 3600 }),
  fetchUserinfo: (...args: unknown[]) => userinfoMock(...args),
}));

const { buildServer } = await import("../server.js");

const ORIGINAL_OWNER_EMAIL = config.ownerEmail;

describe("google auth routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    userinfoMock.mockResolvedValue({
      sub: "google-sub-1",
      email: "owner@example.com",
      email_verified: true,
      name: "Owner",
    });
    config.ownerEmail = "owner@example.com";
    app = await buildServer();
  });

  afterEach(() => {
    config.ownerEmail = ORIGINAL_OWNER_EMAIL;
  });

  it("GET /auth/google/start redirects to the Google consent URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/google/start" });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("https://fake-google-auth-url");
  });

  it("claims the pre-existing DEFAULT_USER_ID account for the owner's first login", async () => {
    await app.inject({ method: "GET", url: "/api/auth/google/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=fake-state",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(300);
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers.location).toBe("http://localhost:5173/?loggedIn=true");

    const user = await getDb()
      .selectFrom("users")
      .selectAll()
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(user.google_sub).toBe("google-sub-1");
    expect(user.email).toBe("owner@example.com");

    // Minted a device token for the (now-claimed) DEFAULT_USER_ID, not a
    // brand-new account.
    const tokenRow = await getDb()
      .selectFrom("device_tokens")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(tokenRow.device_name).toBe("Browser (Google sign-in)");

    const totalUsers = await getDb().selectFrom("users").select("id").execute();
    expect(totalUsers).toHaveLength(1); // no extra account created
  });

  it("does not re-claim DEFAULT_USER_ID on a second owner login — reuses the linked account", async () => {
    await app.inject({ method: "GET", url: "/api/auth/google/start" });
    await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=fake-state",
    });

    // Second login, same identity.
    await app.inject({ method: "GET", url: "/api/auth/google/start" });
    await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code-2&state=fake-state",
    });

    const totalUsers = await getDb().selectFrom("users").select("id").execute();
    expect(totalUsers).toHaveLength(1);

    const tokens = await getDb()
      .selectFrom("device_tokens")
      .select("id")
      .where("user_id", "=", DEFAULT_USER_ID)
      .execute();
    expect(tokens).toHaveLength(2); // one per login, same account
  });

  it("creates a brand-new account for a non-owner email", async () => {
    userinfoMock.mockResolvedValue({
      sub: "google-sub-2",
      email: "second@example.com",
      email_verified: true,
      name: "Second Person",
    });
    await app.inject({ method: "GET", url: "/api/auth/google/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=fake-state",
    });
    expect(res.headers.location).toBe("http://localhost:5173/?loggedIn=true");

    const users = await getDb().selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(2); // seeded DEFAULT_USER_ID + this new one

    const newUser = users.find((u) => u.id !== DEFAULT_USER_ID);
    expect(newUser?.google_sub).toBe("google-sub-2");
    expect(newUser?.email).toBe("second@example.com");
  });

  it("creates a brand-new account for a total stranger — signup is open, no allowlist", async () => {
    userinfoMock.mockResolvedValue({
      sub: "google-sub-stranger",
      email: "stranger@example.com",
      email_verified: true,
      name: "Stranger",
    });
    await app.inject({ method: "GET", url: "/api/auth/google/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=fake-state",
    });
    expect(res.headers.location).toBe("http://localhost:5173/?loggedIn=true");

    const users = await getDb().selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(2); // seeded DEFAULT_USER_ID + the stranger's new account

    const newUser = users.find((u) => u.id !== DEFAULT_USER_ID);
    expect(newUser?.google_sub).toBe("google-sub-stranger");

    const tokens = await getDb()
      .selectFrom("device_tokens")
      .select("id")
      .where("user_id", "=", newUser!.id)
      .execute();
    expect(tokens).toHaveLength(1); // a real session was minted for them
  });

  it("rejects an unverified email even for the owner", async () => {
    userinfoMock.mockResolvedValue({
      sub: "google-sub-unverified",
      email: "owner@example.com",
      email_verified: false,
      name: "Owner",
    });
    await app.inject({ method: "GET", url: "/api/auth/google/start" });

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=fake-state",
    });
    expect(res.headers.location).toBe("http://localhost:5173/login?error=email_unverified");

    const user = await getDb()
      .selectFrom("users")
      .select("google_sub")
      .where("id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(user.google_sub).toBeNull();
  });

  it("GET /auth/google/callback with an invalid state redirects with an error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=never-issued",
    });
    expect(res.headers.location).toBe("http://localhost:5173/login?error=invalid_request");
  });

  it("GET /auth/google/callback with ?error= (consent declined) redirects with denied", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?error=access_denied",
    });
    expect(res.headers.location).toBe("http://localhost:5173/login?error=denied");
  });
});
