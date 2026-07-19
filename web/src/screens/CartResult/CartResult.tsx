// Cart result screen (Spec 1, PRD C1 §10.3). Fetches the terminal outcome of
// a cart-add run and shows it as two itemized lists — "Added" and "Needs
// attention" — rather than a single pass/fail state. Partial success is a
// normal, expected outcome here, not an error: Kroger's checkout is not
// automatable end-to-end, so some items routinely need the user to finish
// the job by hand on kroger.com.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, ApiError } from "../../api/client";
import type { CartResultDto } from "../../api/types";

// `CartItemResult` and `CartRunStatus` aren't re-exported from api/types.ts
// (only `CartResultDto` is), and this screen's scope is limited to files
// under screens/CartResult/ — so derive them structurally from the DTO
// rather than adding exports to the shared types barrel.
type CartItemResult = CartResultDto["results"][number];
type CartRunStatus = CartResultDto["status"];

const KROGER_CART_URL = "https://www.kroger.com/cart";

const STATUS_LABELS: Record<CartRunStatus, string> = {
  completed: "Cart complete",
  partially_completed: "Cart partially complete",
  requires_user_intervention: "Cart needs your attention",
  failed: "Cart run failed",
};

export default function CartResult() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CartResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<CartResultDto>(`/api/recipes/${id}/cart`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError ? err.message : "Failed to load cart result.";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return <div>Loading cart result…</div>;
  }

  if (error) {
    return (
      <div>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) {
    return <div>No cart result found.</div>;
  }

  const added = data.results.filter((item) => item.status === "added");
  const needsAttention = data.results.filter(
    (item) => item.status === "needs_attention",
  );

  return (
    <div>
      <h1>{STATUS_LABELS[data.status] ?? data.status}</h1>

      <section>
        <h2>Added ({added.length})</h2>
        {added.length === 0 ? (
          <p>No items were added.</p>
        ) : (
          <ul>
            {added.map((item) => (
              <AddedItem key={itemKey(item)} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Needs attention ({needsAttention.length})</h2>
        {needsAttention.length === 0 ? (
          <p>Nothing needs attention.</p>
        ) : (
          <ul>
            {needsAttention.map((item) => (
              <NeedsAttentionItem key={itemKey(item)} item={item} recipeId={id} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function itemKey(item: CartItemResult): string {
  return item.ingredientId ? `${item.ingredientId}-${item.upc}` : item.upc;
}

function AddedItem({ item }: { item: CartItemResult }) {
  return (
    <li>
      UPC {item.upc}
      {item.ingredientId ? ` (ingredient ${item.ingredientId})` : ""} — added
    </li>
  );
}

function NeedsAttentionItem({
  item,
  recipeId,
}: {
  item: CartItemResult;
  recipeId: string | undefined;
}) {
  return (
    <li>
      <div>
        UPC {item.upc}
        {item.ingredientId ? ` (ingredient ${item.ingredientId})` : ""}
        {item.reason ? ` — ${item.reason}` : ""}
      </div>
      <div>
        <a href={KROGER_CART_URL} target="_blank" rel="noopener noreferrer">
          Open Kroger to finish shopping
        </a>
        {recipeId ? (
          <>
            {" "}
            <Link to={`/recipes/${recipeId}`}>choose alternate</Link>
          </>
        ) : null}
      </div>
    </li>
  );
}
