import { useState } from "react";
import type { MatchDto, ProductCandidate } from "../../api/types";
import { apiPatch } from "../../api/client";

export interface MatchPickerProps {
  recipeId: string;
  match: MatchDto;
  onChange: (updated: MatchDto) => void;
}

/**
 * Product-candidate dropdown for one ingredient's match (Phase 5 Slice 3
 * redesign — was a radio `<fieldset>`, now a collapsed summary + expandable
 * candidate list).
 *
 * Expand/collapse rule:
 *   - `requiresApproval === true` (a "material" substitution decision) →
 *     ALWAYS rendered expanded. Nothing is pre-selected; the shopper must
 *     actively pick or skip, so there's no useful "collapsed" state.
 *   - `requiresApproval === false` (a "safe" substitution) → the matcher's
 *     own top candidate is pre-selected server-side (`match.isApproved` +
 *     `match.selectedProductId`); this renders collapsed to that single
 *     pick with a "Change" toggle, since it needs no action.
 * `expanded` is derived from `match.requiresApproval` OR a local manual
 * toggle (not just local state) so that a later re-match — e.g. after an
 * amount edit — that newly flags this match auto-expands it even if the
 * user had previously collapsed it.
 */
export default function MatchPicker({ recipeId, match, onChange }: MatchPickerProps) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manualExpand, setManualExpand] = useState(false);
  const expanded = match.requiresApproval || manualExpand;

  const select = async (candidate: ProductCandidate | null) => {
    setPending(true);
    setErr(null);
    try {
      const updated = await apiPatch<MatchDto>(
        `/api/recipes/${recipeId}/matches/${match.ingredientId}`,
        { selectedProductId: candidate ? candidate.productId : null },
      );
      onChange(updated);
      if (!match.requiresApproval) setManualExpand(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't update this match.");
    } finally {
      setPending(false);
    }
  };

  const selected = match.selectedProductId
    ? match.candidates.find((c) => c.productId === match.selectedProductId)
    : undefined;

  if (!expanded) {
    return (
      <div className="match-picker match-picker--collapsed">
        {err && (
          <p role="alert" className="match-picker__error">
            {err}
          </p>
        )}
        <button
          type="button"
          className="match-picker__summary"
          onClick={() => setManualExpand(true)}
          disabled={pending}
        >
          {selected ? (
            <>
              <CandidateThumb candidate={selected} />
              <span className="match-picker__summary-body">
                <span className="match-picker__candidate-name">
                  {selected.brand ? `${selected.brand} ` : ""}
                  {selected.name}
                </span>
                <span className="match-picker__summary-meta">
                  {selected.size}
                  {selected.price !== null && ` · $${selected.price.toFixed(2)}`}
                  {selected.quantityToOrder > 1 && ` · x${selected.quantityToOrder}`}
                </span>
              </span>
            </>
          ) : (
            <span className="match-picker__summary-body">Skipped — choose a product</span>
          )}
          <span className="match-picker__change">Change ▾</span>
        </button>
      </div>
    );
  }

  return (
    <fieldset className="match-picker match-picker--expanded" disabled={pending}>
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
                <CandidateThumb candidate={candidate} />
                <span className="match-picker__candidate-body">
                  <span className="match-picker__candidate-name">
                    {candidate.brand ? `${candidate.brand} ` : ""}
                    {candidate.name}
                  </span>
                  <span className="match-picker__candidate-size">{candidate.size}</span>
                </span>
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
      {!match.requiresApproval && (
        <button type="button" className="match-picker__collapse" onClick={() => setManualExpand(false)}>
          Done
        </button>
      )}
    </fieldset>
  );
}

function CandidateThumb({ candidate }: { candidate: ProductCandidate }) {
  const [failed, setFailed] = useState(false);
  if (!candidate.imageUrl || failed) {
    return (
      <span className="match-picker__thumb match-picker__thumb--placeholder" aria-hidden="true" />
    );
  }
  return (
    <img
      className="match-picker__thumb"
      src={candidate.imageUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
