import React, { Suspense, useEffect } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell/AppShell";

const KROGER_RESUME_STORAGE_KEY = "krogerConnectResumeRecipeId";

/** Strips `?loggedIn=true` after a Google sign-in round trip (multi-tenancy
 * Slice 1, 2026-07-21) — AuthGate.tsx's isAuthed() already flips the
 * AUTHED_FLAG_KEY flag synchronously during render (see its comment for
 * why that can't wait for an effect), so this just tidies the URL,
 * mirroring useKrogerConnectResume's `?krogerConnected=true` handling
 * below. */
function useGoogleLoginResume(): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("loggedIn") !== "true") return;
    navigate("/", { replace: true });
  }, [location.search, navigate]);
}

/** Completes the Kroger connect/reconnect resume round trip (Phase 5 fix):
 * the OAuth callback (src/api/routes/kroger_auth.ts) is server-side and
 * can't see the client-only sessionStorage value ConnectKroger.tsx wrote
 * before the redirect, so it always redirects to the generic
 * `/?krogerConnected=true`. This effect picks that up on mount and, if a
 * resume recipe id is stashed, navigates on to that recipe's Review screen
 * (replacing history, not pushing, so the generic URL never sits in back
 * history) and clears the key.
 *
 * Deliberately NOT an auto-triggered cart-approval — this project's
 * established rule is that cart mutation is always an explicit user action.
 * Landing on Review just lets the user re-tap "Add to cart" themselves;
 * that POST is idempotent server-side and only re-attempts remaining
 * items. */
function useKrogerConnectResume(): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("krogerConnected") !== "true") return;

    const resumeRecipeId = sessionStorage.getItem(KROGER_RESUME_STORAGE_KEY);
    sessionStorage.removeItem(KROGER_RESUME_STORAGE_KEY);
    if (resumeRecipeId) {
      navigate(`/recipes/${resumeRecipeId}`, { replace: true });
    }
    // No resumeRecipeId stashed (e.g. a first-time connect with no prior
    // FailureCard deep-link) — leave the user on whatever
    // `/?krogerConnected=true` landed on; nothing else to do here.
  }, [location.search, navigate]);
}

// This file OWNS the entire route table for the RecipeCart web SPA. No
// screen-owning subagent should ever need to edit this file — each screen
// just needs to export a default component from its fixed path below.
//
// All routes are lazy-loaded and wrapped in AuthGate, since every screen in
// this slice assumes an authenticated (device-token) session.
const RecipesList = React.lazy(() => import("./screens/RecipesList/RecipesList"));
const Review = React.lazy(() => import("./screens/Review/Review"));
const CartProgress = React.lazy(() => import("./screens/CartProgress/CartProgress"));
const CartResult = React.lazy(() => import("./screens/CartResult/CartResult"));
const FailureCard = React.lazy(() => import("./screens/FailureCard/FailureCard"));
const ConnectKroger = React.lazy(() => import("./screens/ConnectKroger/ConnectKroger"));
const Preferences = React.lazy(() => import("./screens/Preferences/Preferences"));
const Privacy = React.lazy(() => import("./screens/Privacy/Privacy"));
const Setup = React.lazy(() => import("./screens/Setup/Setup"));
const Login = React.lazy(() => import("./screens/Login/Login"));

// /login is the one route AuthGate lets an unauthenticated visitor reach
// (see auth/AuthGate.tsx UNGATED_PATHS, multi-tenancy Slice 1 2026-07-21)
// — nav chrome pointing at authed-only routes (Preferences, Privacy, Home)
// would just be dead ends there. /setup is now authenticated-only (adding
// an additional device), so every other route — including /setup — already
// implies a signed-in session and gets the shell.
const SHELL_LESS_PATHS = new Set(["/login"]);

function Shell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (SHELL_LESS_PATHS.has(location.pathname)) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}

export default function App() {
  useKrogerConnectResume();
  useGoogleLoginResume();

  return (
    <AuthGate>
      <Shell>
        <Suspense fallback={<div>Loading…</div>}>
          <Routes>
            <Route path="/" element={<RecipesList />} />
            <Route path="/recipes/:id" element={<Review />} />
            <Route path="/recipes/:id/cart-progress" element={<CartProgress />} />
            <Route path="/recipes/:id/cart-result" element={<CartResult />} />
            <Route path="/recipes/:id/failed" element={<FailureCard />} />
            <Route path="/connect-kroger" element={<ConnectKroger />} />
            <Route path="/preferences" element={<Preferences />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
          </Routes>
        </Suspense>
      </Shell>
    </AuthGate>
  );
}
