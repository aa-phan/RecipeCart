// Ingredient confidence column (PRD C1 §21 gap fix). Claude's extraction
// already produces a per-field confidence band (high/medium/low —
// ConfidenceBandSchema, pipeline/schema.ts) on `canonical_name_en`, but it
// was discarded before persistence: the `ingredients` table had nowhere to
// put it. Nullable text (not an enum type) storing one of "high"/"medium"/
// "low", matching ConfidenceBandSchema — nullable because pre-Phase-2
// recipes and manually-added ingredients (recipe_edits.ts's addIngredient)
// have no confidence to report.
import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("ingredients").addColumn("confidence", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("ingredients").dropColumn("confidence").execute();
}
