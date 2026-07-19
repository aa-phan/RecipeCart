import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../../api/client";

export interface ApproveButtonProps {
  recipeId: string;
  itemCount: number;
}

/**
 * Final "Add N items to cart" action. Generates an Idempotency-Key once per
 * approval attempt and REUSES it across retries of that same attempt (never
 * regenerated on retry — that would defeat the point of idempotency). The
 * button is disabled while a request is in flight so a double-tap can't fire
 * two concurrent requests, on top of the idempotency key already making
 * server-side retries safe.
 */
export default function ApproveButton({ recipeId, itemCount }: ApproveButtonProps) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const handleApprove = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    try {
      await apiPost(`/api/recipes/${recipeId}/cart:approve`, undefined, {
        "Idempotency-Key": idempotencyKeyRef.current,
      });
      navigate(`/recipes/${recipeId}/cart-progress`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the cart run. Try again.");
      setPending(false);
      // Idempotency key is intentionally kept for the next retry attempt.
    }
  };

  return (
    <div className="approve-button">
      {error && (
        <p role="alert" className="approve-button__error">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleApprove}
        disabled={pending || itemCount === 0}
        className="approve-button__button"
      >
        {pending ? "Adding to cart…" : `Add ${itemCount} item${itemCount === 1 ? "" : "s"} to cart`}
      </button>
    </div>
  );
}
