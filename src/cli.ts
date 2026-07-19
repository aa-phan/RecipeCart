#!/usr/bin/env node
// recipecart CLI — the Phase 1 driver (Spec 4: "no queue, no auth, no HTTP;
// Specs 2/3 modules invoked directly by the CLI").
//
// Commands land here incrementally as each pipeline piece is built:
//   recipecart auth                -> kroger_client OAuth2 authorization-code flow
//   recipecart set-store           -> kroger_client.searchLocations() + save locationId
//   recipecart <tiktok-url>        -> extract() + matcher, writes review file
//   recipecart approve <recipe-id> -> cart runner, prints itemized results
import crypto from "node:crypto";
import { Command } from "commander";
import { logger } from "./platform/logger.js";
import { config } from "./platform/config.js";
import { getDb } from "./platform/db.js";
import * as krogerAuth from "./kroger/auth.js";
import * as krogerClient from "./kroger/client.js";
import { waitForCallback } from "./kroger/callback_server.js";
import { saveToken, loadToken, isExpiredOrMissing } from "./kroger/token_store.js";
import { saveStoreLocation, loadStoreLocation } from "./kroger/store_config.js";
import { runCartApproval, type ApprovedCartItem } from "./kroger/cart_runner.js";
import { extract } from "./pipeline/extract/index.js";
import { ExtractionError } from "./pipeline/extract/failures.js";
import type { Recipe } from "./pipeline/schema.js";
import { matchRecipeAndPersist, refreshIfStale, renderMatchesTable } from "./matcher/index.js";
import type { ProductCandidate } from "./matcher/types.js";

const program = new Command();

program
  .name("recipecart")
  .description("TikTok Recipe -> Kroger Cart Automation (Phase 1 barebones pipeline)")
  .version("0.1.0");

program
  .command("auth")
  .description(
    "Kroger OAuth2 authorization: opens the consent URL, exchanges the code for a token pair",
  )
  .action(async () => {
    const existing = loadToken();
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
      saveToken({
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

interface ProductMatchRow {
  ingredient_id: string;
  canonical_name: string | null;
  candidates_json: string;
  requires_approval: number;
  approval_reason: string | null;
}

/** P1 has no review-file-editing UX yet (deferred per phases.md — "confidence
 * UX... anything not needed to complete one honest end-to-end run"). Until
 * that exists, `approve` treats every non-ambiguous match's top-ranked
 * candidate as approved, and skips anything the matcher flagged
 * requires_approval — those genuinely need human disambiguation before this
 * command can honestly call them approved, so they're reported, not guessed.
 * Quantity comes from the matcher's own purchase-quantity math
 * (`candidate.quantityToOrder` — Spec 3 §2.2 step 3, "closest-over"
 * generalized across multiple packages when one alone doesn't cover the
 * ingredient's needed amount), defaulting to 1 for older persisted matches
 * that predate the field. The rest of the ranked candidate list rides along
 * as `fallbacks` so cart_runner.ts can automatically try the next-best match
 * if Kroger actually rejects the top pick at add time (it can't help with a
 * silent accept-then-later-unavailable case — see cart_runner.ts's module
 * doc for why). */
function selectApprovedItems(recipeId: string): {
  approved: ApprovedCartItem[];
  skipped: { name: string; reason: string }[];
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pm.ingredient_id, i.canonical_name, pm.candidates_json, pm.requires_approval, pm.approval_reason
       FROM product_matches pm
       JOIN ingredients i ON i.id = pm.ingredient_id
       WHERE i.recipe_id = ?`,
    )
    .all(recipeId) as unknown as ProductMatchRow[];

  const approved: ApprovedCartItem[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const row of rows) {
    const name = row.canonical_name ?? row.ingredient_id;
    if (row.requires_approval) {
      skipped.push({ name, reason: row.approval_reason ?? "requires manual review" });
      continue;
    }
    const candidates = JSON.parse(row.candidates_json) as ProductCandidate[];
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
      // Staleness (Spec 3 §2.2, A3-6): re-run the Kroger search before using
      // a recipe's prices/availability if its matches are more than
      // config.kroger.searchStalenessWindowMs old — a no-op in the common
      // case (approve run promptly after extraction). Needs a store to
      // re-search against; if none is configured, skip the refresh rather
      // than block approval on a config problem approve doesn't otherwise
      // need to care about (the existing, possibly-stale matches still work).
      const store = loadStoreLocation();
      if (store) {
        await refreshIfStale(recipeId, store.locationId);
      }

      const { approved, skipped } = selectApprovedItems(recipeId);

      for (const item of skipped) {
        console.log(`Skipping "${item.name}" — ${item.reason}. Review it manually.`);
      }

      if (approved.length === 0) {
        console.log("Nothing auto-approvable to add — nothing was sent to the cart.");
        return;
      }

      // Deterministic per recipe so re-running `approve` on the same recipe
      // is idempotent by construction (Spec 3 §17) rather than by accident.
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

function ingredientsTableRows(recipeId: string, recipe: Recipe) {
  return recipe.ingredients.map((ing) => ({
    id: crypto.randomUUID(),
    recipe_id: recipeId,
    canonical_name: ing.canonical_name_en.value,
    quantity_value: ing.quantity.value,
    quantity_unit: ing.quantity.unit,
    raw_text: ing.raw_text,
    is_pantry_staple: ing.is_pantry_staple ? 1 : 0,
    evidence_json: JSON.stringify(ing.canonical_name_en.evidence ?? []),
  }));
}

program
  .argument("[tiktok-url]", "a TikTok recipe URL to extract and match")
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
      const { recipe, recipeId } = await extract(tiktokUrl, jobId, {
        mockReconcile: cmdOptions.mock,
      });

      if (recipe.result_type === "not_a_recipe") {
        console.log(`Not a recipe: ${recipe.not_a_recipe_reason ?? "no reason given"}`);
        return;
      }

      console.log(`Extracted: ${recipe.title?.value ?? "(untitled)"} — recipe id: ${recipeId}`);

      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO ingredients
           (id, recipe_id, canonical_name, quantity_value, quantity_unit, raw_text, is_pantry_staple, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of ingredientsTableRows(recipeId, recipe)) {
        insert.run(
          row.id,
          row.recipe_id,
          row.canonical_name,
          row.quantity_value,
          row.quantity_unit,
          row.raw_text,
          row.is_pantry_staple,
          row.evidence_json,
        );
      }

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
