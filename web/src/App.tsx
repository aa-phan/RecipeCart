import React, { Suspense } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell/AppShell";

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

// /setup is the one route AuthGate lets an unauthenticated visitor reach
// (see auth/AuthGate.tsx UNGATED_PATHS) — it's the paste-a-token screen,
// so nav chrome pointing at authed-only routes (Preferences, Privacy, Home)
// would just be dead ends there. Every other route already implies an
// authed session, so the shell renders everywhere else.
const SHELL_LESS_PATHS = new Set(["/setup"]);

function Shell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (SHELL_LESS_PATHS.has(location.pathname)) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}

export default function App() {
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
          </Routes>
        </Suspense>
      </Shell>
    </AuthGate>
  );
}
