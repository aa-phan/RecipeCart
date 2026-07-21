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
import "./CartResult.css";

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
    return <div className="cart-result cart-result__loading">Loading cart result…</div>;
  }

  if (error) {
    return (
      <div className="cart-result">
        <p className="cart-result__error" role="alert">
          {error}
        </p>
        <BackToRecipesLink />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="cart-result">
        <p>No cart result found.</p>
        <BackToRecipesLink />
      </div>
    );
  }

  const added = data.results.filter((item) => item.status === "added");
  const needsAttention = data.results.filter(
    (item) => item.status === "needs_attention",
  );
  // Sum of per-item prices for the receipt total. `CartResultDto` carries no
  // separate total field, so this is computed client-side from the same
  // per-item `price` the row already displays; missing prices contribute 0
  // rather than breaking the total.
  const addedTotal = added.reduce(
    (sum, item) => sum + (typeof item.price === "number" ? item.price : 0),
    0,
  );

  return (
    <div className="cart-result">
      <header className="cart-result__header">
        <h1>{STATUS_LABELS[data.status] ?? data.status}</h1>
        <BackToRecipesLink />
      </header>

      <section className="cart-result__section">
        <h2>Added ({added.length})</h2>
        {added.length === 0 ? (
          <p className="cart-result__empty">No items were added.</p>
        ) : (
          <div className="cart-result__receipt">
            <ul className="cart-result__receipt-items">
              {added.map((item) => (
                <ReceiptItem key={itemKey(item)} item={item} />
              ))}
            </ul>
            <div className="cart-result__receipt-rule" aria-hidden="true" />
            <div className="cart-result__receipt-rule cart-result__receipt-rule--thin" aria-hidden="true" />
            <div className="cart-result__receipt-total">
              <span className="cart-result__receipt-total-label">Total</span>
              <span className="cart-result__receipt-total-value">
                ${addedTotal.toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="cart-result__section">
        <h2>Needs attention ({needsAttention.length})</h2>
        {needsAttention.length === 0 ? (
          <p className="cart-result__empty">Nothing needs attention.</p>
        ) : (
          <ul className="cart-result__items">
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

/** Display name for an item — falls back to the UPC when no product name is
 * available (e.g. a total failure with no matched candidate). Never shows
 * the raw ingredient UUID to the user. */
function displayName(item: CartItemResult): string {
  return item.productName?.trim() ? item.productName : `UPC ${item.upc}`;
}

function ProductThumbnail({ item }: { item: CartItemResult }) {
  const [failed, setFailed] = useState(false);
  if (!item.imageUrl || failed) {
    return (
      <div className="cart-result__thumb cart-result__thumb--placeholder" aria-hidden="true" />
    );
  }
  return (
    <img
      className="cart-result__thumb"
      src={item.imageUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function ItemPrice({ item }: { item: CartItemResult }) {
  if (item.price === undefined || item.price === null) return null;
  return <span className="cart-result__price">${item.price.toFixed(2)}</span>;
}

/** A single line item in the receipt-styled "Added" panel (spec §2.5): name
 * on the left in the body face, a dotted leader running to the price on the
 * right in the display face — the itemized-receipt line, not a generic card
 * row. `NeedsAttentionItem` below keeps the plain card treatment; the
 * receipt motif is intentionally confined to genuinely-added items. */
function ReceiptItem({ item }: { item: CartItemResult }) {
  const priceLabel =
    item.price === undefined || item.price === null
      ? "—"
      : `$${item.price.toFixed(2)}`;
  return (
    <li className="cart-result__receipt-item">
      <div className="cart-result__receipt-line">
        <span className="cart-result__receipt-name">{displayName(item)}</span>
        <span className="cart-result__receipt-leader" aria-hidden="true" />
        <span className="cart-result__receipt-price">{priceLabel}</span>
      </div>
      {item.reason && <p className="cart-result__reason">{item.reason}</p>}
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
    <li className="cart-result__item">
      <ProductThumbnail item={item} />
      <div className="cart-result__item-body">
        <span className="cart-result__item-name">{displayName(item)}</span>
        <div className="cart-result__item-meta">
          <span className="cart-result__badge cart-result__badge--needs-attention">
            Needs attention
          </span>
          <ItemPrice item={item} />
        </div>
        {item.reason && <p className="cart-result__reason">{item.reason}</p>}
        <div className="cart-result__item-actions">
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
      </div>
    </li>
  );
}

function BackToRecipesLink() {
  return (
    <Link to="/" className="cart-result__back">
      Back to recipes
    </Link>
  );
}
