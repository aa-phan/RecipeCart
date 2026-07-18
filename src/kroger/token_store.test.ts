import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipecart-token-test-"));
const testKey = crypto.randomBytes(32).toString("hex");

vi.mock("../platform/config.js", () => ({
  config: {
    dataDir: tmpDir,
    krogerTokenStatePath: path.join(tmpDir, "kroger-token.enc.json"),
    secrets: { krogerTokenKey: testKey },
  },
}));

const { saveToken, loadToken, clearToken, isExpiredOrMissing } = await import("./token_store.js");

beforeEach(() => {
  clearToken();
});

afterEach(() => {
  clearToken();
});

describe("token_store", () => {
  it("returns null when no token has been saved", () => {
    expect(loadToken()).toBeNull();
  });

  it("round-trips a saved token", () => {
    const token = { accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 60_000 };
    saveToken(token);
    expect(loadToken()).toEqual(token);
  });

  it("writes the token file with 0600 permissions", () => {
    saveToken({ accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 60_000 });
    const stats = fs.statSync(path.join(tmpDir, "kroger-token.enc.json"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("does not store the token in plaintext on disk", () => {
    saveToken({
      accessToken: "super-secret-access",
      refreshToken: "super-secret-refresh",
      expiresAt: Date.now() + 60_000,
    });
    const raw = fs.readFileSync(path.join(tmpDir, "kroger-token.enc.json"), "utf8");
    expect(raw).not.toContain("super-secret-access");
    expect(raw).not.toContain("super-secret-refresh");
  });

  it("clearToken removes the file", () => {
    saveToken({ accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 60_000 });
    clearToken();
    expect(loadToken()).toBeNull();
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
