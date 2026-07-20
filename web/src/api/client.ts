// Small fetch wrapper for the RecipeCart REST API. All requests use
// credentials: "include" so the auth cookie (set by AuthGate) rides along
// automatically. Non-2xx responses are surfaced as a typed ApiError mirroring
// the server's `{ error: { code, message } }` shape (src/api/server.ts's
// error handler) so callers can branch on `.code` without parsing raw JSON.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorBody = { error?: { code?: string; message?: string } };

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    // 204 No Content and similar: nothing to parse.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Non-JSON error body (e.g. a proxy/network error page) — fall through
    // to the generic message below.
  }
  throw new ApiError(
    res.status,
    body.error?.code ?? "unknown_error",
    body.error?.message ?? res.statusText ?? "Request failed",
  );
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  return handleResponse<T>(res);
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: {
      // Only set Content-Type when there's actually a body to describe.
      // Real bug, caught live: Fastify's default JSON body parser rejects
      // ANY request with `Content-Type: application/json` and an empty
      // body ("Body cannot be empty when content-type is set to
      // 'application/json'") — sending this header unconditionally broke
      // every no-body POST (setup's device-token mint, cart:approve,
      // reprocess) with a 500, not just the one that happened to get
      // manually tested first.
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiDelete<T = void>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE", credentials: "include" });
  return handleResponse<T>(res);
}
