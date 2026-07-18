// Small AES-256-GCM helper for encrypting things at rest with a key that
// lives only in an env var (Spec 4 §2.6 envelope pattern) — currently used
// for the local Kroger OAuth token-pair file (Spec 3 §2.4).
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** hexKey must be a 32-byte value hex-encoded (64 hex chars) — matches the
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 * generation instruction in .env.example. */
export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv : authTag : ciphertext, each base64, colon-joined — simple to store
  // as a single string field.
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

export function decrypt(payload: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex");
  const [ivB64, authTagB64, ciphertextB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
