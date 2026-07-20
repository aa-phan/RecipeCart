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
// visitor is either authed or on the one ungated route AuthGate still lets
// through (/setup). We still hide the Preferences/Privacy/Home links on
// /setup itself — those routes assume an authed session (they call
// authenticated APIs), and surfacing them mid paste-a-token flow would
// just be an extra dead end for a visitor who has no token yet.
export interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <NavLink to="/" className="app-shell__brand">
          RecipeCart
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
            Setup
          </NavLink>
        </nav>
      </header>
      <div className="app-shell__content">{children}</div>
    </div>
  );
}
