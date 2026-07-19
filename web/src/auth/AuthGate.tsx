import { useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

const AUTHED_FLAG_KEY = "recipecart_authed";
const DEVICE_TOKEN_COOKIE = "recipecart_device_token";

// Routes reachable before a device token exists. /setup mints the FIRST
// token (Spec 1 A1-2) — gating it behind "you already have a token" is a
// chicken-and-egg bug for a genuinely first-time visitor, so it must render
// even when AuthGate would otherwise show the paste-token form.
const UNGATED_PATHS = new Set(["/setup"]);

function isAuthed(): boolean {
  return typeof window !== "undefined" && localStorage.getItem(AUTHED_FLAG_KEY) === "1";
}

/**
 * Gates the app behind a pasted device token.
 *
 * The real API auth cookie is meant to be HTTP-only, which JS can't set
 * directly — and this slice has no login endpoint to hand that off to the
 * server. As a pragmatic MVP-local-dev bootstrap, the form instead sets a
 * plain (non-HTTP-only) cookie with the raw token itself, which the API can
 * read the same way it'd read a proper session cookie. This is fine for
 * local dev; a real Phase 4 iOS-Shortcut-based provisioning flow would set
 * this cookie server-side as HTTP-only instead.
 *
 * The `recipecart_authed` localStorage flag is a separate, purely
 * client-side "have I completed the paste-token step" marker — AuthGate
 * can't read the cookie's value back out to decide whether to show the
 * form (that's the point of it being a cookie), so this flag is what it
 * checks instead.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(isAuthed);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  if (authed || UNGATED_PATHS.has(location.pathname)) return <>{children}</>;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Paste your device token first.");
      return;
    }
    document.cookie = `${DEVICE_TOKEN_COOKIE}=${trimmed}; path=/; max-age=31536000`;
    localStorage.setItem(AUTHED_FLAG_KEY, "1");
    setAuthed(true);
  };

  return (
    <div style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Connect this device</h1>
      <p>
        Run <code>recipecart create-device-token</code> on your machine, then paste the
        token it prints below.
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="device-token">Device token</label>
        <input
          id="device-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ display: "block", width: "100%", margin: "0.5rem 0" }}
        />
        {error && (
          <p role="alert" style={{ color: "#b3261e" }}>
            {error}
          </p>
        )}
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}
