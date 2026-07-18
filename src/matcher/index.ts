// Ingredient -> Kroger product matcher (Spec 3 §2.2). Entry point is
// `matchRecipe(ingredients, locationId)`, decoupled from DB timing per the
// spec's own recommendation — it takes `Ingredient[]` objects directly.
// `matchRecipeAndPersist` is a thin optional wrapper for callers that do
// want the `product_matches` table populated from an already-persisted
// recipe's ingredient rows.
import { randomUUID } from "node:crypto";
import type { Ingredient } from "../pipeline/schema.js";
import { getAppToken } from "../kroger/auth.js";
import { searchProducts } from "../kroger/client.js";
import { getDb } from "../platform/db.js";
import { logger } from "../platform/logger.js";
import {
  computeUnitPrice,
  packageSizeMagnitude,
  quantityFitScore,
  textRelevanceScore,
} from "./rank.js";
import { isSeasoning } from "./seasonings.js";
import type { IngredientMatch, ProductCandidate } from "./types.js";

export type { IngredientMatch, ProductCandidate } from "./types.js";

// Candidates whose rankScore is within this margin of the top candidate are
// considered genuinely ambiguous (P1 stand-in for Claude-delegated
// disambiguation, deferred to P2 — see module doc below).
const AMBIGUITY_MARGIN = 1.5;
// Max candidates surfaced per ingredient (display + storage cleanliness).
const MAX_CANDIDATES = 5;
// Kroger search result page size to scan for candidates per ingredient.
const SEARCH_LIMIT = 10;

function compareCandidates(a: ProductCandidate, b: ProductCandidate): number {
  const diff = b.rankScore - a.rankScore;
  if (Math.abs(diff) > 0.01) return diff;
  if (a.unitPrice != null && b.unitPrice != null) return a.unitPrice - b.unitPrice;
  return diff;
}

/** No-stated-quantity default ordering (Spec 3 §2.2 step 3a): smallest
 * package first, cheapest price as the tiebreak — an arbitrary but
 * deterministic choice, not a quality judgment (an "organic" or other
 * preference-based tiebreak is a natural P3 extension once Spec 1
 * preferences exist to drive it). */
function compareBySmallestPackage(a: ProductCandidate, b: ProductCandidate): number {
  const diff = packageSizeMagnitude(a.size) - packageSizeMagnitude(b.size);
  if (diff !== 0) return diff;
  if (a.price != null && b.price != null) return a.price - b.price;
  return 0;
}

/** Matches a single ingredient against the Kroger catalog and ranks
 * candidates. Exported separately from matchRecipe so callers with their
 * own ingredient ids (e.g. DB rows) can call it directly. */
