import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiPost, apiGet, apiDelete, ApiError } from "../../api/client";
import type { DeviceDto } from "../../api/types";
import { AUTHED_FLAG_KEY } from "../../auth/AuthGate";
import { SHORTCUT_ICLOUD_URL } from "../../lib/shortcutConfig";
import "./Setup.css";

type DeviceTokenResponse = { token: string; device: DeviceDto };

function formatLastUsed(lastUsedAt: string | null): string {
  return lastUsedAt ? new Date(lastUsedAt).toLocaleDateString() : "Never used";
}

// Device management screen (Spec 1 A1-2, WS-E Phase 4; re-scoped by
// multi-tenancy Slice 1, 2026-07-21). Used to be the unauthenticated
// front door that minted the very FIRST device token for anyone who found
// the URL — that was a real, live vulnerability (see routes/setup.ts's
// header). screens/Login/Login.tsx (Google sign-in) is the front door now;
// this screen is reachable only once already signed in, and mints an
// ADDITIONAL device token for the CURRENT account — e.g. pasting one into
// the iOS Shortcut's first-run prompt (see docs/ios-shortcut.md §3.2), a
// completely separate consumer that needs the plain value, not a cookie.
// Below the token, an "Add Shortcut to your device" button links to
// SHORTCUT_ICLOUD_URL (lib/shortcutConfig.ts) — a placeholder until
// someone builds the Shortcut once and pastes its real iCloud share link
// there; see that file's comment for why it can't be generated here.
// Each mint creates a new, independently-revocable device (see DeviceDto /
// GET /api/devices below) rather than invalidating any token issued
// before it.
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
      const result = await apiPost<DeviceTokenResponse>("/api/setup/device-token", {
        deviceName: deviceName.trim() || undefined,
      });
      setToken(result.token);
      // The response just set this browser's auth cookie server-side —
      // flip the client-side "am I set up" flag AuthGate checks so
      // navigating away doesn't bounce back here.
      localStorage.setItem(AUTHED_FLAG_KEY, "1");
      fetchDevices();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't generate a device token.",
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
      <h1>Manage devices</h1>
      <p>
        Generate a device token to connect your iOS Shortcut (or another browser) to your
        RecipeCart account.
      </p>

      <div className="setup__name-row">
        <label htmlFor="device-name-input">Device name (optional)</label>
        <input
          id="device-name-input"
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="e.g. iPhone Shortcut, MacBook Safari"
          className="setup__name-input"
        />
      </div>

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

          <p className="setup__note">
            This adds a new device to your account — it doesn't affect any device
            already signed in. Manage or revoke devices below at any time.
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

      <section className="setup__devices">
        <h2>Your devices</h2>

        {devicesError && (
          <p className="setup__error" role="alert">
            {devicesError}
          </p>
        )}

        {devicesLoading && !devices ? (
          <p className="setup__devices-loading">Loading your devices…</p>
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
