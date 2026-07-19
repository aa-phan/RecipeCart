import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "../../api/client";
import type { PreferencesDto } from "../../api/types";
import "./Preferences.css";

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
