// Small fetch wrapper for the RecipeCart REST API. All requests use
// credentials: "include" so the auth cookie (set by AuthGate) rides along
// automatically. Non-2xx responses are surfaced as a typed ApiError mirroring
// the server's `{ error: { code, message } }` shape (src/api/server.ts's
// error handler) so callers can branch on `.code` without parsing raw JSON.
//
// 401 responses get one extra step: they mean the token AuthGate let through
// has since gone stale (revoked, or invalidated by another device under the
// old single-slot design) — not something any individual screen can recover
// from. handleResponse() clears the same AUTHED_FLAG_KEY AuthGate reads and
// does a full page navigation to /setup, so a stale-token 401 self-heals
// instead of leaving the screen stuck on a generic error. This module isn't
// a React component, so it can't call useNavigate(); window.location is used
// instead, which also has the benefit of dropping any stale in-memory state.
//
// apiPost's optional 4th `opts.skipAuthRedirect` exists for the ONE call
// this redirect logic doesn't apply to: Setup.tsx's device-token mint. A
// wrong setupSecret there is a 401 too (src/api/routes/setup.ts), but it
// means "bad passphrase," not "your session died" — an already-authed
// browser adding a second device would otherwise get its AUTHED_FLAG_KEY
// wiped and get bounced through a jarring full-page reload of the very
// screen it's already on, over what's really just an inline form error.

import { AUTHED_FLAG_KEY } from "../auth/AuthGate";

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

async function handleResponse<T>(res: Response, opts: { skipAuthRedirect?: boolean } = {}): Promise<T> {
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

  if (res.status === 401 && !opts.skipAuthRedirect) {
    // Only redirect once: if the flag is already cleared, a redirect from
    // an earlier failed request in this same burst is presumably already
    // in flight (window.location.href navigation isn't instantaneous), so
    // skip triggering another one.
    if (typeof window !== "undefined" && localStorage.getItem(AUTHED_FLAG_KEY) !== null) {
      localStorage.removeItem(AUTHED_FLAG_KEY);
      window.location.href = "/setup";
    }
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
  opts?: { skipAuthRedirect?: boolean },
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
  return handleResponse<T>(res, opts);
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
