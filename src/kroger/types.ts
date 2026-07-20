// Types for the Kroger Public API (Spec 3 §2.1/§2.3). Field names below are
// taken from REAL verified responses (live curl calls against
// api.kroger.com during P1 setup, 2026-07-18) — not copied from the docs
// summary, which uses different (wrong) casing for several fields, e.g. the
// docs describe `instore`/`shiptohome` but the real API returns
// `inStore`/`shipToHome` nested under `items[].fulfillment`, and stock/price
// live under `items[]`, not top-level as the docs page implied.

export interface KrogerTokenResponse {
  access_token: string;
  refresh_token?: string; // present for Authorization Code grant, absent for Client Credentials
  expires_in: number; // seconds; verified 1800 (30 min) for Client Credentials
  token_type: string;
}

export interface KrogerProductPrice {
  regular: number;
  promo?: number;
}

export interface KrogerProductItem {
  itemId: string;
  inventory?: { stockLevel: "HIGH" | "LOW" | "TEMPORARILY_OUT_OF_STOCK" };
  fulfillment: {
    curbside: boolean;
    delivery: boolean;
    inStore: boolean;
    shipToHome: boolean;
  };
  price?: KrogerProductPrice;
  size: string;
  soldBy: "UNIT" | "WEIGHT";
}

export interface KrogerAisleLocation {
  bayNumber?: string;
  description: string;
  number: string;
}

// Per Kroger's documented Products API shape, confirmed against a real live
// `/products` call (2026-07-20, "heavy cream" @ locationId 03500529): each
// product can carry multiple `images` entries (one per camera angle —
// "front", "back", "left", "right"), each with its own `sizes` array
// offering the same shot at several resolutions ("thumbnail", "small",
// "medium", "large", "xlarge" — confirmed exact match). One correction from
// the original unverified assumption: the "this is the primary shot" flag
// is `featured: boolean` on the perspective entry (only ever seen set true
// on "front" in the live sample), NOT `default` as first guessed — fixed
// below. `images` itself is optional defensively: not every product in the
// catalog has photography.
export interface KrogerProductImageSize {
  size: string;
  url: string;
}

export interface KrogerProductImage {
  id?: string;
  perspective: string;
  featured?: boolean;
  sizes: KrogerProductImageSize[];
}

export interface KrogerProduct {
  productId: string;
  upc: string;
  productPageURI: string;
  description: string;
  brand?: string;
  categories: string[];
  aisleLocations: KrogerAisleLocation[];
  items: KrogerProductItem[];
  images?: KrogerProductImage[];
}

export interface KrogerProductSearchResponse {
  data: KrogerProduct[];
  meta: { pagination: { start: number; limit: number; total: number } };
}

export interface KrogerLocationAddress {
  addressLine1: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface KrogerLocation {
  locationId: string;
  storeNumber: string;
  chain: string;
  name: string;
  address: KrogerLocationAddress;
}

export interface KrogerLocationSearchResponse {
  data: KrogerLocation[];
  meta: { pagination: { start: number; limit: number; total: number } };
}

export class KrogerApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Kroger API error ${status}: ${JSON.stringify(body)}`);
    this.name = "KrogerApiError";
  }
}
