// Recipes route plugin (Phase 3, B1 slice — Spec 4 §2.5). Registered with
// prefix `/api/recipes` in server.ts, so every path below is relative to
// that prefix (e.g. `GET /` is `GET /api/recipes`).
//
// Design note (per the Phase 3 plan): a job's id and its eventual recipe's
// id are the SAME value by construction — src/worker/state_machine.ts calls
// `extract(job.source_url, jobId, ...)`, so `recipeId === jobId` always.
// This lets the externally-visible "recipe id" stay stable across the whole
// lifecycle (submitted → extracting → awaiting_review → ...), even before a
// `recipes` row exists yet. All routes here therefore key off `jobs.id`.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDb } from "../../platform/database.js";
import { enqueueJob } from "../../platform/jobs.js";
import { notFound, badRequest } from "../lib/errors.js";
import type {
  RecipeListItemDto,
  RecipeDetailDto,
  IngredientDto,
  SubmitRecipeRequest,
  SubmitRecipeResponse,
  IngredientEditRequest,
  MatchEditRequest,
} from "../lib/dto.js";
import type { EvidenceRef } from "../../pipeline/schema.js";
import { editIngredient, addIngredient } from "../services/recipe_edits.js";
import { updateMatchSelection, toMatchDto } from "../services/match_edits.js";

function toIngredientDto(row: {
  id: string;
  canonical_name: string;
  quantity_value: number | null;
  quantity_unit: string | null;
  raw_text: string | null;
  is_pantry_staple: boolean;
  evidence_json: unknown[];
}): IngredientDto {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    quantityValue: row.quantity_value,
    quantityUnit: row.quantity_unit,
    rawText: row.raw_text,
    isPantryStaple: row.is_pantry_staple,
    evidence: row.evidence_json as EvidenceRef[],
  };
}

