import { useState } from "react";
import { apiPost, ApiError } from "../../api/client";
import "./Setup.css";

type DeviceTokenResponse = { token: string };

// Device-token setup screen (Spec 1 A1-2, WS-E Phase 4). Mints a fresh
// device token from POST /api/setup/device-token and displays it once so it
// can be copied into the iOS Shortcut's "Get device token" step (see
// docs/ios-shortcut.md for the full Shortcut-build walkthrough). Minting is
// unauthenticated on the server side (see routes/setup.ts for why that's an
// acceptable tradeoff for this single-household MVP) and OVERWRITES any
// previously-issued token, so this screen makes that overwrite explicit
// rather than implying the action is additive.
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
            Paste this token into the "Get device token" step of your RecipeCart
            Shortcut — see the setup guide (<code>docs/ios-shortcut.md</code>) for
            details on building the Shortcut.
          </p>

          <p className="setup__warning" role="alert">
            Generating a new token invalidates any token you've issued before — this
            isn't additive. Any Shortcut or browser still using the old token will need
            to be updated with this one.
          </p>
        </div>
      )}
    </main>
  );
}
