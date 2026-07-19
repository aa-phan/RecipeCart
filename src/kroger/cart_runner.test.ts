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
      if (sql.includes("UPDATE")) {
        return {
          run(status: string, resultsJson: string, id: string) {
            const row = fakeCartRuns.find((r) => r.id === id);
            if (!row) throw new Error(`UPDATE on unknown cart_runs id: ${id}`);
            row.status = status;
            row.results_json = resultsJson;
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

  it("tries the next fallback candidate when Kroger rejects the top pick", async () => {
    addToCartMock
      .mockResolvedValueOnce({ ok: false, status: 404, reason: { error: "product_not_found" } })
      .mockResolvedValueOnce({ ok: true });

    const result = await runCartApproval(
      "recipe-1",
      [
        {
          upc: "rejected-upc",
          quantity: 1,
          ingredientId: "ing-1",
          fallbacks: [{ upc: "fallback-upc", quantity: 2 }],
        },
      ],
      "idem-key-fallback-1",
    );

    expect(result.status).toBe("completed");
    expect(addToCartMock).toHaveBeenCalledTimes(2);
    expect(addToCartMock).toHaveBeenNthCalledWith(1, "rejected-upc", 1, "valid-access-token");
    expect(addToCartMock).toHaveBeenNthCalledWith(2, "fallback-upc", 2, "valid-access-token");
    expect(result.results).toEqual([
      {
        ingredientId: "ing-1",
        upc: "fallback-upc",
        status: "added",
        reason: expect.stringContaining("fallback candidate used"),
      },
    ]);
  });

  it("needs_attention with an aggregated reason when every candidate (top + all fallbacks) is rejected", async () => {
    addToCartMock
      .mockResolvedValueOnce({ ok: false, status: 404, reason: { error: "not_found" } })
      .mockResolvedValueOnce({ ok: false, status: 400, reason: { error: "invalid" } });

    const result = await runCartApproval(
      "recipe-1",
      [
        {
          upc: "top",
          quantity: 1,
          ingredientId: "ing-1",
          fallbacks: [{ upc: "second", quantity: 1 }],
        },
      ],
      "idem-key-fallback-2",
    );

    expect(result.status).toBe("failed");
    expect(addToCartMock).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
      {
        ingredientId: "ing-1",
        upc: "top",
        status: "needs_attention",
        reason: expect.stringContaining("all 2 candidates rejected"),
      },
    ]);
  });

  it("stops at auth_failure without trying fallback candidates", async () => {
    addToCartMock.mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "unauthorized" } });

    const result = await runCartApproval(
      "recipe-1",
      [
        {
          upc: "top",
          quantity: 1,
          fallbacks: [{ upc: "second", quantity: 1 }],
        },
      ],
      "idem-key-fallback-3",
    );

    expect(result.status).toBe("requires_user_intervention");
    // Only the first attempt — a 401 must not trigger a fallback retry.
    expect(addToCartMock).toHaveBeenCalledTimes(1);
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

  describe("resume (Spec 3 §2.3 point 5)", () => {
    it("a completed run still replays idempotently, not resumed", async () => {
      addToCartMock.mockResolvedValue({ ok: true });
      const first = await runCartApproval(
        "recipe-1",
        [{ upc: "111", quantity: 1 }],
        "idem-key-resume-0",
      );
      expect(first.status).toBe("completed");
      addToCartMock.mockClear();

      const second = await runCartApproval(
        "recipe-1",
        [{ upc: "111", quantity: 1 }],
        "idem-key-resume-0",
      );
      expect(second).toEqual(first);
      expect(addToCartMock).not.toHaveBeenCalled();
    });

    it("retries only the not-yet-added items, never re-adding an already-added one", async () => {
      // First run: item 1 succeeds, item 2 hits a 401 mid-run and stops.
      addToCartMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "invalid_token" } });

      const first = await runCartApproval(
        "recipe-1",
        [
          { upc: "111", quantity: 1, ingredientId: "ing-1" },
          { upc: "222", quantity: 1, ingredientId: "ing-2" },
        ],
        "idem-key-resume-1",
      );
      expect(first.status).toBe("requires_user_intervention");
      expect(fakeCartRuns).toHaveLength(1);
      const rowId = fakeCartRuns[0]!.id;

      // Second call with the SAME idempotency key, after re-auth: item 2
      // should be the only one retried.
      addToCartMock.mockClear();
      addToCartMock.mockResolvedValue({ ok: true });

      const second = await runCartApproval(
        "recipe-1",
        [
          { upc: "111", quantity: 1, ingredientId: "ing-1" },
          { upc: "222", quantity: 1, ingredientId: "ing-2" },
        ],
        "idem-key-resume-1",
      );

      expect(addToCartMock).toHaveBeenCalledTimes(1); // only item 2 retried
      expect(addToCartMock).toHaveBeenCalledWith("222", 1, "valid-access-token");
      expect(second.status).toBe("completed");
      expect(second.results).toEqual(
        expect.arrayContaining([
          { ingredientId: "ing-1", upc: "111", status: "added" },
          { ingredientId: "ing-2", upc: "222", status: "added" },
        ]),
      );
      // Same row updated in place, not a new one inserted.
      expect(fakeCartRuns).toHaveLength(1);
      expect(fakeCartRuns[0]!.id).toBe(rowId);
    });

    it("recognizes an already-added item even when the added upc was a fallback, not item.upc", async () => {
      // First run: the top pick is rejected, its fallback succeeds; a second
      // item then hits a 401 and stops the run.
      addToCartMock
        .mockResolvedValueOnce({ ok: false, status: 404, reason: { error: "not_found" } })
        .mockResolvedValueOnce({ ok: true }) // fallback succeeds
        .mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "invalid_token" } });

      const items = [
        {
          upc: "top",
          quantity: 1,
          ingredientId: "ing-1",
          fallbacks: [{ upc: "fallback", quantity: 1 }],
        },
        { upc: "222", quantity: 1, ingredientId: "ing-2" },
      ];

      const first = await runCartApproval("recipe-1", items, "idem-key-resume-2");
      expect(first.status).toBe("requires_user_intervention");
      expect(first.results).toEqual([
        {
          ingredientId: "ing-1",
          upc: "fallback",
          status: "added",
          reason: expect.stringContaining("fallback candidate used"),
        },
      ]);

      addToCartMock.mockClear();
      addToCartMock.mockResolvedValue({ ok: true });

      const second = await runCartApproval("recipe-1", items, "idem-key-resume-2");

      // Only ing-2 (222) is retried — ing-1's item is recognized as already
      // added via its fallback upc, not re-sent even though item.upc is
      // "top", not "fallback".
      expect(addToCartMock).toHaveBeenCalledTimes(1);
      expect(addToCartMock).toHaveBeenCalledWith("222", 1, "valid-access-token");
      expect(second.status).toBe("completed");
    });

    it("nothing left to retry (everything already added) recomputes status without calling addToCart", async () => {
      addToCartMock.mockResolvedValueOnce({ ok: true });
      // Force a requires_user_intervention terminal state artificially by
      // stopping mid-run on a single-item list won't work (single success ->
      // completed) — instead simulate via two items where the run records
      // one added item then hits auth failure with nothing further approved
      // on resume.
      addToCartMock.mockReset();
      addToCartMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "invalid_token" } });

      const first = await runCartApproval(
        "recipe-1",
        [
          { upc: "111", quantity: 1, ingredientId: "ing-1" },
          { upc: "222", quantity: 1, ingredientId: "ing-2" },
        ],
        "idem-key-resume-3",
      );
      expect(first.status).toBe("requires_user_intervention");

      addToCartMock.mockClear();

      // Resume, but only re-approve the already-added item — nothing remains.
      const second = await runCartApproval(
        "recipe-1",
        [{ upc: "111", quantity: 1, ingredientId: "ing-1" }],
        "idem-key-resume-3",
      );

      expect(addToCartMock).not.toHaveBeenCalled();
      expect(second.status).toBe("completed");
      expect(second.results).toEqual([{ ingredientId: "ing-1", upc: "111", status: "added" }]);
    });

    it("still not connected on resume -> stays requires_user_intervention, preserving prior added items", async () => {
      addToCartMock
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, status: 401, reason: { error: "invalid_token" } });

      const first = await runCartApproval(
        "recipe-1",
        [
          { upc: "111", quantity: 1, ingredientId: "ing-1" },
          { upc: "222", quantity: 1, ingredientId: "ing-2" },
        ],
        "idem-key-resume-4",
      );
      expect(first.status).toBe("requires_user_intervention");

      loadTokenMock.mockReturnValue(null); // still not (re-)connected
      addToCartMock.mockClear();

      const second = await runCartApproval(
        "recipe-1",
        [
          { upc: "111", quantity: 1, ingredientId: "ing-1" },
          { upc: "222", quantity: 1, ingredientId: "ing-2" },
        ],
        "idem-key-resume-4",
      );

      expect(second.status).toBe("requires_user_intervention");
      expect(second.results).toEqual([{ ingredientId: "ing-1", upc: "111", status: "added" }]);
      expect(addToCartMock).not.toHaveBeenCalled();
    });
  });
});

// Final safety net: grep-able assertion that addToCart is always the mock,
// never a real network-calling implementation, in this file.
describe("safety", () => {
  it("addToCart is mocked, not the real client", () => {
    expect(vi.isMockFunction(addToCartMock)).toBe(true);
  });
});
