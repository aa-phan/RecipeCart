#!/usr/bin/env node
// recipecart CLI. Phase 3 splits the pipeline behind a Postgres job queue:
//
//   recipecart auth                -> kroger OAuth2 authorization-code flow
//   recipecart set-store <zip>     -> searchLocations() + save locationId
//   recipecart submit <tiktok-url> -> enqueue a job for the worker
//   recipecart worker              -> run the queue worker (Spec 4 §2.2)
//   recipecart approve <recipe-id> -> cart runner, prints itemized results
//   recipecart <tiktok-url>        -> [dev] run extract+match inline (no queue)
//
// The `submit` + `worker` path is the real Phase 3 flow (a URL becomes a job,
// the worker drives it to awaiting_review). The bare `<tiktok-url>` inline
// path is kept as a fast local dev convenience (esp. with --mock).
import crypto from "node:crypto";
import { Command } from "commander";
import { logger } from "./platform/logger.js";
import { config } from "./platform/config.js";
import { getDb, DEFAULT_USER_ID } from "./platform/database.js";
import { enqueueJob } from "./platform/jobs.js";
import * as krogerAuth from "./kroger/auth.js";
import * as krogerClient from "./kroger/client.js";
import { waitForCallback } from "./kroger/callback_server.js";
import { saveToken, loadToken, isExpiredOrMissing } from "./kroger/token_store.js";
import { saveStoreLocation, loadStoreLocation } from "./kroger/store_config.js";
import { runCartApproval, type ApprovedCartItem } from "./kroger/cart_runner.js";
import { extract } from "./pipeline/extract/index.js";
import { ExtractionError } from "./pipeline/extract/failures.js";
import { matchRecipeAndPersist, refreshIfStale, renderMatchesTable } from "./matcher/index.js";
import type { ProductCandidate } from "./matcher/types.js";

const program = new Command();

program
  .name("recipecart")
  .description("TikTok Recipe -> Kroger Cart Automation")
  .version("0.1.0");

