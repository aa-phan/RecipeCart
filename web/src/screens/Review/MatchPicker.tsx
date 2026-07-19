import { useState } from "react";
import type { MatchDto, ProductCandidate } from "../../api/types";
import { apiPatch } from "../../api/client";

export interface MatchPickerProps {
  recipeId: string;
  match: MatchDto;
  onChange: (updated: MatchDto) => void;
}

/**
 * Ranked product-candidate picker for one ingredient's match (Spec 1 /
 * plan's W2 bullet). Selection rule (using `requiresApproval` as the
 * material-vs-safe-substitution proxy, since MatchDto doesn't carry a
 * separate materiality flag):
 *   - requiresApproval === true  → a "material" substitution decision.
 *     Nothing is pre-checked; the shopper must actively pick or skip.
 *   - requiresApproval === false → a "safe" substitution. The matcher's own
 *     top candidate (`match.isApproved` + `match.selectedProductId`, as set
 *     by the backend) is shown pre-selected but still visible/changeable.
 * Pantry-staple ingredients are shown but pre-unchecked — that's handled by
 * the caller not pre-approving a pantry ingredient's match in the first
 * place, not by this component.
 */
export default function MatchPicker({ recipeId, match, onChange }: MatchPickerProps) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const select = async (candidate: ProductCandidate | null) => {
    setPending(true);
    setErr(null);
    try {
      const updated = await apiPatch<MatchDto>(
        `/api/recipes/${recipeId}/matches/${match.ingredientId}`,
        { selectedProductId: candidate ? candidate.productId : null },
      );
      onChange(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't update this match.");
    } finally {
      setPending(false);
    }
  };

  return (
    <fieldset className="match-picker" disabled={pending}>
      <legend>
        Choose a product
        {match.requiresApproval && (
          <span className="match-picker__approval-note"> — needs your decision</span>
        )}
      </legend>
      {match.approvalReason && <p className="match-picker__reason">{match.approvalReason}</p>}
      {err && (
        <p role="alert" className="match-picker__error">
          {err}
        </p>
      )}
      <ul className="match-picker__candidates">
        {match.candidates.map((candidate) => {
          const inputId = `match-${match.ingredientId}-${candidate.productId}`;
          const checked = match.isApproved && match.selectedProductId === candidate.productId;
          return (
            <li key={candidate.productId} className="match-picker__candidate">
              <input
                type="radio"
                id={inputId}
                name={`match-${match.ingredientId}`}
                checked={checked}
                onChange={() => select(candidate)}
              />
              <label htmlFor={inputId}>
                <span className="match-picker__candidate-name">
                  {candidate.brand ? `${candidate.brand} ` : ""}
                  {candidate.name}
                </span>
                <span className="match-picker__candidate-size">{candidate.size}</span>
                {candidate.price !== null && (
                  <span className="match-picker__candidate-price">
                    ${candidate.price.toFixed(2)}
                  </span>
                )}
                {candidate.quantityToOrder > 1 && (
                  <span className="match-picker__candidate-qty">
                    x{candidate.quantityToOrder}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="match-picker__skip">
        <input
          type="radio"
          id={`match-${match.ingredientId}-skip`}
          name={`match-${match.ingredientId}`}
          checked={!match.isApproved}
          onChange={() => select(null)}
        />
        <label htmlFor={`match-${match.ingredientId}-skip`}>Skip this ingredient</label>
      </div>
    </fieldset>
  );
}
