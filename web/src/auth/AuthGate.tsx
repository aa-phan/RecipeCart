import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

// Purely client-side "has this browser completed sign-in" marker. Genuine
// auth is the HttpOnly cookie set server-side (JS can't read it back out to
// check, by design), so this flag is what AuthGate checks instead — set by
// google_auth.ts's callback (via a full-page redirect landing on `/`) for a
// fresh sign-in, or by Setup.tsx after minting an additional device token.
export const AUTHED_FLAG_KEY = "recipecart_authed";

// Routes reachable before a device token exists. /login is where a
// genuinely unauthenticated visitor signs in (multi-tenancy Slice 1,
// 2026-07-21 — replaces the old unauthenticated /setup mint). /setup
// itself is now authenticated-only (adding an ADDITIONAL device once
// already signed in), so it's deliberately NOT in this set anymore.
const UNGATED_PATHS = new Set(["/login"]);

function isAuthed(): boolean {
  if (typeof window === "undefined") return false;

  // google_auth.ts's OAuth callback lands the browser on `/?loggedIn=true`
  // after a successful sign-in — its cookie is already set server-side, so
  // this flips the client-side flag SYNCHRONOUSLY, during render, not in a
  // useEffect. An effect-based flip would run too late: this same
  // function's return value is what decides, on THIS render, whether to
  // redirect to /login — by the time an effect fired, AuthGate would have
  // already redirected away once, a real flash-of-login-screen bug. App.tsx
  // still has a small effect that strips the query param afterward
  // (mirrors its existing `?krogerConnected=true` handling), but doesn't
  // need to set the flag itself — this already has by the time it runs.
  if (new URLSearchParams(window.location.search).get("loggedIn") === "true") {
    localStorage.setItem(AUTHED_FLAG_KEY, "1");
  }

  return localStorage.getItem(AUTHED_FLAG_KEY) === "1";
}

/**
 * Gates the app behind a signed-in session.
 *
 * This is the FIRST gate only — it checks a purely client-side flag once,
 * before any API call happens, to catch a visitor who's never signed in at
 * all. It does not re-validate against the server, so it can't detect a
 * token that was valid when the flag was set but has since gone stale
 * (revoked from another device, expired). That ongoing case is handled
 * separately by api/client.ts: every API response is checked for 401, and
 * a 401 clears this same flag and navigates to /login from mid-session.
 * The two mechanisms are complementary — this one is the entry check,
 * client.ts is the staleness check — not redundant with each other.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const authed = isAuthed();
  const location = useLocation();

  if (authed || UNGATED_PATHS.has(location.pathname)) return <>{children}</>;

  return <Navigate to="/login" replace />;
}
