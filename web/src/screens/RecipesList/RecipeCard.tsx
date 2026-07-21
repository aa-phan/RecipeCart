import { useState } from "react";
import { Link } from "react-router-dom";
import type { RecipeListItemDto } from "../../api/types";
import StageLine from "../../components/StageLine";
import ProgressBar from "../../components/ProgressBar";
import { stageProgress } from "../../lib/stageLines";
import { apiDelete, ApiError } from "../../api/client";

export interface RecipeCardProps {
  item: RecipeListItemDto;
  onDeleted?: (id: string) => void;
}

/** One recipe row in the list — the whole card is a link to the Review screen. */
export default function RecipeCard({ item, onDeleted }: RecipeCardProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = item.title?.trim() ? item.title : "Untitled recipe (still extracting…)";
  const progress = stageProgress(item.status);

  const handleDelete = async () => {
    const confirmed = window.confirm(
      title
        ? `Delete "${title}"? This can't be undone.`
        : "Delete this recipe? This can't be undone.",
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/api/recipes/${item.id}`);
      onDeleted?.(item.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete recipe");
      setDeleting(false);
    }
  };

  return (
    <li className="recipe-card">
      <Link to={`/recipes/${item.id}`} className="recipe-card__link">
        <span className="recipe-card__title">{title}</span>
        {progress !== null && progress < 1 && (
          <ProgressBar progress={progress} className="recipe-card__progress-bar" />
        )}
        <StageLine status={item.status} className="recipe-card__stage" />
      </Link>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="recipe-card__delete"
        aria-label={`Delete ${title}`}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
      {error && (
        <p className="recipe-card__error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
