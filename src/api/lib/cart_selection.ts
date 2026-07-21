// Builds the approved cart item list for a recipe from the user's actual
// review-screen edits (`product_matches.is_approved` / `selected_product_id`)
// — NOT the CLI's `selectApprovedItems` top-candidate auto-pick heuristic
// (src/cli.ts), which this deliberately does not reuse as behavior (only the
// fallback-list shape is copied verbatim, see below). This is the one real
// coupling between the matches-edit route (B1) and the cart route (B2), so it
// lives here as a shared foundation module rather than an implicit
// dependency between the two.
import { getDb } from "../../platform/database.js";
import type { ApprovedCartItem } from "../../kroger/cart_runner.js";
import type { ProductCandidate } from "../../matcher/types.js";

/** Reads approved product_matches for `recipeId` and builds the cart items to
 * submit. A match counts as approved when `is_approved = true` AND
 * `selected_product_id` is non-null; rows that are `is_approved = false` or
 * have a null `selected_product_id` (the "skip" convention) are omitted. */
export async function buildApprovedItems(recipeId: string): Promise<ApprovedCartItem[]> {
  const rows = await getDb()
    .selectFrom("product_matches as pm")
    .innerJoin("ingredients as i", "i.id", "pm.ingredient_id")
    .select(["pm.ingredient_id", "pm.candidates_json", "pm.is_approved", "pm.selected_product_id"])
    .where("i.recipe_id", "=", recipeId)
    .execute();

  const approved: ApprovedCartItem[] = [];

  for (const row of rows) {
    if (!row.is_approved || !row.selected_product_id) continue;

    // candidates_json is jsonb — already parsed on read.
    const candidates = row.candidates_json as ProductCandidate[];
    const selected = candidates.find((c) => c.productId === row.selected_product_id);
    if (!selected) continue; // stale/invalid selection — skip rather than throw

    // Fallback list mirrors the CLI's selectApprovedItems logic verbatim:
    // remaining candidates, in ranked order, tried only if Kroger's
    // addToCart rejects the primary pick. Each fallback carries its own
    // display fields too — whichever one actually gets added is what the
    // cart result screen should show, not the (rejected) top pick's data.
    const fallbacks = candidates
      .filter((c) => c.productId !== selected.productId)
      .map((c) => ({
        upc: c.upc,
        quantity: c.quantityToOrder ?? 1,
        productName: c.name,
        imageUrl: c.imageUrl,
        price: c.price,
        reason: c.reason,
      }));

    approved.push({
      upc: selected.upc,
      quantity: selected.quantityToOrder ?? 1,
      ingredientId: row.ingredient_id,
      productName: selected.name,
      imageUrl: selected.imageUrl,
      price: selected.price,
      reason: selected.reason,
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    });
  }

  return approved;
}
