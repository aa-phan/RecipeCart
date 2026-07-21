// Client-side theme preference — spec-5-visual-design.md §2.4.
//
// This is a purely local display preference, deliberately NOT round-tripped
// through PreferencesDto/the API (unlike the rest of the Preferences
// screen's fields): it's stored in localStorage only, and applied by
// stamping `data-theme` on <html> before React ever renders, so there's no
// flash of the wrong theme on load.

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "recipecart_theme";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Reads the stored theme preference, defaulting to "system" if unset or invalid. */
export function getStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    // localStorage can throw in some privacy modes — fall back quietly.
    return "system";
  }
}

/** Applies a theme preference to <html> without persisting it. */
function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

/** Persists a theme preference and applies it immediately. */
export function setTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures — still apply the preference for this session.
  }
  applyTheme(theme);
}

/** Reads the stored preference and stamps <html> accordingly. Must be
 * called synchronously before the first React render to avoid a flash of
 * the wrong theme. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
