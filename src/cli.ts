#!/usr/bin/env node
// recipecart CLI — the Phase 1 driver (Spec 4: "no queue, no auth, no HTTP;
// Specs 2/3 modules invoked directly by the CLI").
//
// Commands land here incrementally as each pipeline piece is built:
//   recipecart login              -> heb_adapter.login_guided()
//   recipecart set-store          -> heb_adapter.set_store()
//   recipecart <tiktok-url>       -> extract() + matcher, writes review file
//   recipecart approve <recipe-id> -> cart runner, prints itemized results
import { Command } from "commander";
import { logger } from "./platform/logger.js";

const program = new Command();

program
  .name("recipecart")
  .description("TikTok Recipe -> H-E-B Cart Automation (Phase 1 barebones pipeline)")
  .version("0.1.0");

program
  .command("login")
  .description("Guided H-E-B login: opens a headed browser, captures storage state only")
  .action(async () => {
    logger.info("login command not yet implemented — see src/heb/adapter.ts (Step 1d)");
    process.exitCode = 1;
  });

program
  .command("set-store")
  .description("Verify/select the H-E-B fulfillment store")
  .action(async () => {
    logger.info("set-store command not yet implemented — see src/heb/adapter.ts (Step 1d)");
    process.exitCode = 1;
  });

program
  .command("approve")
  .argument("<recipe-id>", "recipe id to approve for cart add")
  .description("Add approved items to the real H-E-B cart and print itemized results")
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