export default async function recipesRoutes(app: FastifyInstance): Promise<void> {
  // POST / — submit a new recipe source URL for processing.
  app.post("/", async (request, reply) => {
    const body = request.body as Partial<SubmitRecipeRequest> | undefined;
    const sourceUrl = body?.sourceUrl;
    if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
      throw badRequest("sourceUrl is required and must be a non-empty string.");
    }

    const { job, created } = await enqueueJob(sourceUrl, request.userId);
    const response: SubmitRecipeResponse = {
      jobId: job.id,
      status: job.status,
      created,
    };
    reply.status(created ? 201 : 200);
    return response;
  });

  // GET / — list all submitted recipes/jobs, most recent first.
  app.get("/", async () => {
    const db = getDb();
    const jobs = await db
      .selectFrom("jobs")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();

    const recipeIds = jobs.map((j) => j.recipe_id).filter((id): id is string => id !== null);
    const recipes =
      recipeIds.length > 0
        ? await db.selectFrom("recipes").selectAll().where("id", "in", recipeIds).execute()
        : [];
    const recipesById = new Map(recipes.map((r) => [r.id, r]));

    const items: RecipeListItemDto[] = jobs.map((job) => {
      const recipe = job.recipe_id ? recipesById.get(job.recipe_id) : undefined;
      return {
        id: job.id,
        title: recipe?.title ?? null,
        status: job.status,
        stage: job.stage,
        createdAt: job.created_at.toISOString(),
        // Frontend owns the plain-language stage mapping (StageLine
        // component) — this raw `stage` value is what it keys off.
        stageLine: job.stage,
      };
    });
    return items;
  });

  // GET /:id — full detail for one recipe (keyed by job id, see module note).
  app.get("/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    const db = getDb();

    const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!job) throw notFound("recipe");

    const recipe = job.recipe_id
      ? await db.selectFrom("recipes").selectAll().where("id", "=", job.recipe_id).executeTakeFirst()
      : undefined;

    const ingredientRows = job.recipe_id
      ? await db
          .selectFrom("ingredients")
          .selectAll()
          .where("recipe_id", "=", job.recipe_id)
          .orderBy("created_at", "asc")
          .execute()
      : [];

    const matchRows = job.recipe_id
      ? await db
          .selectFrom("product_matches as pm")
          .innerJoin("ingredients as i", "i.id", "pm.ingredient_id")
          .select([
            "pm.ingredient_id",
            "pm.candidates_json",
            "pm.requires_approval",
            "pm.approval_reason",
            "pm.is_approved",
            "pm.selected_product_id",
          ])
          .where("i.recipe_id", "=", job.recipe_id)
          .execute()
      : [];

    const detail: RecipeDetailDto = {
      id: job.id,
      title: recipe?.title ?? null,
      status: job.status,
      stage: job.stage,
      createdAt: job.created_at.toISOString(),
      stageLine: job.stage,
      sourceUrl: job.source_url,
      ingredients: ingredientRows.map(toIngredientDto),
      matches: matchRows.map(toMatchDto),
      ...(recipe?.failure_class ? { failureClass: recipe.failure_class } : {}),
      ...(recipe?.failure_reason ? { failureReason: recipe.failure_reason } : {}),
    };
    return detail;
  });

  // DELETE /:id — delete the recipe (cascades to ingredients/product_matches
  // /cart_runs) and its job row.
  app.delete("/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = request.params;
    const db = getDb();

    const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!job) throw notFound("recipe");

    if (job.recipe_id) {
      await db.deleteFrom("recipes").where("id", "=", job.recipe_id).execute();
    }
    await db.deleteFrom("jobs").where("id", "=", id).execute();

    reply.status(204);
    return null;
  });

  // POST /:id/reprocess — re-enqueue the same source URL as a brand new job,
  // bypassing the normal submit-dedup window (Phase 3 plan ambiguity A6).
  app.post("/:id/reprocess", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = request.params;
    const db = getDb();

    const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!job) throw notFound("recipe");

    const { job: newJob, created } = await enqueueJob(job.source_url, request.userId, {
      bypassDedup: true,
    });
    const response: SubmitRecipeResponse = {
      jobId: newJob.id,
      status: newJob.status,
      created,
    };
    reply.status(201);
    return response;
  });

  // PATCH /:id/ingredients/:ingredientId — edit, mark-owned, or remove.
  app.patch(
    "/:id/ingredients/:ingredientId",
    async (
      request: FastifyRequest<{
        Params: { id: string; ingredientId: string };
        Body: IngredientEditRequest;
      }>,
      reply,
    ) => {
      const { ingredientId } = request.params;
      const edit = request.body ?? {};
      const result = await editIngredient(ingredientId, edit);
      if (result === null) {
        reply.status(204);
        return null;
      }
      return result;
    },
  );

  // POST /:id/ingredients — manually add an ingredient (inserted unmatched).
  app.post(
    "/:id/ingredients",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { canonicalName?: string; quantityValue?: number; quantityUnit?: string };
      }>,
      reply,
    ) => {
      const { id } = request.params;
      const db = getDb();

      const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
      if (!job) throw notFound("recipe");
      if (!job.recipe_id) throw badRequest("Recipe has no ingredients yet — still processing.");

      const body = request.body ?? {};
      const canonicalName = body.canonicalName;
      if (typeof canonicalName !== "string" || canonicalName.trim().length === 0) {
        throw badRequest("canonicalName is required and must be a non-empty string.");
      }

      const ingredient = await addIngredient(job.recipe_id, {
        canonicalName,
        quantityValue: body.quantityValue,
        quantityUnit: body.quantityUnit,
      });
      reply.status(201);
      return ingredient;
    },
  );

  // PATCH /:id/matches/:ingredientId — select or skip a product match.
  app.patch(
    "/:id/matches/:ingredientId",
    async (
      request: FastifyRequest<{
        Params: { id: string; ingredientId: string };
        Body: MatchEditRequest;
      }>,
    ) => {
      const { ingredientId } = request.params;
      const body = request.body ?? {};
      const selectedProductId =
        body.selectedProductId === undefined ? null : body.selectedProductId;
      return updateMatchSelection(ingredientId, selectedProductId);
    },
  );
}
