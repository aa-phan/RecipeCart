import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, ApiError } from "../../api/client";
import type { PreferencesDto, StoreLocationDto } from "../../api/types";
import { getStoredTheme, setTheme, type ThemePreference } from "../../theme";
import "./Preferences.css";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

// Comma-separated text <-> string[] helpers for the two list fields.
function toCsv(items: string[]): string {
  return items.join(", ");
}

function fromCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function Preferences() {
  const [storeBrandPreferred, setStoreBrandPreferred] = useState(false);
  const [organicPreferred, setOrganicPreferred] = useState(false);
  const [dietaryTagsCsv, setDietaryTagsCsv] = useState("");
  const [pantryAlwaysOwnedCsv, setPantryAlwaysOwnedCsv] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Store location (multi-tenancy Slice 2, 2026-07-22): each account has its
  // own Kroger store now (kroger/store_config.ts is per-user), so this is
  // the one place a non-owner account — no CLI/shell access at all — can
  // set theirs. GET 404s when nothing's configured yet; that's expected on
  // a brand-new account, not an error to surface.
  const [store, setStore] = useState<StoreLocationDto | null>(null);
  const [storeLoading, setStoreLoading] = useState(true);
  const [storeZipCode, setStoreZipCode] = useState("");
  const [storeSaving, setStoreSaving] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

  // Purely client-side display preference — stored in localStorage, not
  // part of PreferencesDto/the API round trip (spec-5-visual-design.md §2.4).
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    () => getStoredTheme(),
  );

  const handleThemeChange = (theme: ThemePreference) => {
    setThemePreference(theme);
    setTheme(theme);
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await apiGet<PreferencesDto>("/api/preferences");
        if (cancelled) return;
        setStoreBrandPreferred(data.storeBrandPreferred);
        setOrganicPreferred(data.organicPreferred);
        setDietaryTagsCsv(toCsv(data.dietaryTags));
        setPantryAlwaysOwnedCsv(toCsv(data.pantryAlwaysOwned));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load preferences",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await apiGet<StoreLocationDto>("/api/store-location");
        if (!cancelled) setStore(data);
      } catch (err) {
        // 404 just means no store configured yet — not an error state.
        if (!cancelled && !(err instanceof ApiError && err.status === 404)) {
          setStoreError(err instanceof Error ? err.message : "Failed to load store location");
        }
      } finally {
        if (!cancelled) setStoreLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveStore = async () => {
    const zipCode = storeZipCode.trim();
    if (!zipCode) return;
    setStoreSaving(true);
    setStoreError(null);
    try {
      const saved = await apiPost<StoreLocationDto>("/api/store-location", { zipCode });
      setStore(saved);
      setStoreZipCode("");
    } catch (err) {
      setStoreError(err instanceof ApiError ? err.message : "Failed to find/save a store.");
    } finally {
      setStoreSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const body: PreferencesDto = {
        storeBrandPreferred,
        organicPreferred,
        dietaryTags: fromCsv(dietaryTagsCsv),
        pantryAlwaysOwned: fromCsv(pantryAlwaysOwnedCsv),
      };
      const updated = await apiPatch<PreferencesDto>("/api/preferences", body);
      setStoreBrandPreferred(updated.storeBrandPreferred);
      setOrganicPreferred(updated.organicPreferred);
      setDietaryTagsCsv(toCsv(updated.dietaryTags));
      setPantryAlwaysOwnedCsv(toCsv(updated.pantryAlwaysOwned));
      setSaveMessage("Preferences saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="preferences">
        <h1>Preferences</h1>
        <p className="preferences__loading">Loading preferences…</p>
      </main>
    );
  }

  return (
    <main className="preferences">
      <h1>Preferences</h1>

      {error && (
        <p className="preferences__error" role="alert">
          {error}
        </p>
      )}

      <section className="preferences__section" aria-labelledby="store-heading">
        <h2 id="store-heading" className="preferences__section-heading">
          Store
        </h2>
        <p className="preferences__section-hint">
          Recipes are matched against this store's Kroger inventory.
        </p>

        {storeError && (
          <p className="preferences__error" role="alert">
            {storeError}
          </p>
        )}

        {storeLoading ? (
          <p className="preferences__section-hint">Loading store…</p>
        ) : store ? (
          <p className="preferences__store-current">
            Current store: <strong>{store.name}</strong> ({store.zipCode})
          </p>
        ) : (
          <p className="preferences__section-hint">No store configured yet.</p>
        )}

        <div className="preferences__field preferences__store-field">
          <label htmlFor="store-zip">
            {store ? "Change store — enter a zip code" : "Enter a zip code to find your store"}
          </label>
          <div className="preferences__store-row">
            <input
              id="store-zip"
              type="text"
              inputMode="numeric"
              value={storeZipCode}
              onChange={(e) => setStoreZipCode(e.target.value)}
              placeholder="e.g. 75201"
            />
            <button
              type="button"
              onClick={handleSaveStore}
              disabled={storeSaving || storeZipCode.trim().length === 0}
              className="preferences__store-save"
            >
              {storeSaving ? "Finding…" : "Find & save"}
            </button>
          </div>
        </div>
      </section>

      <section
        className="preferences__section"
        aria-labelledby="theme-heading"
      >
        <h2 id="theme-heading" className="preferences__section-heading">
          Appearance
        </h2>
        <p className="preferences__section-hint">
          This device only — not saved to your account.
        </p>
        <div className="theme-toggle" role="radiogroup" aria-labelledby="theme-heading">
          {THEME_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={
                "theme-toggle__option" +
                (themePreference === option.value
                  ? " theme-toggle__option--selected"
                  : "")
              }
            >
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={themePreference === option.value}
                onChange={() => handleThemeChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </section>

      <div className="preferences__field">
        <label>
          <input
            type="checkbox"
            checked={storeBrandPreferred}
            onChange={(e) => setStoreBrandPreferred(e.target.checked)}
          />
          Prefer store brand products
        </label>
      </div>

      <div className="preferences__field">
        <label>
          <input
            type="checkbox"
            checked={organicPreferred}
            onChange={(e) => setOrganicPreferred(e.target.checked)}
          />
          Prefer organic products
        </label>
      </div>

      <div className="preferences__field">
        <label htmlFor="dietary-tags">Dietary tags (comma-separated)</label>
        <input
          id="dietary-tags"
          type="text"
          value={dietaryTagsCsv}
          onChange={(e) => setDietaryTagsCsv(e.target.value)}
          placeholder="vegetarian, gluten-free"
        />
      </div>

      <div className="preferences__field">
        <label htmlFor="pantry-items">
          Pantry items always owned (comma-separated)
        </label>
        <input
          id="pantry-items"
          type="text"
          value={pantryAlwaysOwnedCsv}
          onChange={(e) => setPantryAlwaysOwnedCsv(e.target.value)}
          placeholder="salt, olive oil, black pepper"
        />
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="preferences__save"
      >
        {saving ? "Saving…" : "Save"}
      </button>

      {saveMessage && (
        <p className="preferences__save-message" role="status">
          {saveMessage}
        </p>
      )}
    </main>
  );
}
