import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { apiGet } from "../../api/client";
import type { IngredientDto, MatchDto, RecipeDetailDto } from "../../api/types";
import { usePolling } from "../../hooks/usePolling";
import StageLine from "../../components/StageLine";
import IngredientCard from "./IngredientCard";
import ApproveButton from "./ApproveButton";
import "./Review.css";

// Integration note: `GET /api/recipes/:id` returns `matches: MatchDto[]`
// keyed by `ingredientId` — each ingredient renders as one unified
// IngredientCard combining the amount editor and the product picker
// (Phase 5 Slice 3 redesign; previously two separate stacked sections).

function parseSourceHandle(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    // Best-effort creator handle: TikTok URLs are typically
    // tiktok.com/@handle/video/... — fall back to the raw URL otherwise.
    const match = url.pathname.match(/\/(@[\w.-]+)/);
    if (match) return match[1];
    return sourceUrl;
  } catch {
    return sourceUrl;
  }
}

const PROCESSING_STATUSES = new Set([
  "received",
  "validating",
  "downloading",
  "processing_media",
  "extracting_recipe",
  "matching_products",
]);

export default function Review() {
  const { id } = useParams<{ id: string }>();
  const [recipe, setRecipe] = useState<RecipeDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const fetchRecipe = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiGet<RecipeDetailDto>(`/api/recipes/${id}`);
      setRecipe(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load this recipe.");
    }
  }, [id]);

  useEffect(() => {
    fetchRecipe();
  }, [fetchRecipe]);

  const isProcessing = recipe ? PROCESSING_STATUSES.has(recipe.status) : true;

  // Poll while still processing; once the recipe reaches awaiting_review (or
  // any other terminal-for-this-screen state), stop polling by skipping the
  // actual fetch inside the tick — usePolling itself only has a cadence
  // knob, not a hard on/off switch, so this is how "stop" is expressed.
  usePolling(
    () => {
      if (isProcessing) fetchRecipe();
    },
    { active: isProcessing },
  );

  const handleIngredientChange = (updated: IngredientDto) => {
    setRecipe((prev) =>
      prev
        ? {
            ...prev,
            ingredients: prev.ingredients.map((ing) => (ing.id === updated.id ? updated : ing)),
          }
        : prev,
    );
  };

  const handleIngredientRemove = (ingredientId: string) => {
    setRecipe((prev) =>
      prev
        ? { ...prev, ingredients: prev.ingredients.filter((ing) => ing.id !== ingredientId) }
        : prev,
    );
  };

  const handleMatchChange = (updated: MatchDto) => {
    setRecipe((prev) =>
      prev
        ? {
            ...prev,
            matches: prev.matches.map((m) =>
              m.ingredientId === updated.ingredientId ? updated : m,
            ),
          }
        : prev,
    );
  };

  const handleAddIngredient = async () => {
    const trimmed = addName.trim();
    if (!trimmed || !id) return;
    setAddBusy(true);
    try {
      const { apiPost } = await import("../../api/client");
      const created = await apiPost<IngredientDto>(`/api/recipes/${id}/ingredients`, {
        canonicalName: trimmed,
      });
      setRecipe((prev) => (prev ? { ...prev, ingredients: [...prev.ingredients, created] } : prev));
      setAddName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that ingredient.");
    } finally {
      setAddBusy(false);
    }
  };

  if (error && !recipe) {
    return (
      <main className="review">
        <p role="alert" className="review__error">
          Couldn't load this recipe: {error}
        </p>
      </main>
    );
  }

  if (!recipe) {
    return (
      <main className="review">
        <p className="review__loading">Loading recipe…</p>
      </main>
    );
  }

  if (isProcessing) {
    return (
      <main className="review">
        <h1>{recipe.title?.trim() || "Your recipe"}</h1>
        <StageLine status={recipe.status} className="review__stage-line" />
        <p className="review__processing-note">
          We'll show your ingredients here as soon as they're ready to review.
        </p>
      </main>
    );
  }

  // Real bug, caught live 2026-07-20: a genuinely failed extraction (zero
  // ingredients ever created) fell through to the ingredient-review UI
  // below, whose empty state ("No ingredients left — add one below") wrongly
  // implies the fix is to add an ingredient, when actually nothing was ever
  // extracted. FailureCard (a dedicated screen + /recipes/:id/failed route)
  // already existed and is already used by CartProgress/ConnectKroger for
  // their own failure paths — it was just never wired up here, the actual
  // first place most extraction failures surface.
  if (recipe.status === "failed") {
    return <Navigate to={`/recipes/${recipe.id}/failed`} replace />;
  }

  const itemCount = recipe.ingredients.length;

  return (
    <main className="review">
      <header className="review__header">
        <h1>{recipe.title?.trim() || "Your recipe"}</h1>
        <p className="review__source">{parseSourceHandle(recipe.sourceUrl)}</p>
        <div className="review__banner" role="status">
          Review your ingredients below
        </div>
      </header>

      {error && (
        <p role="alert" className="review__error">
          {error}
        </p>
      )}

      <ul className="review__ingredients">
        {recipe.ingredients.map((ingredient) => {
          const match = recipe.matches.find((m) => m.ingredientId === ingredient.id);
          return (
            <IngredientCard
              key={ingredient.id}
              recipeId={recipe.id}
              ingredient={ingredient}
              match={match}
              onIngredientChange={handleIngredientChange}
              onIngredientRemove={handleIngredientRemove}
              onMatchChange={handleMatchChange}
            />
          );
        })}
      </ul>

      {recipe.ingredients.length === 0 && (
        <p className="review__empty">No ingredients left — add one below or check the source video.</p>
      )}

      <form
        className="review__add-ingredient"
        onSubmit={(e) => {
          e.preventDefault();
          handleAddIngredient();
        }}
      >
        <label htmlFor="add-ingredient-name" className="visually-hidden">
          Add an ingredient
        </label>
        <input
          id="add-ingredient-name"
          type="text"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          placeholder="Add an ingredient we missed"
          disabled={addBusy}
        />
        <button type="submit" disabled={addBusy || addName.trim().length === 0}>
          Add
        </button>
      </form>

      <ApproveButton recipeId={recipe.id} itemCount={itemCount} />
    </main>
  );
}
