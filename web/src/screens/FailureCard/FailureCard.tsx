import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../api/client";
import type { RecipeDetailDto } from "../../api/types";
import { failureCardFor } from "../../lib/failureCards";
import "./FailureCard.css";

// Spec 1 §16: exactly one plain-language card + one primary recovery
// action. Never show raw errors, stack traces, or status codes. In
// particular, `failureReason` (the raw backend string on RecipeDetailDto)
// must never be rendered here — only logged for local dev debugging.
export default function FailureCard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [failureClass, setFailureClass] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reprocessing, setReprocessing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const recipe = await apiGet<RecipeDetailDto>(`/api/recipes/${id}`);
        if (cancelled) return;
        setFailureClass(recipe.failureClass);
        // Dev-only diagnostic; never rendered in the UI.
        console.debug("[FailureCard] failureReason:", recipe.failureReason);
      } catch (err) {
        if (!cancelled) {
          setError("Couldn't load this recipe's status.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const card = failureCardFor(failureClass);

  async function handleRecover() {
    if (!id) return;
    setReprocessing(true);
    setError(undefined);
    try {
      await apiPost(`/api/recipes/${id}/reprocess`);
      navigate(`/recipes/${id}`);
    } catch {
      setError("Couldn't restart processing. Please try again.");
      setReprocessing(false);
    }
  }

  if (loading) {
    return (
      <div className="failure-card">
        <p className="failure-card__loading">Loading…</p>
      </div>
    );
  }

  return (
    <div className="failure-card">
      <p className="failure-card__message">{card.message}</p>
      {card.recoveryHref && id ? (
        // Kroger connect/reconnect cards navigate out to /connect-kroger
        // rather than retrying a reprocess POST — there's nothing to
        // reprocess, the recipe extraction already succeeded; only the
        // Kroger connection needs fixing.
        <Link to={card.recoveryHref(id)} className="failure-card__action failure-card__action--link">
          {card.recoveryAction}
        </Link>
      ) : (
        <button
          onClick={handleRecover}
          disabled={reprocessing}
          className="failure-card__action"
        >
          {reprocessing ? "Retrying…" : card.recoveryAction}
        </button>
      )}
      {error && <p className="failure-card__error">{error}</p>}
      <div className="failure-card__back">
        <Link to="/">Back to recipes</Link>
      </div>
    </div>
  );
}
