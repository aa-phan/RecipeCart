import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

// Purely client-side "has this browser completed setup" marker. Genuine
// auth is the HttpOnly cookie /setup sets server-side (JS can't read it
// back out to check, by design), so this flag is what AuthGate checks
// instead — set by Setup.tsx immediately after a successful mint.
export const AUTHED_FLAG_KEY = "recipecart_authed";

// Routes reachable before a device token exists. /setup mints the FIRST
// token (Spec 1 A1-2) — gating it behind "you already have a token" is a
// chicken-and-egg bug for a genuinely first-time visitor, so it must render
// even when AuthGate would otherwise redirect away.
const UNGATED_PATHS = new Set(["/setup"]);

function isAuthed(): boolean {
  return typeof window !== "undefined" && localStorage.getItem(AUTHED_FLAG_KEY) === "1";
}

/**
 * Gates the app behind a device token, minted via /setup.
 *
 * Earlier versions of this component had their own paste-a-token form that
 * set a plain (non-HttpOnly) cookie directly from JS — a stopgap for when
 * there was no server route to hand a proper HttpOnly cookie off from.
 * /setup (src/api/routes/setup.ts) now IS that route: it mints the token,
 * stores its hash, AND sets the HttpOnly cookie server-side in the same
 * response. Two different ways to authenticate the same browser was
 * confusing and redundant, so this component no longer duplicates that
 * logic — it just sends an unauthenticated visitor to /setup.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const authed = isAuthed();
  const location = useLocation();

  if (authed || UNGATED_PATHS.has(location.pathname)) return <>{children}</>;

  return <Navigate to="/setup" replace />;
}
