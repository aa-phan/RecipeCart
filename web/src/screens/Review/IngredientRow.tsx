import { useState } from "react";
import type { IngredientDto, IngredientEditRequest } from "../../api/types";
import { apiPatch } from "../../api/client";
import ConfidenceBadge from "../../components/ConfidenceBadge";
import EvidenceSnippet from "./EvidenceSnippet";

export interface IngredientRowProps {
  recipeId: string;
  ingredient: IngredientDto;
  onChange: (updated: IngredientDto) => void;
  onRemove: (ingredientId: string) => void;
}

/** One editable ingredient line (Spec 1 / plan's W2 bullet):
 *  - canonical name, inline-editable quantity/unit
 *  - "remove" action (PATCH { remove: true })
 *  - pantry-staple chip, visible but non-blocking
 *  - "amount unclear" badge, distinct from the low-confidence badge, shown
 *    whenever quantityValue is null
 *  - a "why?" affordance that expands the evidence trail
 */
export default function IngredientRow({
  recipeId,
  ingredient,
  onChange,
  onRemove,
}: IngredientRowProps) {
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
      const updated = await apiPatch<IngredientDto>(
        `/api/recipes/${recipeId}/ingredients/${ingredient.id}`,
        edit,
      );
      onChange(updated);
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
      onRemove(ingredient.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove this ingredient.");
      setBusy(false);
    }
  };

  const quantityLabelId = `qty-label-${ingredient.id}`;
  const unitLabelId = `unit-label-${ingredient.id}`;

  return (
    <li className="ingredient-row">
      <div className="ingredient-row__main">
        <span className="ingredient-row__name">{ingredient.canonicalName}</span>

        <span className="ingredient-row__quantity">
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
            className="ingredient-row__quantity-input"
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
            className="ingredient-row__unit-input"
            placeholder="unit"
          />
        </span>

        {ingredient.quantityValue === null && <ConfidenceBadge level="amount_unclear" />}

        {ingredient.isPantryStaple && (
          <span className="ingredient-row__pantry-chip" title="Likely already in your pantry">
            Pantry staple
          </span>
        )}

        <button
          type="button"
          className="ingredient-row__why"
          onClick={() => setShowEvidence((v) => !v)}
          aria-expanded={showEvidence}
        >
          {showEvidence ? "Hide why" : "Why?"}
        </button>

        <button
          type="button"
          className="ingredient-row__remove"
          onClick={handleRemove}
          disabled={busy}
        >
          Remove
        </button>
      </div>

      {ingredient.rawText && (
        <p className="ingredient-row__raw-text">Original text: &ldquo;{ingredient.rawText}&rdquo;</p>
      )}

      {showEvidence && <EvidenceSnippet evidence={ingredient.evidence} />}

      {error && (
        <p role="alert" className="ingredient-row__error">
          {error}
        </p>
      )}
    </li>
  );
}
