import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../api/client";
import type { RecipeDetailDto } from "../../api/types";
import { failureCardFor } from "../../lib/failureCards";

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
      <div style={{ maxWidth: 480, margin: "4rem auto", textAlign: "center" }}>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "4rem auto", textAlign: "center" }}>
      <p style={{ fontSize: "1.1rem", marginBottom: "1.5rem" }}>{card.message}</p>
      <button
        onClick={handleRecover}
        disabled={reprocessing}
        style={{
          padding: "0.75rem 1.5rem",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: reprocessing ? "default" : "pointer",
        }}
      >
        {reprocessing ? "Retrying…" : card.recoveryAction}
      </button>
      {error && (
        <p style={{ color: "crimson", marginTop: "1rem" }}>{error}</p>
      )}
      <div style={{ marginTop: "2rem" }}>
        <Link to="/">Back to recipes</Link>
      </div>
    </div>
  );
}
