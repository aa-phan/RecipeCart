// Matcher output types (Spec 3 §2.2, §3 "Out" contract).
// Kept close to the PRD's candidate-record shape: each ingredient maps to a
// ranked list of Kroger product candidates, plus a display/approval hint.

export interface ProductCandidate {
  productId: string;
  upc: string;
  name: string; // Kroger product description
  brand?: string;
  price: number | null; // item.price.regular, null when Kroger didn't return pricing
  size: string; // raw Kroger size string, e.g. "24 bottles / 16.9 fl oz"
  unitPrice?: number; // price per base unit (gram/ml/count) when size was parseable
  rankScore: number; // deterministic P1 score — see rank.ts
  reason?: string; // short human-readable note on quantity fit, when available
}

export interface IngredientMatch {
  ingredientId: string;
  canonicalName: string;
  candidates: ProductCandidate[];
  requiresApproval: boolean;
  approvalReason?: string;
  deprioritized: boolean; // pantry staple — display default, not a matching shortcut
}
