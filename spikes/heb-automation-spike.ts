// ARCHIVED — superseded by the H-E-B → Kroger retailer pivot. Kept as the
// historical record of the investigation that led to that decision; see
// files/spike-notes.md ("DECISION: retailer pivot from H-E-B to Kroger") for
// the full writeup and files/specs/spec-3-kroger-matching-cart.md for the
// current architecture. Not run as part of any current workflow.
//
// THROWAWAY SPIKE — Phase 0, Spike B (resolves blockers B3-1..B3-4, answers
// A3-1/A3-2/A3-4). Not durable code: the real Playwright adapter
// (src/heb/adapter.ts) gets written from what this script teaches us.
//
// This spike needs YOU: it opens a real, HEADED browser and waits for you to
// log in to heb.com by hand (credentials are never seen or stored by this
// script — only the resulting storage state is captured, matching the
// login_guided() contract in Spec 3 §2.1).
//
// Usage: npm run spike:heb
// Requires: Google Chrome installed locally (real Chrome, not just Playwright's
// bundled Chromium — see the B3-2 note below).
//
// !!! IMPORTANT: quit ALL running Chrome windows before running this !!!
// This launches Playwright against your REAL Chrome profile (real cookies,
// real login state) rather than a fresh automated context — Chrome refuses
// to open a profile that's already in use by another process, so a running
// Chrome will cause this to fail or silently fall back to a blank profile.
//
// What to do when it runs:
//   1. Your real Chrome opens (already pointed at heb.com's homepage), using
//      your actual profile. If you're already logged in to heb.com from
//      normal browsing, you may already be logged in here too.
//   2. Confirm you're logged in (log in if not), and confirm/set your target
//      store + fulfillment mode (A3-1).
//   3. Come back to the terminal and press Enter.
//   4. The script does one search, reads the cart, and asks you to add one
//      item by hand so you can observe the DOM/selectors and a real
//      read-after-write signal.
//
// Findings (record in files/spike-notes.md): selectors encountered for
// login/search/product-tile/cart; whether search works logged OUT (A3-2 —
// decides whether the matcher can run without burning the session); any
// anti-bot friction (CAPTCHA, fingerprint challenges); observed session
// lifetime signal (note today's date + when it eventually expires).

import { chromium, type Page } from "playwright";
import readline from "node:readline/promises";
import os from "node:os";
import path from "node:path";

const SEARCH_TERM = "milk"; // arbitrary common grocery item for the spike

// B3-2 findings, in order of escalation:
//   1. Playwright's bundled Chromium -> hard WAF block (error code 15) before
//      any interaction, even though heb.com loads fine in a normal browser.
//   2. Real installed Chrome via `channel: "chrome"` (still a fresh,
//      Playwright-created profile, still CDP-automated) -> blocked
//      identically. Points to CDP-level detection (e.g. a `Runtime.enable`
//      leak), not just "which browser binary" — a known technique used by
//      sophisticated WAFs (Akamai/PerimeterX/DataDome-class) to catch ANY
//      CDP-driven automation regardless of which real browser drives it.
//   3. THIS ATTEMPT: launch against the user's actual real Chrome profile
//      (real cookies/history/extensions) via launchPersistentContext,
//      instead of a blank Playwright-created context. This is reusing a
//      genuine browser identity, not spoofing one — if this also gets
//      blocked, that's strong evidence heb.com blocks CDP-driven automation
//      categorically, which is the real go/no-go signal for Spec 3 as
//      designed (Playwright-based automation is the architecture's premise).
const CHROME_USER_DATA_DIR = path.join(os.homedir(), "Library/Application Support/Google/Chrome");

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function describePage(page: Page, label: string) {
  console.log(`\n--- ${label} ---`);
  console.log("URL:", page.url());
  console.log("Title:", await page.title());
}

