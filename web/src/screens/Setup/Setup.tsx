import { useState } from "react";
import { Link } from "react-router-dom";
import { apiPost, ApiError } from "../../api/client";
import { AUTHED_FLAG_KEY } from "../../auth/AuthGate";
import { SHORTCUT_ICLOUD_URL } from "../../lib/shortcutConfig";
import "./Setup.css";

type DeviceTokenResponse = { token: string };

// Device-token setup screen (Spec 1 A1-2, WS-E Phase 4) — the SINGLE place
// a device token is minted and applied (AuthGate just redirects here for an
// unauthenticated visitor; see its own doc comment). Mints a fresh token
// from POST /api/setup/device-token, which ALSO sets an HttpOnly auth
// cookie on this response (see routes/setup.ts) — so generating a token
// logs the current browser in immediately, no separate paste-it-back-in
// step. The raw token is still displayed for pasting into the iOS
// Shortcut's first-run "Paste your RecipeCart device token" prompt (see
// docs/ios-shortcut.md §3.2) — a completely separate consumer that needs
// the plain value, not a cookie. Below the token, an "Add Shortcut to your
// device" button links to SHORTCUT_ICLOUD_URL (lib/shortcutConfig.ts) — a
// placeholder until someone builds the Shortcut once and pastes its real
// iCloud share link there; see that file's comment for why it can't be
// generated here.
// Minting is unauthenticated on the server side (see routes/setup.ts for
// why that's an acceptable tradeoff for this single-household MVP) and
// OVERWRITES any previously-issued token, so this screen makes that
// overwrite explicit rather than implying the action is additive.
export default function Setup() {
  const [token, setToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const result = await apiPost<DeviceTokenResponse>("/api/setup/device-token");
      setToken(result.token);
      // The response just set this browser's auth cookie server-side —
      // flip the client-side "am I set up" flag AuthGate checks so
      // navigating away doesn't bounce back here.
      localStorage.setItem(AUTHED_FLAG_KEY, "1");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't generate a device token.",
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically — select the text and copy it manually.");
    }
  };

  return (
    <main className="setup">
      <h1>Device setup</h1>
      <p>
        Generate a device token to connect your iOS Shortcut (or this browser) to your
        RecipeCart account.
      </p>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={generating}
        className="setup__generate"
      >
        {generating ? "Generating…" : "Generate device token"}
      </button>

      {error && (
        <p className="setup__error" role="alert">
          {error}
        </p>
      )}

      {token && (
        <div className="setup__result">
          <label htmlFor="device-token-value">Your device token</label>
          <div className="setup__token-row">
            <input
              id="device-token-value"
              type="text"
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" onClick={handleCopy} className="setup__copy">
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <p className="setup__instructions">
            This browser is now signed in — no further steps needed here. If you're
            also setting up the iOS Shortcut, copy this token and paste it into the
            Shortcut's first-run prompt — see the setup guide (
            <code>docs/ios-shortcut.md</code>) for details on building the Shortcut.
          </p>

          <p className="setup__warning" role="alert">
            Generating a new token invalidates any token you've issued before — this
            isn't additive. Any Shortcut or browser still using the old token will need
            to be updated with this one.
          </p>

          <div className="setup__shortcut">
            {SHORTCUT_ICLOUD_URL ? (
              <a
                href={SHORTCUT_ICLOUD_URL}
                className="setup__shortcut-install"
                target="_blank"
                rel="noopener noreferrer"
              >
                Add Shortcut to your device
              </a>
            ) : (
              <button type="button" className="setup__shortcut-install" disabled>
                Add Shortcut to your device
              </button>
            )}
            <p className="setup__shortcut-note">
              {SHORTCUT_ICLOUD_URL
                ? "Opens the Shortcuts app so you can install RecipeCart's capture Shortcut. It'll ask you to paste your device token the first time you run it — see the setup guide (docs/ios-shortcut.md) for details."
                : "Not set up yet — see docs/ios-shortcut.md §4 for how to build the Shortcut once and activate this button."}
            </p>
          </div>

          <Link to="/" className="setup__continue">
            Continue to RecipeCart →
          </Link>
        </div>
      )}
    </main>
  );
}
