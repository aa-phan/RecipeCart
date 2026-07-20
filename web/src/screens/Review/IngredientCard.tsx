import { useState } from "react";
import type {
  IngredientDto,
  IngredientEditRequest,
  IngredientEditResponseDto,
  MatchDto,
} from "../../api/types";
import { apiPatch } from "../../api/client";
import ConfidenceBadge from "../../components/ConfidenceBadge";
import EvidenceSnippet from "./EvidenceSnippet";
import MatchPicker from "./MatchPicker";

export interface IngredientCardProps {
  recipeId: string;
  ingredient: IngredientDto;
  match: MatchDto | undefined;
  onIngredientChange: (updated: IngredientDto) => void;
  onIngredientRemove: (ingredientId: string) => void;
  onMatchChange: (updated: MatchDto) => void;
}

/**
 * One unified ingredient card (Phase 5 Slice 3 redesign — replaces the old
 * split "ingredient list" + "product picker" sections with a single card:
 * name, editable amount, and the product dropdown together). Amount edits
 * that change quantity/unit re-drive matching server-side
 * (`editIngredient`, `src/api/services/recipe_edits.ts`); when the PATCH
 * response carries a fresh `match`, it's forwarded via `onMatchChange` so
 * the card's own `MatchPicker` updates in the same render pass — no full
 * recipe reload needed.
 */
export default function IngredientCard({
  recipeId,
  ingredient,
  match,
  onIngredientChange,
  onIngredientRemove,
  onMatchChange,
}: IngredientCardProps) {
  const [quantityValue, setQuantityValue] = useState(
    ingredient.quantityValue === null ? "" : String(ingredient.quantityValue),
  );
  const [quantityUnit, setQuantityUnit] = useState(ingredient.quantityUnit ?? "");
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitEdit = async (edit: IngredientEditRequest) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await apiPatch<IngredientEditResponseDto>(
        `/api/recipes/${recipeId}/ingredients/${ingredient.id}`,
        edit,
      );
      const { match: freshMatch, ...ingredientFields } = updated;
      onIngredientChange(ingredientFields);
      if (freshMatch) onMatchChange(freshMatch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that change.");
    } finally {
      setBusy(false);
    }
  };

  const handleQuantityBlur = () => {
    const trimmed = quantityValue.trim();
    const numeric = trimmed === "" ? null : Number(trimmed);
    const nextValue = numeric === null || Number.isNaN(numeric) ? null : numeric;
    if (nextValue === ingredient.quantityValue) return;
    submitEdit({ quantityValue: nextValue });
  };

  const handleUnitBlur = () => {
    const trimmed = quantityUnit.trim();
    const nextUnit = trimmed === "" ? null : trimmed;
    if (nextUnit === ingredient.quantityUnit) return;
    submitEdit({ quantityUnit: nextUnit });
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/recipes/${recipeId}/ingredients/${ingredient.id}`, { remove: true });
      onIngredientRemove(ingredient.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove this ingredient.");
      setBusy(false);
    }
  };

  const quantityLabelId = `qty-label-${ingredient.id}`;
  const unitLabelId = `unit-label-${ingredient.id}`;
  const needsAttention = match?.requiresApproval ?? false;

  return (
    <li className={`ingredient-card${needsAttention ? " ingredient-card--needs-attention" : ""}`}>
      <div className="ingredient-card__main">
        <span className="ingredient-card__name">{ingredient.canonicalName}</span>

        <span className="ingredient-card__quantity">
          <label id={quantityLabelId} htmlFor={`qty-${ingredient.id}`} className="visually-hidden">
            Quantity for {ingredient.canonicalName}
          </label>
          <input
            id={`qty-${ingredient.id}`}
            type="number"
            inputMode="decimal"
            value={quantityValue}
            disabled={busy}
            onChange={(e) => setQuantityValue(e.target.value)}
            onBlur={handleQuantityBlur}
            aria-labelledby={quantityLabelId}
            className="ingredient-card__quantity-input"
          />
          <label id={unitLabelId} htmlFor={`unit-${ingredient.id}`} className="visually-hidden">
            Unit for {ingredient.canonicalName}
          </label>
          <input
            id={`unit-${ingredient.id}`}
            type="text"
            value={quantityUnit}
            disabled={busy}
            onChange={(e) => setQuantityUnit(e.target.value)}
            onBlur={handleUnitBlur}
            aria-labelledby={unitLabelId}
            className="ingredient-card__unit-input"
            placeholder="unit"
          />
        </span>

        {ingredient.quantityValue === null && <ConfidenceBadge level="amount_unclear" />}

        {ingredient.isPantryStaple && (
          <span className="ingredient-card__pantry-chip" title="Likely already in your pantry">
            Pantry staple
          </span>
        )}

        <button
          type="button"
          className="ingredient-card__why"
          onClick={() => setShowEvidence((v) => !v)}
          aria-expanded={showEvidence}
        >
          {showEvidence ? "Hide why" : "Why?"}
        </button>

        <button
          type="button"
          className="ingredient-card__remove"
          onClick={handleRemove}
          disabled={busy}
        >
          Remove
        </button>
      </div>

      {ingredient.rawText && (
        <p className="ingredient-card__raw-text">Original text: &ldquo;{ingredient.rawText}&rdquo;</p>
      )}

      {showEvidence && <EvidenceSnippet evidence={ingredient.evidence} />}

      {error && (
        <p role="alert" className="ingredient-card__error">
          {error}
        </p>
      )}

      <div className="ingredient-card__product">
        {match && match.candidates.length > 0 ? (
          <MatchPicker recipeId={recipeId} match={match} onChange={onMatchChange} />
        ) : (
          <p className="ingredient-card__no-match">
            No product match found for this ingredient — it will be skipped when you approve the
            cart.
          </p>
        )}
      </div>
    </li>
  );
}