async function main() {
  console.log("=== Spike B: H-E-B automation (real-Chrome-profile attempt) ===\n");
  console.log(`Using Chrome profile dir: ${CHROME_USER_DATA_DIR}`);
  console.log(
    "If Chrome is currently running anywhere on this machine, quit it completely now\n" +
      "(Cmd+Q), then continue.\n",
  );
  await waitForEnter("Press Enter once Chrome is fully quit...\n");

  console.log("Launching Chrome against your real profile (this can take a few seconds)...");
  const launchStartedAt = Date.now();

  // Give this a hard timeout with a clear error instead of hanging forever —
  // if launchPersistentContext() never resolves (e.g. Chrome's CDP handshake
  // stalls on a native "restore pages?" dialog or similar), we want to know
  // that explicitly rather than sit there indefinitely.
  const launchTimeoutMs = 45_000;
  const context = await Promise.race([
    chromium.launchPersistentContext(CHROME_USER_DATA_DIR, {
      headless: false,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
      timeout: launchTimeoutMs,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `launchPersistentContext() did not resolve within ${launchTimeoutMs}ms. ` +
                "Chrome likely started (check Activity Monitor / the ps command) but the " +
                "CDP handshake never completed — possibly blocked by a native Chrome dialog " +
                "(e.g. 'Chrome didn't shut down correctly, restore pages?'). Check the opened " +
                "window for any dialog and dismiss it, or fully quit Chrome (including via " +
                "Activity Monitor if needed) and retry.",
            ),
          ),
        launchTimeoutMs,
      ),
    ),
  ]);
  console.log(`Launch resolved after ${Date.now() - launchStartedAt}ms.`);

  try {
    // A real profile often restores multiple windows/tabs from your last
    // session on launch — the "first" page object isn't necessarily the one
    // in front, and one of them may be a blank new-tab page. Wait a beat for
    // Chrome's own restore to settle, then log every open page so it's clear
    // which one is which, and explicitly drive + focus one we control.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const existingPages = context.pages();
    console.log(`\n${existingPages.length} page(s) open after launch:`);
    for (const p of existingPages) {
      console.log(`  - ${p.url()}`);
    }

    const page = await context.newPage();
    await page.bringToFront();
    console.log("\nOpened a new tab and navigating it to heb.com — look for THIS window/tab.");
    await page.goto("https://www.heb.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await describePage(page, "Initial load (real profile)");

    console.log(
      "\n>>> Check: did the page load normally, or did you get the WAF block page\n" +
        ">>> again (error code 15)? This is the key B3-2 signal for this attempt.\n" +
        ">>> If blocked again: stop here, don't try to work around it further — this is\n" +
        ">>> the Go/No-Go signal, not a config problem to keep tweaking.",
    );
    await waitForEnter(
      "If the page loaded: log in if needed, confirm your target store + fulfillment\n" +
        "mode (A3-1), then press Enter to continue. If blocked: press Enter, then stop\n" +
        "and report back instead of continuing through the rest of the script...\n",
    );

    console.log(
      "\n>>> Eyeball the page: does it show you as logged in (account name/avatar\n" +
        ">>> visible, no login prompt)? Note this in spike-notes.md.",
    );
    await waitForEnter("Press Enter once you've confirmed login state...\n");

    // Search. Try this BOTH logged in (now) and — separately, in a fresh
    // incognito window outside this script entirely — logged out, to answer
    // A3-2.
    console.log(`\nSearching for "${SEARCH_TERM}"...`);
    await page.goto(`https://www.heb.com/search/?q=${encodeURIComponent(SEARCH_TERM)}`);
    await describePage(page, "Search results");
    console.log(
      "\n>>> Inspect the page (or use browser devtools) and note:\n" +
        "    - selector for the product-tile container\n" +
        "    - selector for product name / price / in-stock indicator\n" +
        "    - whether results differ between pickup and delivery mode",
    );
    await waitForEnter("Press Enter once you've noted the search-result selectors...\n");

    // Read cart (before adding anything, to see baseline structure).
    await page.goto("https://www.heb.com/cart");
    await describePage(page, "Cart (before add)");
    await waitForEnter(
      "Note the cart page's selectors (line items, quantity, price, empty-cart state).\n" +
        "Press Enter to continue to a single add-to-cart test...\n",
    );

    console.log(
      "\n>>> Manually click 'add to cart' on ONE product from the search results page\n" +
        ">>> (do this by hand in the browser — we are not exercising add_to_cart() yet,\n" +
        ">>> just observing what a successful add looks like in the DOM/network tab).",
    );
    await waitForEnter("Press Enter once you've added one item...\n");

    await page.goto("https://www.heb.com/cart");
    await describePage(page, "Cart (after add)");
    console.log(
      "\n>>> Confirm the item appears. Note what changed in the DOM (this becomes the\n" +
        ">>> read-after-write confirmation signal for add_to_cart() in Phase 1/2).",
    );

    await waitForEnter("Press Enter to close the browser and finish the spike...\n");
  } finally {
    await context.close();
  }

  console.log(
    "\nDone. Write findings to files/spike-notes.md:\n" +
      " - B3-1: selectors for login/search/product-tile/cart\n" +
      " - B3-2: did the real-profile attempt get past the WAF block or not?\n" +
      " - B3-3: session lifetime (this uses your real profile, so login persistence\n" +
      "         isn't a separate test here — it's however long your normal heb.com\n" +
      "         session already lasts)\n" +
      " - A3-1: confirmed store + fulfillment mode\n" +
      " - A3-2: does search work logged out? (test separately, e.g. a normal\n" +
      "         incognito window, outside this script)\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
