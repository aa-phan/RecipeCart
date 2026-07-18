// ARCHIVED — superseded by the H-E-B → Kroger retailer pivot. Kept as the
// historical record of the investigation that led to that decision; see
// files/spike-notes.md ("DECISION: retailer pivot from H-E-B to Kroger") for
// the full writeup and files/specs/spec-3-kroger-matching-cart.md for the
// current architecture. Not run as part of any current workflow.
//
// THROWAWAY DIAGNOSTIC — checks whether a specific Playwright launch config
// gets past heb.com's initial Akamai WAF block.
//
// This replicates texas-grocery-mcp's EXACT working recipe (from its
// auth/browser_refresh.py, read directly): bundled Chromium, the four launch
// args below, and a Mac Chrome 120 user-agent override. Their non-headless
// path reaches a *solvable* Akamai challenge (which a human then completes);
// their headless path only works with an already-valid stored session.
//
// Two modes:
//   npm run spike:heb-diag            -> HEADLESS (runs anywhere, no display)
//   npm run spike:heb-diag -- --headed -> HEADED, their exact non-headless
//                                          recipe; the variant our earlier
//                                          headed attempts never tried
//                                          (they omitted the UA override).
//                                          Needs a display; run it yourself.
//
// No login is attempted. The only question: real page, solvable challenge, or
// the same branded errorCode-15 hard deny as every prior attempt?

import { chromium } from "playwright";

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const headed = process.argv.includes("--headed");

async function main() {
  console.log(
    `Launching ${headed ? "HEADED" : "headless"} bundled Chromium with texas-grocery-mcp's ` +
      "exact recipe (UA override + their 4 args)...",
  );

  const browser = await chromium.launch({
    headless: !headed,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
    ],
  });

  const context = await browser.newContext({ userAgent: REALISTIC_UA });
  const page = await context.newPage();

  console.log("Navigating to heb.com (wait_until='load', matching their code)...");
  const response = await page.goto("https://www.heb.com/", {
    waitUntil: "load",
    timeout: 30_000,
  });

  console.log(`HTTP status: ${response?.status()}`);
  await page.waitForTimeout(4000); // let the SPA hydrate / any challenge render
  const title = await page.title();
  console.log(`Title: ${title}`);

  // eslint-disable-next-line no-undef -- runs in the browser context, not Node
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log("\n--- First 2000 chars of body text ---");
  console.log(bodyText);

  const isBlockPage =
    bodyText.includes("could not load") ||
    bodyText.includes("errorCode") ||
    bodyText.includes("incidentId");
  const isChallengePage =
    /verify you are human|please verify|checking your browser|press.*hold/i.test(bodyText) ||
    bodyText.trim().length < 500;

  console.log("\n=== Verdict ===");
  if (isBlockPage) {
    console.log(
      "SAME HARD DENY as before (branded H-E-B errorCode-15 page). Even their exact\n" +
        "recipe does not get past Akamai's outright block from this browser/IP.",
    );
  } else if (isChallengePage) {
    console.log(
      "SOLVABLE CHALLENGE reached (not the hard deny) — this is the state\n" +
        "texas-grocery-mcp's human-handoff is built for. A human could complete it in\n" +
        "headed mode. Materially better than the hard deny; note it in spike-notes.md.",
    );
  } else {
    console.log("REAL H-E-B page content — no block, no challenge. Session could be captured.");
  }

  if (headed) {
    console.log("\n(Leaving the window open 20s so you can eyeball it...)");
    await page.waitForTimeout(20_000);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
