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
// Requires: npx playwright install chromium   (one-time)
//
// What to do when it runs:
//   1. A Chromium window opens on heb.com. Log in normally.
//   2. Also pick/verify your target store + fulfillment mode (A3-1) while
//      you're there — pickup vs delivery may change what the cart looks
//      like, note that in spike-notes.md.
//   3. Come back to the terminal and press Enter when you're logged in.
//   4. The script saves storage state, closes, reopens with that state, and
//      confirms the session survived — then does one search, reads the
//      cart, and adds one item so you can watch the DOM/selectors.
//
// Findings (record in files/spike-notes.md): selectors encountered for
// login/search/product-tile/cart; whether search works logged OUT (A3-2 —
// decides whether the matcher can run without burning the session); any
// anti-bot friction (CAPTCHA, fingerprint challenges); observed session
// lifetime signal (note today's date + when it eventually expires).

import { chromium, type Page } from "playwright";
import fs from "node:fs";
import readline from "node:readline/promises";
import path from "node:path";

const STORAGE_STATE_PATH = path.resolve("spikes/tmp/heb-storage-state.json");
const SEARCH_TERM = "milk"; // arbitrary common grocery item for the spike

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
  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  console.log("=== Spike B: H-E-B automation ===\n");

  // Step 1: guided login, headed, no credentials touched by this script.
  const browser1 = await chromium.launch({ headless: false });
  const context1 = await browser1.newContext();
  const page1 = await context1.newPage();
  await page1.goto("https://www.heb.com/");
  await describePage(page1, "Initial load");

  await waitForEnter(
    "\nLog in to heb.com in the opened browser window (and confirm your target store).\n" +
      "Press Enter here once you're logged in and the store is set...\n",
  );

  await context1.storageState({ path: STORAGE_STATE_PATH });
  console.log(`Storage state captured -> ${STORAGE_STATE_PATH}`);
  await browser1.close();

  // Step 2: restart with saved state, confirm session survives.
  const browser2 = await chromium.launch({ headless: false });
  const context2 = await browser2.newContext({ storageState: STORAGE_STATE_PATH });
  const page2 = await context2.newPage();
  await page2.goto("https://www.heb.com/");
  await describePage(page2, "Reloaded with saved storage state");

  console.log(
    "\n>>> Eyeball the page: does it show you as logged in (account name/avatar visible,\n" +
      ">>> no login prompt)? Note this in spike-notes.md as the session-reuse result.",
  );
  await waitForEnter("Press Enter once you've confirmed login state...\n");

  // Step 3: search. Try this BOTH logged in (now) and — separately, in a
  // fresh incognito-style context with no storage state — logged out, to
  // answer A3-2. This script only exercises the logged-in path; duplicate
  // the block below with a state-less context to test logged-out search.
  console.log(`\nSearching for "${SEARCH_TERM}"...`);
  await page2.goto(`https://www.heb.com/search/?q=${encodeURIComponent(SEARCH_TERM)}`);
  await describePage(page2, "Search results");
  console.log(
    "\n>>> Inspect the page (or use Playwright Inspector / browser devtools) and note:\n" +
      "    - selector for the product-tile container\n" +
      "    - selector for product name / price / in-stock indicator\n" +
      "    - whether results differ between pickup and delivery mode",
  );
  await waitForEnter("Press Enter once you've noted the search-result selectors...\n");

  // Step 4: read cart (before adding anything, to see baseline structure).
  await page2.goto("https://www.heb.com/cart");
  await describePage(page2, "Cart (before add)");
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

  await page2.goto("https://www.heb.com/cart");
  await describePage(page2, "Cart (after add)");
  console.log(
    "\n>>> Confirm the item appears. Note what changed in the DOM (this becomes the\n" +
      ">>> read-after-write confirmation signal for add_to_cart() in Phase 1/2).",
  );

  await waitForEnter("Press Enter to close the browser and finish the spike...\n");
  await browser2.close();

  console.log(
    "\nDone. Write findings to files/spike-notes.md:\n" +
      " - B3-1: selectors for login/search/product-tile/cart\n" +
      " - B3-2: anti-bot friction observed (or none)\n" +
      " - B3-3: session lifetime (revisit this file's storage state after a few days)\n" +
      " - A3-1: confirmed store + fulfillment mode\n" +
      " - A3-2: does search work logged out? (test separately, no storage state)\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
