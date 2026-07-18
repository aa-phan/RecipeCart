import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

const KEY = crypto.randomBytes(32).toString("hex");

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = JSON.stringify({ accessToken: "abc", refreshToken: "def" });
    const ciphertext = encrypt(plaintext, KEY);
    expect(ciphertext).not.toContain("abc");
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same input", KEY);
    const b = encrypt("same input", KEY);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const ciphertext = encrypt("secret", KEY);
    const wrongKey = crypto.randomBytes(32).toString("hex");
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it("throws on a malformed payload", () => {
    expect(() => decrypt("not-a-valid-payload", KEY)).toThrow("Malformed encrypted payload");
  });
});
