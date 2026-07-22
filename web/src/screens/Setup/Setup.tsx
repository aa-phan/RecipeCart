import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiPost, apiGet, apiDelete, ApiError } from "../../api/client";
import type { DeviceDto } from "../../api/types";
import { SHORTCUT_ICLOUD_URL } from "../../lib/shortcutConfig";
import "./Setup.css";

type DeviceTokenResponse = { token: string; device: DeviceDto };

function formatLastUsed(lastUsedAt: string | null): string {
  return lastUsedAt ? new Date(lastUsedAt).toLocaleDateString() : "Never used";
}

// Devices/sessions screen (Spec 1 A1-2, WS-E Phase 4; re-scoped by
// multi-tenancy Slice 1, 2026-07-21; narrowed to the Shortcut specifically,
// 2026-07-22). Used to be the unauthenticated front door that minted the
// very FIRST device token for anyone who found the URL — that was a real,
// live vulnerability (see routes/setup.ts's header). screens/Login/
// Login.tsx (Google sign-in) is the front door now; this screen is
// reachable only once already signed in.
//
// Two genuinely different things live on this one screen:
//   1. Minting a token for the iOS Shortcut — the ONE remaining real use
//      case for a manual token, since the Shortcut can't do a browser
//      OAuth redirect or read an HttpOnly cookie (see docs/ios-shortcut.md
//      §3.2). A new BROWSER should just sign in with Google directly
//      instead of generating a token here — that already mints its own
//      session automatically (google_auth.ts). Below the token, an "Add
//      Shortcut to your device" button links to SHORTCUT_ICLOUD_URL
//      (lib/shortcutConfig.ts) — a placeholder until someone builds the
//      Shortcut once and pastes its real iCloud share link there; see
//      that file's comment for why it can't be generated here.
//   2. Managing active sessions (GET/DELETE /api/devices) — every browser
//      you've signed into via Google AND every Shortcut token you've
//      minted show up in the same list, independently revocable.
export default function Setup() {
  const [deviceName, setDeviceName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const result = await apiGet<DeviceDto[]>("/api/devices");
      setDevices(result);
    } catch (err) {
      setDevicesError(
        err instanceof ApiError ? err.message : "Couldn't load your devices.",
      );
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      // Deliberately does NOT touch this browser's own session — as of the
      // 2026-07-22 re-scoping, the backend no longer sets a cookie on this
      // response (see routes/setup.ts). This mint exists purely to hand a
      // raw token to the Shortcut, not to re-authenticate this browser.
      const result = await apiPost<DeviceTokenResponse>("/api/setup/device-token", {
        deviceName: deviceName.trim() || undefined,
      });
      setToken(result.token);
      fetchDevices();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't generate a Shortcut token.",
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setDevicesError(null);
    const previous = devices;
    // Optimistic removal, matching RecipeCard's delete-with-list-refresh
    // pattern — roll back if the request fails.
    setDevices((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
    try {
      await apiDelete(`/api/devices/${id}`);
    } catch (err) {
      setDevices(previous ?? null);
      setDevicesError(
        err instanceof ApiError ? err.message : "Couldn't revoke that device.",
      );
    } finally {
      setRevokingId(null);
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
      <h1>Devices</h1>
      <p>
        Using RecipeCart from a new browser? Just sign in with Google there directly — it
        connects itself automatically. Generating a token below is only for the iOS
        Shortcut, which can't sign in with Google on its own.
      </p>

      <div className="setup__name-row">
        <label htmlFor="device-name-input">Shortcut name (optional)</label>
        <input
          id="device-name-input"
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="e.g. iPhone Shortcut, Work iPhone"
          className="setup__name-input"
        />
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={generating}
        className="setup__generate"
      >
        {generating ? "Generating…" : "Generate Shortcut token"}
      </button>

      {error && (
        <p className="setup__error" role="alert">
          {error}
        </p>
      )}

      {token && (
        <div className="setup__result">
          <label htmlFor="device-token-value">Your Shortcut token</label>
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
            Copy this and paste it into the Shortcut's first-run prompt — see the setup
            guide (<code>docs/ios-shortcut.md</code>) for details on building the
            Shortcut.
          </p>

          <p className="setup__note">
            This doesn't affect this browser's own session, or any other device already
            signed in. Manage or revoke sessions below at any time.
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
            Back to RecipeCart →
          </Link>
        </div>
      )}

      <section className="setup__devices">
        <h2>Active sessions</h2>
        <p className="setup__devices-hint">
          Every browser you've signed into with Google, plus any Shortcut tokens you've
          generated. Revoke one to sign it out immediately.
        </p>

        {devicesError && (
          <p className="setup__error" role="alert">
            {devicesError}
          </p>
        )}

        {devicesLoading && !devices ? (
          <p className="setup__devices-loading">Loading your sessions…</p>
        ) : devices && devices.length > 0 ? (
          <ul className="setup__devices-list">
            {devices.map((device) => (
              <li key={device.id} className="setup__device">
                <div className="setup__device-info">
                  <span className="setup__device-name">{device.deviceName}</span>
                  <span className="setup__device-meta">
                    Added {new Date(device.createdAt).toLocaleDateString()} ·{" "}
                    {formatLastUsed(device.lastUsedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevoke(device.id)}
                  disabled={revokingId === device.id}
                  className="setup__device-revoke"
                >
                  {revokingId === device.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="setup__devices-empty">No devices yet.</p>
        )}
      </section>
    </main>
  );
}
