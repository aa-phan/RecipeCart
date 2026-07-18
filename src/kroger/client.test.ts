import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../platform/config.js", () => ({
  config: {
    kroger: { apiBaseUrl: "https://api.kroger.com/v1" },
  },
}));

const { searchProducts, searchLocations, addToCart } = await import("./client.js");
const { KrogerApiError } = await import("./types.js");

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

interface FetchInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

function lastFetchCall(): [string, FetchInit] {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls[calls.length - 1];
  if (!call) throw new Error("fetch was not called");
  return call as [string, FetchInit];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("searchProducts", () => {
  it("calls /products with term, locationId, and limit, auth header set", async () => {
    mockFetchOnce(200, { data: [], meta: { pagination: { start: 0, limit: 10, total: 0 } } });
    await searchProducts("milk", "01100002", "app-token", 5);

    const [url, init] = lastFetchCall();
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/v1/products");
    expect(parsed.searchParams.get("filter.term")).toBe("milk");
    expect(parsed.searchParams.get("filter.locationId")).toBe("01100002");
    expect(parsed.searchParams.get("filter.limit")).toBe("5");
    expect(init.headers.Authorization).toBe("Bearer app-token");
  });

  it("throws KrogerApiError on a non-2xx response", async () => {
    mockFetchOnce(429, { error: "rate_limited" });
    await expect(searchProducts("milk", "01100002", "tok")).rejects.toThrow(KrogerApiError);
  });
});

describe("searchLocations", () => {
  it("calls /locations with zipCode.near, radius, and limit", async () => {
    mockFetchOnce(200, { data: [], meta: { pagination: { start: 0, limit: 5, total: 0 } } });
    await searchLocations("75201", "app-token", 30, 5);

    const [url] = lastFetchCall();
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/v1/locations");
    expect(parsed.searchParams.get("filter.zipCode.near")).toBe("75201");
    expect(parsed.searchParams.get("filter.radiusInMiles")).toBe("30");
    expect(parsed.searchParams.get("filter.limit")).toBe("5");
  });
});

describe("addToCart", () => {
  it("PUTs to /cart/add with items:[{upc,quantity}] and returns ok on 204", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 204 }) as unknown as typeof fetch;
    const result = await addToCart("0001111050315", 2, "user-token");
    expect(result.ok).toBe(true);

    const [url, init] = lastFetchCall();
    expect(url).toBe("https://api.kroger.com/v1/cart/add");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer user-token");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ upc: "0001111050315", quantity: 2 }],
    });
  });

  it("returns ok:false with status and reason on a non-204 response", async () => {
    mockFetchOnce(404, { error: "product_not_found" });
    const result = await addToCart("bad-upc", 1, "user-token");
    expect(result).toEqual({ ok: false, status: 404, reason: { error: "product_not_found" } });
  });
});
