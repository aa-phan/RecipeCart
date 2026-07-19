import { describe, expect, it, beforeEach } from "vitest";
import { resetDb } from "../platform/test-db.js";
import { saveToken, loadToken, clearToken, isExpiredOrMissing } from "./token_store.js";

beforeEach(async () => {
  await resetDb();
});

describe("token_store", () => {
  it("returns null when no token has been saved", async () => {
    expect(await loadToken()).toBeNull();
  });

  it("round-trips a saved token", async () => {
    const token = { accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 60_000 };
    await saveToken(token);
    expect(await loadToken()).toEqual(token);
  });

  it("upserts on a second save rather than duplicating the row", async () => {
    const first = { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 60_000 };
    const second = { accessToken: "a2", refreshToken: "r2", expiresAt: Date.now() + 120_000 };
    await saveToken(first);
    await saveToken(second);
    expect(await loadToken()).toEqual(second);
  });

  it("does not store the token in plaintext at rest", async () => {
    await saveToken({
      accessToken: "super-secret-access",
      refreshToken: "super-secret-refresh",
      expiresAt: Date.now() + 60_000,
    });
    const { getDb } = await import("../platform/database.js");
    const { DEFAULT_USER_ID } = await import("../platform/database.js");
    const row = await getDb()
      .selectFrom("kroger_auth")
      .selectAll()
      .where("user_id", "=", DEFAULT_USER_ID)
      .executeTakeFirstOrThrow();
    expect(row.encrypted_access_token).not.toContain("super-secret-access");
    expect(row.encrypted_refresh_token).not.toContain("super-secret-refresh");
  });

  it("clearToken removes the row", async () => {
    await saveToken({ accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 60_000 });
    await clearToken();
    expect(await loadToken()).toBeNull();
  });
});

describe("isExpiredOrMissing", () => {
  it("is true for a null token", () => {
    expect(isExpiredOrMissing(null)).toBe(true);
  });

  it("is false for a token well within its expiry", () => {
    const token = { accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 10 * 60_000 };
    expect(isExpiredOrMissing(token)).toBe(false);
  });

  it("is true for a token past its expiry", () => {
    const token = { accessToken: "a", refreshToken: "b", expiresAt: Date.now() - 1000 };
    expect(isExpiredOrMissing(token)).toBe(true);
  });

  it("is true for a token within the default 60s skew window", () => {
    const token = { accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 30_000 };
    expect(isExpiredOrMissing(token)).toBe(true);
  });
});
