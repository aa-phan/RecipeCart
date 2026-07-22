import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import "./AppShell.css";

// Global nav chrome (Phase 5 Slice 5). Before this, /preferences and
// /privacy were orphaned — reachable only by typing the URL — and there
// was no way back to /setup short of the browser bar. This is a single
// unobtrusive header bar, not a sidebar: RecipeCart's screen count doesn't
// justify more than that yet.
//
// Rendered INSIDE AuthGate (see App.tsx), so by the time this mounts the
// visitor is authed — the one ungated route AuthGate lets an unauthenticated
// visitor reach, /login (multi-tenancy Slice 1, 2026-07-21), never renders
// this component at all (App.tsx's Shell wrapper skips it there). /setup is
// authenticated-only as of that same slice, so it's a normal nav
// destination now, not a special case needing its own hidden-nav treatment.
export interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <NavLink to="/" className="app-shell__brand">
          <span className="app-shell__brand-recipe">Recipe</span>
          <span className="app-shell__brand-cart">Cart</span>
        </NavLink>
        <nav className="app-shell__nav" aria-label="Main">
          <NavLink
            to="/preferences"
            className={({ isActive }) =>
              isActive ? "app-shell__link app-shell__link--active" : "app-shell__link"
            }
          >
            Preferences
          </NavLink>
          <NavLink
            to="/privacy"
            className={({ isActive }) =>
              isActive ? "app-shell__link app-shell__link--active" : "app-shell__link"
            }
          >
            Privacy
          </NavLink>
          <NavLink
            to="/setup"
            className={({ isActive }) =>
              isActive ? "app-shell__link app-shell__link--active" : "app-shell__link"
            }
          >
            Devices
          </NavLink>
        </nav>
      </header>
      <div className="app-shell__content">{children}</div>
    </div>
  );
}
