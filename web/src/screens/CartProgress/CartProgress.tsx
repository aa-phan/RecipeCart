import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet } from "../../api/client";
import type { RecipeDetailDto } from "../../api/types";
import { usePolling } from "../../hooks/usePolling";
import StageLine from "../../components/StageLine";
import "./CartProgress.css";

// Job statuses that mean the cart-adding phase is over and we should leave
// this screen. `completed` / `partially_completed` land on the results
// screen; `failed` / `requires_user_intervention` land on the failure card.
// (Mirrors JobStatusValue in web/src/lib/stageLines.ts.)
const RESULT_STATUSES = new Set(["completed", "partially_completed"]);
const FAILURE_STATUSES = new Set(["failed", "requires_user_intervention"]);

export default function CartProgress() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<RecipeDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchRecipe = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiGet<RecipeDetailDto>(`/api/recipes/${id}`);
      setRecipe(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recipe");
    }
  }, [id]);

  useEffect(() => {
    fetchRecipe();
  }, [fetchRecipe]);

  usePolling(fetchRecipe, { activeMs: 2500 });

  useEffect(() => {
    if (!recipe || !id) return;
    if (RESULT_STATUSES.has(recipe.status)) {
      navigate(`/recipes/${id}/cart-result`, { replace: true });
    } else if (FAILURE_STATUSES.has(recipe.status)) {
      navigate(`/recipes/${id}/failed`, { replace: true });
    }
  }, [recipe, id, navigate]);

  return (
    <main className="cart-progress">
      <div className="cart-progress__spinner" aria-hidden="true" />
      <StageLine status={recipe?.status} className="cart-progress__stage" />

      {error && (
        <p className="cart-progress__error" role="alert">
          Couldn't check progress: {error}
        </p>
      )}

      <p className="cart-progress__note">
        This can take a minute. It's safe to close this tab — your cart will
        keep filling in the background, and you can check back anytime.
      </p>
    </main>
  );
}
