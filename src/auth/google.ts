// Google OAuth2/OIDC client (multi-tenancy Slice 1, 2026-07-21). Mirrors
// src/kroger/auth.ts's shape deliberately — same hand-rolled
// fetch-based pattern (buildAuthUrl/randomState/exchangeCode), no OAuth
// library dependency, consistent with how this codebase already does
// Kroger's Authorization Code flow. The one difference: after exchanging
// the code, an extra call to Google's userinfo endpoint resolves identity
// (sub/email/name) — Google's access token IS the verification (the token
// only works if Google itself issued and still honors it), so there's no
// need to independently verify a signed ID token / add a JWT library.
import crypto from "node:crypto";
import { config } from "../platform/config.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface GoogleUserinfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

/** Builds the URL to redirect the browser to for Google's consent screen.
 * `state` should be a random value the caller verifies on callback (CSRF
 * protection) — generate with randomState() below. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.secrets.googleClientId,
    redirect_uri: config.googleRedirectUri,
    scope: "openid email profile",
    state,
    // Skips the account chooser when only one Google session is active in
    // the browser — a minor convenience, not a security-relevant choice.
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Exchanges the authorization code from the callback for an access token. */
export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.secrets.googleClientId,
    client_secret: config.secrets.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json as GoogleTokenResponse;
}

/** Resolves the signed-in identity from a Google access token. Calling
 * Google's own userinfo endpoint with the token IS the verification step —
 * a forged/expired token simply gets rejected by Google (401), so there's
 * no separate signature check needed here. */
export async function fetchUserinfo(accessToken: string): Promise<GoogleUserinfo> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Google userinfo fetch failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json as GoogleUserinfo;
}