export async function matchIngredient(
  ingredient: Ingredient,
  ingredientId: string,
  locationId: string,
  appToken: string,
): Promise<IngredientMatch> {
  // canonical_name_en.value can be null when extraction couldn't confidently
  // name the ingredient (Spec 2 §evidencedField) — fall back to raw_text
  // rather than skipping the ingredient, and flag it for review below.
  const canonicalName = ingredient.canonical_name_en.value ?? ingredient.raw_text;
  const nameUncertain = ingredient.canonical_name_en.value === null;
  const hasQuantity = ingredient.quantity.value !== null && ingredient.quantity.value > 0;
  // Spec 3 §2.2 step 3a: an ingredient defaults to smallest-package-first
  // (skip quantity-fit scoring and the ambiguity-margin check entirely,
  // cheapest price as the tiebreak) when EITHER there's no stated amount to
  // score (vague quantity, e.g. "a pinch", or genuinely never given — no
  // signal to work with) OR it's a known small-quantity seasoning
  // (seasonings.ts) — a stated "3 tsp of salt" is real, but no reasonable
  // recipe amount of salt ever changes which shaker to buy, so scoring it
  // against package size is a distinction without a purchasing difference.
  // Quantity-fit scoring (with cross-category density conversion,
  // density.ts) is reserved for "core" bulk ingredients — meats, produce,
  // flour, sugar, oil, dairy — where portion size is a real decision (2 lb
  // of chicken vs 5 lb).
  const useSmallestPackageDefault = !hasQuantity || isSeasoning(canonicalName);

  if (!canonicalName || canonicalName.trim().length === 0) {
    return {
      ingredientId,
      canonicalName: ingredient.raw_text,
      candidates: [],
      requiresApproval: true,
      approvalReason: "no ingredient name available to search on",
      deprioritized: ingredient.is_pantry_staple,
    };
  }

  let candidates: ProductCandidate[] = [];
  try {
    const response = await searchProducts(canonicalName, locationId, appToken, SEARCH_LIMIT);
    for (const product of response.data) {
      const textScore = textRelevanceScore(canonicalName, product.description);
      if (textScore === null) continue; // no meaningful overlap — excluded, not just penalized

      for (const item of product.items) {
        if (item.inventory?.stockLevel === "TEMPORARILY_OUT_OF_STOCK") continue;

        const qFit = useSmallestPackageDefault
          ? null
          : quantityFitScore(ingredient.quantity, item.size, canonicalName);
        const price = item.price?.regular ?? null;
        const unitPrice = price != null ? computeUnitPrice(price, item.size) : undefined;
        const rankScore = textScore * 10 + (qFit ? qFit.score * 3 : 0);

        candidates.push({
          productId: product.productId,
          upc: product.upc,
          name: product.description,
          brand: product.brand,
          price,
          size: item.size,
          unitPrice,
          rankScore,
          reason: qFit?.note,
        });
      }
    }
  } catch (err) {
    logger.error("kroger product search failed", {
      ingredientId,
      canonicalName,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ingredientId,
      canonicalName,
      candidates: [],
      requiresApproval: true,
      approvalReason: `product search failed: ${err instanceof Error ? err.message : String(err)}`,
      deprioritized: ingredient.is_pantry_staple,
    };
  }

  candidates.sort(useSmallestPackageDefault ? compareBySmallestPackage : compareCandidates);
  candidates = candidates.slice(0, MAX_CANDIDATES);

  let requiresApproval = false;
  let approvalReason: string | undefined;

  if (candidates.length === 0) {
    requiresApproval = true;
    approvalReason = "no in-stock candidates found a relevant text match for this ingredient";
  } else if (useSmallestPackageDefault) {
    // Deterministic by construction (smallest package, cheapest tiebreak) —
    // never flagged as ambiguous just because there was nothing to score.
    candidates[0]!.reason = hasQuantity
      ? "small seasoning amount — smallest package selected regardless of stated quantity"
      : "no quantity stated — smallest package selected";
  } else if (candidates.length >= 2) {
    const [top, second] = candidates;
    if (top!.rankScore - second!.rankScore < AMBIGUITY_MARGIN) {
      requiresApproval = true;
      approvalReason = "top candidates are closely matched; no single clearly-best product";
    }
  }

  if (nameUncertain) {
    requiresApproval = true;
    const note = "ingredient name uncertain from extraction (matched on raw text)";
    approvalReason = approvalReason ? `${approvalReason}; ${note}` : note;
  }

  return {
    ingredientId,
    canonicalName,
    candidates,
    requiresApproval,
    approvalReason,
    deprioritized: ingredient.is_pantry_staple,
  };
}

/** Main entry point (Spec 3 §2.2). Matches every ingredient in a recipe
 * against the Kroger catalog for the given store. Gets one app-level token
 * up front and reuses it across all ingredients in the run (tokens last 30
 * min, comfortably longer than a single recipe's worth of calls). Runs
 * sequentially — deliberately, to stay a polite, predictable citizen of
 * Kroger's documented rate limits rather than bursting requests. */
export async function matchRecipe(
  ingredients: Ingredient[],
  locationId: string,
): Promise<IngredientMatch[]> {
  const token = await getAppToken();
  const results: IngredientMatch[] = [];
  for (let i = 0; i < ingredients.length; i++) {
    const ingredient = ingredients[i]!;
    const ingredientId = `ing-${i}`;
    results.push(await matchIngredient(ingredient, ingredientId, locationId, token.access_token));
  }
  return results;
}

interface IngredientRow {
  id: string;
  canonical_name: string | null;
  quantity_value: number | null;
  quantity_unit: string | null;
  raw_text: string | null;
  is_pantry_staple: number;
}

function ingredientFromDbRow(row: IngredientRow): Ingredient {
  const rawText = row.raw_text ?? "";
  return {
    canonical_name_en: row.canonical_name
      ? { value: row.canonical_name, evidence: [] }
      : { value: null, null_reason: "not populated on ingredients row" },
    raw_text: rawText,
    quantity: { value: row.quantity_value, unit: row.quantity_unit, raw_text: rawText },
    is_pantry_staple: row.is_pantry_staple === 1,
  } as Ingredient;
}

/** Optional persistence wrapper: reads a recipe's already-persisted
 * ingredient rows, matches them, and upserts results into `product_matches`.
 * NOTE (db.ts gap): `product_matches.ingredient_id` has an index but no
 * UNIQUE constraint, so this does a manual select-then-update/insert instead
 * of relying on `ON CONFLICT` — see final report for the suggested schema
 * follow-up. */
export async function matchRecipeAndPersist(
  recipeId: string,
  locationId: string,
): Promise<IngredientMatch[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, canonical_name, quantity_value, quantity_unit, raw_text, is_pantry_staple
       FROM ingredients WHERE recipe_id = ?`,
    )
    .all(recipeId) as unknown as IngredientRow[];

  const token = await getAppToken();
  const results: IngredientMatch[] = [];
  for (const row of rows) {
    const match = await matchIngredient(
      ingredientFromDbRow(row),
      row.id,
      locationId,
      token.access_token,
    );
    results.push(match);
    persistMatch(match);
  }
  return results;
}

function persistMatch(match: IngredientMatch): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare(`SELECT id FROM product_matches WHERE ingredient_id = ?`)
    .get(match.ingredientId) as unknown as { id: string } | undefined;

  const candidatesJson = JSON.stringify(match.candidates);
  if (existing) {
    db.prepare(
      `UPDATE product_matches
       SET candidates_json = ?, requires_approval = ?, approval_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      candidatesJson,
      match.requiresApproval ? 1 : 0,
      match.approvalReason ?? null,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO product_matches
         (id, ingredient_id, candidates_json, selected_product_id, requires_approval, approval_reason, is_approved, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)`,
    ).run(
      randomUUID(),
      match.ingredientId,
      candidatesJson,
      match.requiresApproval ? 1 : 0,
      match.approvalReason ?? null,
      now,
      now,
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Formats a readable terminal table: one row per ingredient, showing its
 * top candidate, price, and approval flag. Exported for the CLI to call
 * directly — not wired into cli.ts here. */
export function renderMatchesTable(matches: IngredientMatch[]): string {
  const columns = ["Ingredient", "Top Match", "Price", "Needs Approval", "Note"];
  const rows = matches.map((m) => {
    const top = m.candidates[0];
    const ingredientCol = truncate(m.canonicalName + (m.deprioritized ? " (pantry)" : ""), 28);
    const matchCol = top
      ? truncate(`${top.brand ? top.brand + " " : ""}${top.name}`, 36)
      : "(no match)";
    const priceCol = top?.price != null ? `$${top.price.toFixed(2)}` : "-";
    const approvalCol = m.requiresApproval ? "yes" : "no";
    const noteCol = truncate(m.approvalReason ?? top?.reason ?? "", 40);
    return [ingredientCol, matchCol, priceCol, approvalCol, noteCol];
  });

  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));

  const formatRow = (cells: string[]): string =>
    cells.map((c, i) => padRight(c, widths[i]!)).join("  ");

  const lines = [
    formatRow(columns),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(formatRow),
  ];
  return lines.join("\n");
}
