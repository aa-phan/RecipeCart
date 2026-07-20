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
  imageUrl?: string; // Kroger product thumbnail (front-image size), when available
  unitPrice?: number; // price per base unit (gram/ml/count) when size was parseable
  rankScore: number; // deterministic P1 score — see rank.ts
  reason?: string; // short human-readable note on quantity fit, when available
  // How many of this package to buy to cover the ingredient's needed
  // quantity (Spec 3 §2.2 step 3, "closest-over" generalized across N
  // units — rank.ts's QuantityFit.unitsNeeded). Defaults to 1 (single
  // package, or no quantity signal at all — seasonings/no-stated-quantity
  // ingredients always buy exactly 1).
  quantityToOrder: number;
}

export interface IngredientMatch {
  ingredientId: string;
  canonicalName: string;
  candidates: ProductCandidate[];
  requiresApproval: boolean;
  approvalReason?: string;
  deprioritized: boolean; // pantry staple — display default, not a matching shortcut
  // Set ONLY at the two materiality-governed substitution flag sites in
  // matchIngredient (a broadened-search pick, or a close-match ambiguity),
  // carrying the winning candidate's identity so the recipe-level
  // materiality pass (materiality.ts) can judge safe-vs-material without
  // string-parsing approvalReason. Deliberately NOT set for non-materiality
  // flags (name-uncertain, no candidates, quantity-not-covered) — those stay
  // flagged regardless of any Claude judgment. Also NOT set when the
  // ingredient name itself is uncertain from extraction (nameUncertain),
  // since that flag must survive independently of the substitution verdict.
  substitutionCase?: { name: string; brand: string | null; size: string | null };
}
