// Kroger Public API client (Spec 3 §2.1) — a thin, typed HTTP client, no
// browser, no selectors. search/locations calls verified live against the
// real API during P1 setup (2026-07-18); addToCart's request body is NOT
// independently verified — it requires a real user Authorization Code
// login this environment couldn't complete headlessly, so it follows
// Kroger's documented `{items: [{upc, quantity}]}` convention. Confirm
// against the real response on the first live cart-add call and update
// this comment once verified.
import { config } from "../platform/config.js";
import {
  KrogerApiError,
  type KrogerLocationSearchResponse,
  type KrogerProductSearchResponse,
} from "./types.js";

async function get<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const url = new URL(`${config.kroger.apiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await response.json()) as unknown;
  if (!response.ok) {
    throw new KrogerApiError(response.status, json);
  }
  return json as T;
}

/** Products API (Spec 3 §2.2 matcher). No per-user auth — call with an
 * app-level token from auth.getAppToken(). locationId is required to get
 * price/stock/fulfillment data back (Spec 3 §8). */
export function searchProducts(
  term: string,
  locationId: string,
  appToken: string,
  limit = 10,
): Promise<KrogerProductSearchResponse> {
  return get<KrogerProductSearchResponse>(
    "/products",
    { "filter.term": term, "filter.locationId": locationId, "filter.limit": String(limit) },
    appToken,
  );
}

/** Locations API (Spec 3 §14 store lookup). No per-user auth. */
export function searchLocations(
  zipCode: string,
  appToken: string,
  radiusMiles = 25,
  limit = 5,
): Promise<KrogerLocationSearchResponse> {
  return get<KrogerLocationSearchResponse>(
    "/locations",
    {
      "filter.zipCode.near": zipCode,
      "filter.radiusInMiles": String(radiusMiles),
      "filter.limit": String(limit),
    },
    appToken,
  );
}

export type AddToCartResult = { ok: true } | { ok: false; status: number; reason: unknown };

/** Cart API (Spec 3 §2.3 cart runner). Requires a user-authorized token
 * (Authorization Code grant, scope cart.basic:write — see auth.ts). Public
 * tier is write-only: a 204 response IS the confirmation signal, there is
 * no read-after-write cart re-read available at this tier (Spec 3 §17). */
export async function addToCart(
  upc: string,
  quantity: number,
  userAccessToken: string,
): Promise<AddToCartResult> {
  const response = await fetch(`${config.kroger.apiBaseUrl}/cart/add`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items: [{ upc, quantity }] }),
  });

  if (response.status === 204) {
    return { ok: true };
  }
  let reason: unknown;
  try {
    reason = await response.json();
  } catch {
    reason = await response.text();
  }
  return { ok: false, status: response.status, reason };
}
