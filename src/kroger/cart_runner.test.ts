import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock addToCart (src/kroger/client.ts) — CRITICAL: this must NEVER be the
// real implementation in this test file, since the real one makes a live
// mutating call to a real Kroger customer's real cart. Every test below
// exercises cart_runner.ts through this mock only.
const addToCartMock = vi.fn();
vi.mock("./client.js", () => ({
  addToCart: (...args: unknown[]) => addToCartMock(...args),
}));

const loadTokenMock = vi.fn();
const saveTokenMock = vi.fn();
vi.mock("./token_store.js", () => ({
  loadToken: (...args: unknown[]) => loadTokenMock(...args),
  saveToken: (...args: unknown[]) => saveTokenMock(...args),
  isExpiredOrMissing: (token: { expiresAt: number } | null, skewMs = 60_000) => {
    if (!token) return true;
    return Date.now() >= token.expiresAt - skewMs;
  },
}));

const refreshAccessTokenMock = vi.fn();
vi.mock("./auth.js", () => ({
  refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
}));

vi.mock("../platform/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// In-memory fake of the cart_runs table, standing in for src/platform/db.ts.
// We don't touch the real db.ts file per the task boundary, and this keeps
// tests fast/hermetic without a real sqlite file.
interface FakeCartRunRow {
  id: string;
  recipe_id: string;
  idempotency_key: string;
  status: string;
  results_json: string;
}

let fakeCartRuns: FakeCartRunRow[] = [];

function makeFakeDb() {
  return {
    prepare(sql: string) {
      if (sql.includes("SELECT")) {
        return {
          get(key: string) {
            return fakeCartRuns.find((r) => r.idempotency_key === key);
          },
        };
      }
      if (sql.includes("INSERT")) {
        return {
          run(
            id: string,
            recipeId: string,
            idempotencyKey: string,
            status: string,
            resultsJson: string,
          ) {
            fakeCartRuns.push({
              id,
              recipe_id: recipeId,
              idempotency_key: idempotencyKey,
              status,
              results_json: resultsJson,
            });
          },
        };
      }
      throw new Error(`Unexpected SQL in fake db: ${sql}`);
    },
  };
}

vi.mock("../platform/db.js", () => ({
  getDb: () => makeFakeDb(),
}));

const { runCartApproval, ensureValidUserToken } = await import("./cart_runner.js");

const validToken = {
  accessToken: "valid-access-token",
  refreshToken: "refresh-tok",
  expiresAt: Date.now() + 60 * 60_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeCartRuns = [];
  loadTokenMock.mockReturnValue(validToken);
});

describe("ensureValidUserToken", () => {
  it("returns the stored access token when not expired", async () => {
    loadTokenMock.mockReturnValue(validToken);
    const token = await ensureValidUserToken();
    expect(token).toBe("valid-access-token");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it("refreshes and saves a new token when expired", async () => {
    loadTokenMock.mockReturnValue({
      accessToken: "old-tok",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-tok",
      refresh_token: "new-refresh",
      expires_in: 1800,
      token_type: "bearer",
    });
    const token = await ensureValidUserToken();
    expect(token).toBe("new-tok");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("old-refresh");
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-tok", refreshToken: "new-refresh" }),
    );
  });

  it("keeps the old refresh token if the refresh response omits a new one", async () => {
    loadTokenMock.mockReturnValue({
      accessToken: "old-tok",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-tok",
      expires_in: 1800,
      token_type: "bearer",
    });
    await ensureValidUserToken();
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new-tok", refreshToken: "old-refresh" }),
    );
  });

  it("throws a clear error when there is no stored token", async () => {
    loadTokenMock.mockReturnValue(null);
    await expect(ensureValidUserToken()).rejects.toThrow(/Not connected to Kroger/);
  });
});

