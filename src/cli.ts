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
    logger.info("auth command not yet implemented — see src/kroger/client.ts (Step 1d)");
    process.exitCode = 1;
  });

program
  .command("set-store")
  .description("Look up and save the target Kroger store location")
  .action(async () => {
    logger.info("set-store command not yet implemented — see src/kroger/client.ts (Step 1d)");
    process.exitCode = 1;
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
