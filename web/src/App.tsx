import React, { Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import AuthGate from "./auth/AuthGate";

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

export default function App() {
  return (
    <AuthGate>
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
        </Routes>
      </Suspense>
    </AuthGate>
  );
}
