import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPost, ApiError } from "../../api/client";
import type { RecipeListItemDto, SubmitRecipeResponse } from "../../api/types";
import { usePolling } from "../../hooks/usePolling";
import RecipeCard from "./RecipeCard";
import "./RecipesList.css";

// Statuses that mean "nothing more will happen without user/system action" —
// used to decide whether polling should run at the fast (active) cadence.
const TERMINAL_STATUSES = new Set([
  "completed",
  "partially_completed",
  "failed",
  "expired",
]);

// Interim substitute for the iOS Shortcut (Phase 4) — Spec 4's Phase 3 exit
// criteria explicitly allows "curl or a simple form" for submission, so this
// form is spec-sanctioned, not a permanent product surface.
export default function RecipesList() {
  const [recipes, setRecipes] = useState<RecipeListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);

  const fetchRecipes = useCallback(async () => {
    try {
      const data = await apiGet<RecipeListItemDto[]>("/api/recipes");
      setRecipes(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recipes");
    }
  }, []);

  useEffect(() => {
    fetchRecipes();
  }, [fetchRecipes]);

  const hasActiveJob = (recipes ?? []).some(
    (item) => !TERMINAL_STATUSES.has(item.status),
  );

  usePolling(fetchRecipes, { active: hasActiveJob });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchRecipes();
    setIsRefreshing(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = sourceUrl.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNote(null);
    try {
      const result = await apiPost<SubmitRecipeResponse>("/api/recipes", {
        sourceUrl: trimmed,
      });
      setSourceUrl("");
      setSubmitNote(
        result.created
          ? "Submitted — it'll appear below as it processes."
          : "Already submitted recently — showing its current status below.",
      );
      await fetchRecipes();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : "Couldn't submit that URL.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="recipes-list">
      <header className="recipes-list__header">
        <h1>Your recipes</h1>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="recipes-list__refresh"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <form className="recipes-list__submit" onSubmit={handleSubmit}>
        <label htmlFor="submit-url" className="visually-hidden">
          TikTok recipe URL
        </label>
        <input
          id="submit-url"
          type="url"
          inputMode="url"
          placeholder="Paste a TikTok recipe URL…"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || sourceUrl.trim().length === 0}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </form>
      {submitNote && (
        <p className="recipes-list__submit-note" role="status">
          {submitNote}
        </p>
      )}
      {submitError && (
        <p className="recipes-list__submit-error" role="alert">
          {submitError}
        </p>
      )}

      {error && (
        <p className="recipes-list__error" role="alert">
          Couldn't load recipes: {error}
        </p>
      )}

      {recipes === null && !error && (
        <p className="recipes-list__loading">Loading recipes…</p>
      )}

      {recipes !== null && recipes.length === 0 && (
        <p className="recipes-list__empty">
          No recipes yet — submit one to get started.
        </p>
      )}

      {recipes !== null && recipes.length > 0 && (
        <ul className="recipes-list__items">
          {recipes.map((item) => (
            <RecipeCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </main>
  );
}
