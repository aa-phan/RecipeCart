import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../platform/config.js", () => ({
  config: {
    secrets: { krogerClientId: "test-client-id", krogerClientSecret: "test-client-secret" },
    krogerRedirectUri: "http://localhost:3000/callback",
    kroger: {
      apiBaseUrl: "https://api.kroger.com/v1",
      authorizeUrl: "https://api.kroger.com/v1/connect/oauth2/authorize",
      tokenUrl: "https://api.kroger.com/v1/connect/oauth2/token",
      appScope: "product.compact",
      userScope: "cart.basic:write",
    },
  },
}));

const auth = await import("./auth.js");
const { KrogerApiError } = await import("./types.js");

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

interface FetchInit {
  method?: string;
  headers: Record<string, string>;
  body?: URLSearchParams;
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

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scope, and state", () => {
    const url = new URL(auth.buildAuthUrl("my-state"));
    expect(url.origin + url.pathname).toBe("https://api.kroger.com/v1/connect/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback");
    expect(url.searchParams.get("scope")).toBe("cart.basic:write");
    expect(url.searchParams.get("state")).toBe("my-state");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("randomState", () => {
  it("generates a non-empty, varying value", () => {
    const a = auth.randomState();
    const b = auth.randomState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("getAppToken", () => {
  it("posts client_credentials grant with the app scope and returns the token", async () => {
    mockFetchOnce(200, { access_token: "app-tok", expires_in: 1800, token_type: "bearer" });
    const result = await auth.getAppToken();
    expect(result.access_token).toBe("app-tok");

    const [url, init] = lastFetchCall();
    expect(url).toBe("https://api.kroger.com/v1/connect/oauth2/token");
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("product.compact");
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it("throws KrogerApiError on a non-2xx response", async () => {
    mockFetchOnce(401, { error: "invalid_client" });
    await expect(auth.getAppToken()).rejects.toThrow(KrogerApiError);
  });
});

describe("exchangeCode", () => {
  it("posts authorization_code grant with the code and redirect_uri", async () => {
    mockFetchOnce(200, {
      access_token: "user-tok",
      refresh_token: "refresh-tok",
      expires_in: 1800,
      token_type: "bearer",
    });
    const result = await auth.exchangeCode("the-code");
    expect(result.refresh_token).toBe("refresh-tok");

    const [, init] = lastFetchCall();
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/callback");
  });
});

describe("refreshAccessToken", () => {
  it("posts refresh_token grant", async () => {
    mockFetchOnce(200, { access_token: "new-tok", expires_in: 1800, token_type: "bearer" });
    await auth.refreshAccessToken("old-refresh-tok");

    const [, init] = lastFetchCall();
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-tok");
  });
});