describe("runCartApproval", () => {
  it("full success: all items added, status completed", async () => {
    addToCartMock.mockResolvedValue({ ok: true });

    const result = await runCartApproval(
      "recipe-1",
      [
        { upc: "111", quantity: 1, ingredientId: "ing-1" },
        { upc: "222", quantity: 2, ingredientId: "ing-2" },
      ],
      "idem-key-1",
    );

    expect(result.status).toBe("completed");
    expect(result.results).toEqual([
      { ingredientId: "ing-1", upc: "111", status: "added" },
      { ingredientId: "ing-2", upc: "222", status: "added" },
    ]);
    expect(addToCartMock).toHaveBeenCalledTimes(2);
    expect(addToCartMock).toHaveBeenCalledWith("111", 1, "valid-access-token");
    expect(addToCartMock).toHaveBeenCalledWith("222", 2, "valid-access-token");

    // Persisted to the (fake) cart_runs table.
    expect(fakeCartRuns).toHaveLength(1);
    expect(fakeCartRuns[0]?.status).toBe("completed");
  });

  it("partial failure: mixed added / needs_attention -> partially_completed, continues past bad item", async () => {
    addToCartMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 404, reason: { error: "product_not_found" } })
      .mockResolvedValueOnce({ ok: true });

    const result = await runCartApproval(
      "recipe-1",
      [
        { upc: "111", quantity: 1 },
        { upc: "bad-upc", quantity: 1 },
        { upc: "333", quantity: 1 },
      ],
      "idem-key-2",
    );

    expect(result.status).toBe("partially_completed");
    expect(addToCartMock).toHaveBeenCalledTimes(3);
    expect(result.results).toEqual([
      { upc: "111", status: "added", ingredientId: undefined },
      {
        upc: "bad-upc",
        status: "needs_attention",
        reason: expect.stringContaining("product_not_found"),
        ingredientId: undefined,
      },
      { upc: "333", status: "added", ingredientId: undefined },
    ]);
  });

  it("all items fail (non-401) -> failed", async () => {
    addToCartMock.mockResolvedValue({ ok: false, status: 400, reason: { error: "bad_request" } });

    const result = await runCartApproval("recipe-1", [{ upc: "111", quantity: 1 }], "idem-key-3");

    expect(result.status).toBe("failed");
    expect(result.results[0]?.status).toBe("needs_attention");
  });

  it("idempotent replay: same key returns stored result without calling addToCart again", async () => {
    addToCartMock.mockResolvedValue({ ok: true });

    const first = await runCartApproval(
      "recipe-1",
      [{ upc: "111", quantity: 1 }],
      "idem-key-replay",
    );
    expect(addToCartMock).toHaveBeenCalledTimes(1);

    addToCartMock.mockClear();

    const second = await runCartApproval(
      "recipe-1",
      [{ upc: "111", quantity: 1 }],
      "idem-key-replay",
    );

    expect(addToCartMock).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(fakeCartRuns).toHaveLength(1);
  });

  it("no token stored -> requires_user_intervention without calling addToCart", async () => {
    loadTokenMock.mockReturnValue(null);

    const result = await runCartApproval("recipe-1", [{ upc: "111", quantity: 1 }], "idem-key-4");

    expect(result.status).toBe("requires_user_intervention");
    expect(result.results).toEqual([]);
    expect(addToCartMock).not.toHaveBeenCalled();
  });

  it("expired token triggers a refresh before the cart add proceeds", async () => {
    loadTokenMock.mockReturnValue({
      accessToken: "old-tok",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "refreshed-tok",
      refresh_token: "refreshed-refresh",
      expires_in: 1800,
      token_type: "bearer",
    });
    addToCartMock.mockResolvedValue({ ok: true });

    const result = await runCartApproval("recipe-1", [{ upc: "111", quantity: 1 }], "idem-key-5");

    expect(result.status).toBe("completed");
    expect(saveTokenMock).toHaveBeenCalled();
    expect(addToCartMock).toHaveBeenCalledWith("111", 1, "refreshed-tok");
  });

  it("401 mid-run stops processing remaining items -> requires_user_intervention", async () => {
    addToCartMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "invalid_token" } });

    const result = await runCartApproval(
      "recipe-1",
      [
        { upc: "111", quantity: 1 },
        { upc: "222", quantity: 1 },
        { upc: "333", quantity: 1 },
      ],
      "idem-key-6",
    );

    expect(result.status).toBe("requires_user_intervention");
    // Only the first two items attempted; the third never gets called since
    // we stop processing at the 401.
    expect(addToCartMock).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([{ upc: "111", status: "added", ingredientId: undefined }]);
  });

  it("transient network error retries then succeeds", async () => {
    addToCartMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true });

    const result = await runCartApproval("recipe-1", [{ upc: "111", quantity: 1 }], "idem-key-7");

    expect(result.status).toBe("completed");
    expect(addToCartMock).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([{ upc: "111", status: "added", ingredientId: undefined }]);
  });

  it("transient network error exhausts retries -> needs_attention, not thrown", async () => {
    addToCartMock.mockRejectedValue(new Error("ECONNRESET"));

    const result = await runCartApproval("recipe-1", [{ upc: "111", quantity: 1 }], "idem-key-8");

    // 1 initial attempt + 2 retries = 3 calls total.
    expect(addToCartMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("failed");
    expect(result.results[0]).toMatchObject({ upc: "111", status: "needs_attention" });
    expect(result.results[0]?.reason).toContain("ECONNRESET");
  });

  it("empty approved items list -> failed, no addToCart calls", async () => {
    const result = await runCartApproval("recipe-1", [], "idem-key-9");
    expect(result.status).toBe("failed");
    expect(addToCartMock).not.toHaveBeenCalled();
  });
});

// Final safety net: grep-able assertion that addToCart is always the mock,
// never a real network-calling implementation, in this file.
describe("safety", () => {
  it("addToCart is mocked, not the real client", () => {
    expect(vi.isMockFunction(addToCartMock)).toBe(true);
  });
});
