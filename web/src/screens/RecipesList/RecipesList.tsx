import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api/client";
import type { RecipeListItemDto } from "../../api/types";
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

export default function RecipesList() {
  const [recipes, setRecipes] = useState<RecipeListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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