program
  .command("auth")
  .description(
    "Kroger OAuth2 authorization: opens the consent URL, exchanges the code for a token pair",
  )
  .action(async () => {
    const existing = await loadToken();
    if (!isExpiredOrMissing(existing)) {
      console.log("Already connected to Kroger (token still valid). Re-authorizing anyway...");
    }

    const state = krogerAuth.randomState();
    const url = krogerAuth.buildAuthUrl(state);

    console.log("\nOpen this URL to connect your Kroger account:\n");
    console.log(`  ${url}\n`);
    console.log(`Waiting for the redirect to ${config.krogerRedirectUri} ...`);

    try {
      const { code, state: returnedState } = await waitForCallback();
      if (returnedState !== state) {
        logger.error("State mismatch on OAuth callback — possible CSRF, aborting");
        process.exitCode = 1;
        return;
      }

      const token = await krogerAuth.exchangeCode(code);
      await saveToken({
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? "",
        expiresAt: Date.now() + token.expires_in * 1000,
      });
      console.log("Connected to Kroger. Token saved.");
    } catch (err) {
      logger.error("Kroger authorization failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    }
  });

program
  .command("create-device-token")
  .description(
    "Mint a new device bearer token for the default user (Spec 4 §2.5) — prints the raw " +
      "token once; only its hash is stored",
  )
  .action(async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");

    await getDb()
      .updateTable("users")
      .set({ device_token_hash: hash })
      .where("id", "=", DEFAULT_USER_ID)
      .execute();

    console.log(
      "Device token (save this — it will not be shown again):\n\n  " +
        token +
        "\n\nUse it as a Bearer header or paste it into the web app's login screen.",
    );
  });

program
  .command("set-store")
  .argument("<zip-code>", "zip code to search for a nearby Kroger store")
  .description("Look up and save the target Kroger store location")
  .action(async (zipCode: string) => {
    try {
      const appToken = await krogerAuth.getAppToken();
      const results = await krogerClient.searchLocations(zipCode, appToken.access_token);

      if (results.data.length === 0) {
        console.log(`No Kroger stores found near ${zipCode}.`);
        process.exitCode = 1;
        return;
      }

      const store = results.data[0]!;
      saveStoreLocation({
        locationId: store.locationId,
        name: store.name,
        zipCode: store.address.zipCode,
      });
      console.log(
        `Store set: ${store.name} (${store.address.addressLine1}, ${store.address.city}, ${store.address.state})`,
      );
    } catch (err) {
      logger.error("Store lookup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    }
  });

program
  .command("submit")
  .argument("<tiktok-url>", "a TikTok recipe URL to enqueue for processing")
  .description("Enqueue a TikTok recipe URL as a job for the worker to process")
  .action(async (tiktokUrl: string) => {
    try {
      const { job, created } = await enqueueJob(tiktokUrl);
      if (created) {
        console.log(`Submitted. Job ${job.id} queued (status: ${job.status}).`);
      } else {
        console.log(
          `Duplicate submit within the dedupe window — returning existing job ${job.id} ` +
            `(status: ${job.status}).`,
        );
      }
      console.log("Start the worker to process it:  recipecart worker   (or: npm run worker)");
    } catch (err) {
      logger.error("Submit failed", {
        tiktokUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    }
  });

program
  .command("worker")
  .description("Run the job-queue worker (polls Postgres, processes one job at a time)")
  .action(async () => {
    // The worker module self-starts its poll loop on import and manages its own
    // lifecycle/shutdown, so this just hands off to it.
    await import("./worker/index.js");
  });

/** P3 foundation slice still has no review-UI edit UX (that lands with the
 * REST API + web slice). Until then, `approve` treats every non-ambiguous
 * match's top-ranked candidate as approved and skips anything the matcher
 * flagged requires_approval — those need human disambiguation before this can
 * honestly call them approved, so they're reported, not guessed. Quantity is
 * the matcher's purchase-quantity math (`candidate.quantityToOrder`), default
 * 1 for older rows predating the field. The rest of the ranked list rides
 * along as `fallbacks` so cart_runner can try the next-best pick if Kroger
 * rejects the top one at add time. */
async function selectApprovedItems(recipeId: string): Promise<{
  approved: ApprovedCartItem[];
  skipped: { name: string; reason: string }[];
}> {
  const rows = await getDb()
    .selectFrom("product_matches as pm")
    .innerJoin("ingredients as i", "i.id", "pm.ingredient_id")
    .select([
      "pm.ingredient_id",
      "i.canonical_name",
      "pm.candidates_json",
      "pm.requires_approval",
      "pm.approval_reason",
    ])
    .where("i.recipe_id", "=", recipeId)
    .execute();

  const approved: ApprovedCartItem[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const row of rows) {
    const name = row.canonical_name ?? row.ingredient_id;
    if (row.requires_approval) {
      skipped.push({ name, reason: row.approval_reason ?? "requires manual review" });
      continue;
    }
    // candidates_json is jsonb — already parsed on read.
    const candidates = row.candidates_json as ProductCandidate[];
    const top = candidates[0];
    if (!top) {
      skipped.push({ name, reason: "no candidates found" });
      continue;
    }
    const fallbacks = candidates
      .slice(1)
      .map((c) => ({ upc: c.upc, quantity: c.quantityToOrder ?? 1 }));
    approved.push({
      upc: top.upc,
      quantity: top.quantityToOrder ?? 1,
      ingredientId: row.ingredient_id,
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    });
  }

  return { approved, skipped };
}

program
  .command("approve")
  .argument("<recipe-id>", "recipe id to approve for cart add")
  .description("Add approved items to the real Kroger cart and print itemized results")
  .action(async (recipeId: string) => {
    try {
      // Staleness (Spec 3 §2.2, A3-6): re-run the Kroger search before using a
      // recipe's prices/availability if its matches are older than the config
      // window — a no-op in the common case. Skipped if no store is configured
      // (the existing, possibly-stale matches still work).
      const store = loadStoreLocation();
      if (store) {
        await refreshIfStale(recipeId, store.locationId);
      }

      const { approved, skipped } = await selectApprovedItems(recipeId);

      for (const item of skipped) {
        console.log(`Skipping "${item.name}" — ${item.reason}. Review it manually.`);
      }

      if (approved.length === 0) {
        console.log("Nothing auto-approvable to add — nothing was sent to the cart.");
        return;
      }

      // Deterministic per recipe so re-running `approve` is idempotent by
      // construction (Spec 3 §17) rather than by accident.
      const idempotencyKey = `cart-approve-${recipeId}`;
      const result = await runCartApproval(recipeId, approved, idempotencyKey);

      console.log(`\nCart result: ${result.status}`);
      for (const r of result.results) {
        console.log(
          `  ${r.status === "added" ? "✓" : "✗"} ${r.upc}${r.reason ? ` — ${r.reason}` : ""}`,
        );
      }
      console.log(result.summary);

      if (result.status === "failed" || result.status === "requires_user_intervention") {
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error("Cart approval failed", {
        recipeId,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    }
  });

program
  .argument("[tiktok-url]", "[dev] a TikTok recipe URL to extract and match inline (no queue)")
  .option(
    "--mock",
    "skip the real Claude call (mock_reconcile.ts heuristic instead) — for local dev/testing " +
      "the rest of the pipeline (real download, real local OCR/ASR, real Kroger calls) at zero " +
      "API cost. Recipe title is prefixed [MOCK] so mock runs are never mistaken for real ones.",
  )
  .action(async (tiktokUrl: string | undefined, cmdOptions: { mock?: boolean }) => {
    if (!tiktokUrl) {
      program.help();
      return;
    }

    const store = loadStoreLocation();
    if (!store) {
      console.error("No Kroger store configured — run `recipecart set-store <zip-code>` first.");
      process.exitCode = 1;
      return;
    }

    if (cmdOptions.mock) {
      console.log("--mock: skipping the real Claude call, using the local heuristic instead.\n");
    }

    try {
      const jobId = crypto.randomUUID();
      logger.info("extraction: starting", { tiktokUrl, jobId, mock: cmdOptions.mock ?? false });
      // extract() now persists the recipe AND its ingredient rows itself (the
      // matcher reads those rows) — the CLI no longer inserts ingredients.
      const { recipe, recipeId } = await extract(tiktokUrl, jobId, {
        mockReconcile: cmdOptions.mock,
      });

      if (recipe.result_type === "not_a_recipe") {
        console.log(`Not a recipe: ${recipe.not_a_recipe_reason ?? "no reason given"}`);
        return;
      }

      console.log(`Extracted: ${recipe.title?.value ?? "(untitled)"} — recipe id: ${recipeId}`);

      // --mock skips the materiality Claude call too, so a mock run makes no
      // Anthropic calls at all (parallels the reconcile mock above).
      const matches = await matchRecipeAndPersist(recipeId, store.locationId, {
        skipMateriality: cmdOptions.mock,
      });
      console.log("\n" + renderMatchesTable(matches));
      console.log(`\nRun \`recipecart approve ${recipeId}\` to add approved items to your cart.`);
    } catch (err) {
      // A classified extraction failure (Spec 2 §3) renders as a specific
      // failure card rather than a generic stack-trace log.
      if (err instanceof ExtractionError) {
        console.error(`\nExtraction failed [${err.failureClass}]: ${err.userFacingReason}`);
        process.exitCode = 1;
        return;
      }
      logger.error("Extraction/matching failed", {
        tiktokUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
