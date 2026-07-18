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

export interface KrogerProduct {
  productId: string;
  upc: string;
  productPageURI: string;
  description: string;
  brand?: string;
  categories: string[];
  aisleLocations: KrogerAisleLocation[];
  items: KrogerProductItem[];
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
