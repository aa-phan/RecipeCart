import { Link } from "react-router-dom";
import type { RecipeListItemDto } from "../../api/types";
import StageLine from "../../components/StageLine";

export interface RecipeCardProps {
  item: RecipeListItemDto;
}

/** One recipe row in the list — the whole card is a link to the Review screen. */
export default function RecipeCard({ item }: RecipeCardProps) {
  const title = item.title?.trim() ? item.title : "Untitled recipe (still extracting…)";

  return (
    <li className="recipe-card">
      <Link to={`/recipes/${item.id}`} className="recipe-card__link">
        <span className="recipe-card__title">{title}</span>
        <StageLine status={item.status} className="recipe-card__stage" />
      </Link>
    </li>
  );
}
