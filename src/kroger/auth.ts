// Kroger OAuth2 (Spec 3 §2.4). Two grant types for two different purposes:
//   - Client Credentials: app-level, no user involved, for Products/Locations.
//   - Authorization Code: per-user, standard login+consent redirect, for Cart.
// Both verified live against the real API during P1 setup (2026-07-18).
import crypto from "node:crypto";
import { config } from "../platform/config.js";
import { KrogerApiError, type KrogerTokenResponse } from "./types.js";

function basicAuthHeader(): string {
  const raw = `${config.secrets.krogerClientId}:${config.secrets.krogerClientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function postToken(body: URLSearchParams): Promise<KrogerTokenResponse> {
  const response = await fetch(config.kroger.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });
  const json = (await response.json()) as unknown;
  if (!response.ok) {
    throw new KrogerApiError(response.status, json);
  }
  return json as KrogerTokenResponse;
}

/** App-level token for Products/Locations — no user interaction needed.
 * Verified expiry: 1800s (30 min). Callers should request a fresh one per
 * batch of calls rather than trying to cache across process restarts, since
 * 30 minutes is short relative to typical job duration. */
export function getAppToken(): Promise<KrogerTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: config.kroger.appScope,
  });
  return postToken(body);
}

/** Builds the URL to redirect the user to for the Authorization Code
 * consent flow. `state` should be a random value the caller verifies on
 * callback (CSRF protection) — generate with randomState() below. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.secrets.krogerClientId,
    redirect_uri: config.krogerRedirectUri,
    scope: config.kroger.userScope,
    state,
  });
  return `${config.kroger.authorizeUrl}?${params.toString()}`;
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Exchanges the authorization code from the callback for an access +
 * refresh token pair. */
export function exchangeCode(code: string): Promise<KrogerTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.krogerRedirectUri,
  });
  return postToken(body);
}

/** Exchanges a refresh token for a new access token (and, per OAuth2
 * convention, possibly a rotated refresh token — callers should persist
 * whichever refresh_token comes back, falling back to the old one if the
 * response omits it). */
export function refreshAccessToken(refreshToken: string): Promise<KrogerTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return postToken(body);
}
