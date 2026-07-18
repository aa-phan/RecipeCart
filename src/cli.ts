#!/usr/bin/env node
// recipecart CLI — the Phase 1 driver (Spec 4: "no queue, no auth, no HTTP;
// Specs 2/3 modules invoked directly by the CLI").
//
// Commands land here incrementally as each pipeline piece is built:
//   recipecart auth                -> kroger_client OAuth2 authorization-code flow
//   recipecart set-store           -> kroger_client.searchLocations() + save locationId
//   recipecart <tiktok-url>        -> extract() + matcher, writes review file
//   recipecart approve <recipe-id> -> cart runner, prints itemized results
import { Command } from "commander";
import { logger } from "./platform/logger.js";
import { config } from "./platform/config.js";
import * as krogerAuth from "./kroger/auth.js";
import * as krogerClient from "./kroger/client.js";
import { waitForCallback } from "./kroger/callback_server.js";
import { saveToken, loadToken, isExpiredOrMissing } from "./kroger/token_store.js";
import { saveStoreLocation } from "./kroger/store_config.js";

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

program
  .command("approve")
  .argument("<recipe-id>", "recipe id to approve for cart add")
  .description("Add approved items to the real Kroger cart and print itemized results")
  .action(async (recipeId: string) => {
    logger.info("approve command not yet implemented — see Step 1e", { recipeId });
    process.exitCode = 1;
  });

program
  .argument("[tiktok-url]", "a TikTok recipe URL to extract and match")
  .action(async (tiktokUrl?: string) => {
    if (!tiktokUrl) {
      program.help();
      return;
    }
    logger.info("extraction pipeline not yet implemented — see src/pipeline (Step 1b/1c)", {
      tiktokUrl,
    });
    process.exitCode = 1;
  });

program.parseAsync(process.argv);
