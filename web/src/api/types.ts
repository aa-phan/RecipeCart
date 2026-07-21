// Type-only re-export barrel from the backend's frozen DTO contract
// (src/api/lib/dto.ts, repo-relative). This is intentional: web and API share
// exactly one source of truth for these shapes, so there is zero drift
// between what the server sends and what the client expects. Never redefine
// these types locally — if a shape is missing here, add it to dto.ts instead.
export type {
  RecipeListItemDto,
  RecipeDetailDto,
  IngredientDto,
  MatchDto,
  CartResultDto,
  SubmitRecipeRequest,
  SubmitRecipeResponse,
  IngredientEditRequest,
  IngredientEditResponseDto,
  MatchEditRequest,
  PreferencesDto,
  EvidenceRef,
  ProductCandidate,
  CartItemResult,
  CartRunStatus,
  DeviceDto,
} from "../../../src/api/lib/dto.js";
