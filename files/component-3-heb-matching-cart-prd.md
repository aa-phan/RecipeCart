# H-E-B Product Matching and Cart Automation — Product Requirements Document

**Product:** RecipeCart — TikTok Recipe → H-E-B Cart Automation (working name)
**Component:** 3 of 4 — H-E-B Product Matching and Cart Automation
**Sibling documents:** Component 1 (Mobile Capture & Review) · Component 2 (TikTok Media & Recipe Extraction) · Component 4 (Backend Platform, Hosting & Orchestration)
**Scope:** Single user / small private beta
**Status:** Draft v1 — July 16, 2026

### Shared assumptions this document relies on
- **Matching runs automatically, immediately after extraction** — it's a read-only, reversible operation (search + rank), so it doesn't need to wait for user approval. **Cart mutation is the one gated action** in this entire system, requiring explicit user approval every time.
- **Checkout is never automated, under any circumstance.** This isn't a phased rollout decision — it's a permanent boundary enforced at the automation-adapter level, not just a policy statement (§17).
- **CAPTCHA, login, and MFA are always handed back to the user.** This component detects these states and pauses; it never attempts to solve or bypass them. Treating an anti-bot challenge as a "pause and ask the human" signal is both the safer design and the more robust one — attempting to defeat it would be fragile, likely against H-E-B's terms of service, and unnecessary given a human is one tap away in Component 1.
- Automation behaves like **one careful, single user** — sequential actions, reasonable pacing, one active H-E-B session at a time for MVP. This is a private, single-account tool, not a scraper.

---

## 1. Executive Summary
This component turns a reviewed ingredient list into real, purchasable items sitting in the user's own H-E-B cart — and stops exactly there. It owns two distinct jobs that must not blur together: figuring out *what to buy* (search, rank, and propose products) and *actually buying it* (adding approved items to the cart via browser automation). The first is safe to run eagerly and automatically. The second is a one-way action on a real account and is gated behind explicit user approval, every time, with no exceptions.

## 2. Problem Statement
A recipe's ingredient list doesn't map cleanly onto a grocery store's product catalog: "1 cup heavy cream" needs to become a specific package size at a specific price; "salt" probably shouldn't be added to the cart at all; "cream" without more context is genuinely ambiguous between products with different prices and uses. Doing this matching well — and then reliably clicking through H-E-B's actual website to add the right items — is tedious enough by hand that it's the second half of the manual-effort problem this whole product exists to remove.

## 3. Product Goals
- Propose relevant, correctly-sized product matches automatically, so the review screen is never empty.
- Make the deterministic/judgment-call split explicit: math and filtering are deterministic; genuinely ambiguous substitutions are surfaced for a human (or, when wording is ambiguous, informed by Claude) rather than silently guessed.
- Never add anything to the cart without prior approval, and never touch checkout.
- Report cart outcomes honestly and specifically — partial success is a first-class, expected result, not a failure mode to be smoothed over.

## 4. Non-Goals
- No checkout or payment automation, ever, under any framing.
- No multi-account or household support in v1 — one H-E-B session per deployment.
- No attempt to detect-and-defeat CAPTCHA or other anti-bot mechanisms — these always pause and hand off to the user.
- No guarantee of price or availability accuracy beyond what was true at the moment of the last check — grocery inventory and pricing change constantly, and this system discloses that rather than pretending otherwise.

## 5. Product-Matching User Journey
1. Component 2 emits a structured recipe; this component receives the ingredient list automatically.
2. Ingredient names are normalized (canonical name, unit normalization) as a deterministic pass.
3. Each ingredient is searched against H-E-B's product catalog for the user's selected store/fulfillment location.
4. Candidates are ranked (§9); pantry staples and pantry-marked ingredients are still matched, just deprioritized for display (mirrors Component 1's UI treatment).
5. High-confidence, unambiguous matches are pre-selected; low-confidence or materially ambiguous ingredients surface multiple candidates instead of one.
6. Results are attached to the recipe as soon as they're ready — no user action was required to get here.
7. User reviews and approves (or swaps/rejects) in Component 1's Review screen.
8. On explicit approval, this component runs the Playwright cart-add flow for approved items only.
9. Results — added / already-in-cart / needs-attention — are reported back per item.

## 6. Functional Requirements
Receive structured ingredients from Component 2; normalize names and units; determine purchase quantity from package size; search H-E-B's catalog for the active store; filter to in-stock items; rank candidates; apply user preferences (brand, store-brand, dietary, budget where feasible); detect and flag store-brand options; handle weight-sold items; handle pantry staples; handle substitutions and flag material ones for approval; avoid proposing duplicate products for the same ingredient; add approved items via browser automation; detect items already in the cart (by product id) and by differing quantity; maintain and securely reuse an authenticated H-E-B session; detect expired sessions and CAPTCHA/MFA interruptions; report complete/partial/failed cart outcomes; structurally prevent checkout/payment submission.

## 7. Ingredient-Normalization Requirements
- Canonical ingredient name (from Component 2) is the primary search key; `raw_text` is retained for display/debugging only.
- Units are normalized to a small closed set (weight: g/kg/oz/lb; volume: ml/l/tsp/tbsp/cup/fl oz; count) before quantity-to-package-size logic runs.
- Preparation notes ("melted," "diced") are retained but do not affect matching unless they imply a different product form (e.g., "shredded cheese" vs. a block).

## 8. Product-Search Requirements
- Search runs per-canonical-ingredient against the active store's catalog, not a generic nationwide catalog, since availability and price are store-specific.
- Search results exclude out-of-stock items outright rather than surfacing and deprioritizing them (an unavailable "best match" isn't useful to rank).
- Search is re-run (not cached indefinitely) if the recipe sits in "awaiting review" long enough that price/availability could plausibly have changed — a practical staleness window is a reasonable implementation-time tuning knob, not a fixed number this PRD needs to prescribe.

## 9. Candidate-Ranking Requirements
Deterministic scoring combines, in roughly this priority order:
1. Text/semantic similarity of ingredient name to product name/category (baseline relevance gate — poor matches are excluded, not just penalized).
2. Product form matching the recipe's preparation need (shredded vs. block, whole vs. ground) — deterministic where the text signal is clear, escalated to Claude judgment where it isn't (§9.1).
3. Quantity-to-package-size fit — penalizes large mismatches (needing 1 tbsp but only 5lb bags exist) without excluding the only available option; flags it instead.
4. User preferences — store-brand, organic, dietary, brand — applied as boosts/filters per the Preferences set in Component 1.
5. Unit price — tiebreaker among otherwise-similar candidates.
6. Historical selection for that ingredient, if the user has chosen a specific product before (post-MVP; noted here as it directly informs ranking once available).

### 9.1 Deterministic vs. Claude-Delegated Decisions
| Deterministic (code) | Claude-delegated |
|---|---|
| Converting "1 cup heavy cream" into a purchase quantity of a specific package size | Distinguishing heavy cream from half-and-half from light cream when the source wording is genuinely ambiguous |
| Excluding out-of-stock candidates | Judging whether a product's *form* matches the recipe's need when text similarity alone is inconclusive (e.g., "cheese" ingredient vs. a cheese platter product) |
| Applying an explicit store-brand/organic/dietary filter the user set | Deciding whether a substitution is *material* enough to require explicit user approval, versus safe enough to pre-select (a store-brand swap of canned tomatoes is not material; swapping "heavy cream" for "condensed milk" is, even if a naive text search ranked them similarly) |
| Detecting an item already in the cart by product id | — |
Claude is never the deciding vote on whether something gets added to the cart — it informs ranking/labeling; the user (via Component 1) or a deterministic rule always makes the final call on anything flagged material.

## 10. Package-Size and Quantity-Conversion Rules
- Deterministic unit-conversion table (cups/tbsp/tsp ↔ fl oz/ml, common ingredient-density conversions for weight-vs-volume where standardized, e.g., "1 cup flour ≈ 120g") drives the purchase-quantity calculation.
- When the required quantity is smaller than the smallest available package, the smallest package is proposed and the surplus is not treated as an error — this is normal grocery shopping.
- When no package size cleanly covers the requirement (e.g., recipe needs 3 lb, packages come in 1 lb or 5 lb), the closest-over option is proposed by default, with the alternative visible via the swap action in Component 1.

## 11. User-Preference Model
Preferences (store-brand, organic, dietary tags, and eventually budget) are set once in Component 1's Preferences screen and applied globally as ranking boosts/filters, with per-item override always available through the swap action at review time. Dietary tags filter out clearly conflicting products (e.g., a "vegan" preference deprioritizes/filters dairy-containing matches) but do **not** silently substitute a different ingredient entirely without flagging it as a material substitution (§9.1) — a user with a dairy allergy needs to see that a swap happened, not just receive a different product.

## 12. Pantry-Staple Behavior
Ingredients Component 2 classifies as pantry staples (salt, oil, water, common spices) still receive a product match — the user might genuinely need to buy salt — but are deprioritized and pre-unchecked for cart-adding by default, mirroring Component 1's UI treatment exactly. This is a display default, not a matching-quality shortcut; the matching logic runs the same regardless of the staple flag.

## 13. Substitution Behavior
A substitution is either **safe** (same ingredient, different brand/package/store-brand — pre-selected, always visible, never hidden) or **material** (a genuinely different ingredient being proposed as a stand-in — always requires explicit approval, never pre-selected, clearly labeled with why). The line between these is drawn by the deterministic/Claude split in §9.1, and when in doubt, the system treats a substitution as material — a false "needs approval" costs one extra tap; a false "safe" risks silently changing what someone cooks.

## 14. H-E-B Store and Fulfillment-Location Handling
Store/fulfillment selection (pickup vs. delivery, if both are supported — to be confirmed against H-E-B's current site during implementation, since exact fulfillment options are a site detail this PRD shouldn't hard-code) is a user preference set during onboarding. If the store changes between review and cart-insertion (e.g., changed directly in the H-E-B app), this component detects the mismatch before mutating the cart and prompts to confirm/re-sync rather than silently adding items priced or stocked for the wrong location.

## 15. Browser Automation Requirements
- **Playwright with named, versioned selectors** as the primary mechanism, wrapped in a thin adapter module (`search()`, `readCart()`, `addToCart()`, `getSessionStatus()`) so a change in H-E-B's markup requires updating the adapter, not every call site.
- **Claude computer use as a scoped fallback only** — used to classify an unexpected page state ("what changed, what should the deterministic layer do next") when a selector fails outright, not to autonomously push through logins, MFA, or CAPTCHA. Those three always pause the job and notify the user via Component 1, full stop.
- **Rate limiting / responsible automation:** deliberate pacing between actions, one H-E-B session active at a time for MVP, no parallel automated sessions — the goal is to behave indistinguishably from a careful human user, not to maximize throughput.
- **Unexpected-page detection:** if the resulting page's URL/title/key elements don't match the expected pattern after an action, the automation pauses and flags rather than continuing blind.

## 16. Authentication and Session-Management Requirements
- The user connects H-E-B once through a guided, embedded login flow; the system captures the resulting **session cookies/storage state**, not the username or password — the raw credential is never seen or stored by this app, which meaningfully reduces both risk and liability.
- Session storage-state is encrypted at rest (Component 4 owns the encryption mechanism).
- Session validity is checked **proactively** (a lightweight authenticated status check before starting a cart job) and **reactively** (mid-job auth failure) — either path pauses the job in "requires login" state and notifies the user, rather than failing silently or retry-looping against an expired session.
- Exact session lifetime is an H-E-B-side detail to be observed empirically during implementation rather than assumed; the requirement is graceful detection and recovery, not a specific TTL.

## 17. Cart Mutation Safeguards
- **Preview/dry-run separation:** computing proposed matches (what *would* be added) never touches the real H-E-B cart — only the explicit "Add to cart" approval action does.
- **Idempotent, approval-tokened commit:** the actual cart-add action is tied to a specific approval event and idempotency key (Component 4), so a retried request from a flaky mobile connection can't double-add items.
- **Read-after-write confirmation:** after each add action, the cart is re-read to confirm the item and quantity actually landed — "no error thrown" is not treated as sufficient confirmation on its own.
- **Structural checkout prevention:** the automation adapter simply has no method capable of navigating to or submitting a checkout/payment flow. This isn't a prompt-level instruction that could be argued around — it's the absence of a code path.

## 18. Partial-Failure and Recovery Requirements
Transient failures (timeout, momentary page hiccup) retry automatically a small, capped number of times. Permanent failures (out of stock at cart-add time, selector broke against a site change, item genuinely unavailable) surface to the user with a specific reason and no further automatic retry. A job with some successes and some failures is a normal terminal state (`Partially completed`), distinct from total failure (e.g., session expired before anything was added, which is `Failed`/`Requires user intervention`).

## 19. Security and Privacy Requirements
- H-E-B credentials (username/password) are never handled or stored by this app when avoidable, by design (§16).
- Session storage-state is encrypted at rest; access to trigger cart automation requires the same device-token auth as the rest of the app (Component 1/4).
- TikTok's and H-E-B's terms of service may restrict automated access; this is a known consideration for a personal/private-beta tool operating on the user's own account, and a legal/ToS review is recommended before any consideration of scaling beyond personal use. The system is designed to degrade gracefully (pause and hand off to the user) if automation becomes blocked, rather than escalating attempts to work around a block.

## 20. Observability Requirements
Match acceptance rate (proposed-as-is vs. swapped vs. rejected) by ingredient category; cart add success/partial/fail rates; average candidates surfaced per ingredient; automation failure-reason breakdown (selector miss vs. CAPTCHA vs. session expired vs. network vs. out-of-stock); average cart-job duration.

## 21. Product-Match Quality Metrics
% of ingredients receiving at least one in-stock candidate; % of high-confidence matches accepted with zero edits (ranking-quality proxy); % of low-confidence matches where the user picked something other than the top candidate (signal to retune ranking weights); rate of material substitutions correctly flagged vs. later corrected by the user (a proxy for whether the deterministic/Claude split in §9.1 is drawing the line in the right place).

## 22. Dependencies on the Other Three Components
- **From Component 2:** the structured recipe/ingredient schema — canonical names, quantities, units, pantry-staple flags — as the entire input to matching.
- **From Component 1:** approved/rejected/swapped selections and the explicit cart-approval action; user preferences (store-brand, organic, dietary).
- **From Component 4:** job orchestration, encrypted session storage, secrets management, and the retry/idempotency infrastructure that makes cart-add safe to run exactly once per approval.
- **To Component 1:** ranked candidates per ingredient and itemized cart results.

## 23. API and Data-Contract Expectations
This component is invoked as an internal worker stage (matching) and a triggered worker task (cart-add), not a public HTTP service, mirroring Component 2's architecture.
| Event | Emitted when | Payload |
|---|---|---|
| `recipe.matching.completed` | Ranking finishes for all ingredients | `job_id`, candidates per ingredient |
| `recipe.matching.degraded` | Matching partially fails (e.g., search unavailable for some items) | `job_id`, affected ingredient ids |
| `cart.add.requested` | User approves via `/api/recipes/:id/cart:approve` (Component 1/4) | `job_id`, approved item list, idempotency key |
| `cart.add.completed` \| `cart.add.partial` \| `cart.add.failed` | Cart job reaches a terminal state | `job_id`, per-item results and reasons |

## 24. MVP Scope
Automatic post-extraction matching; deterministic ranking with the Claude-delegated ambiguity cases in §9.1; safe-vs-material substitution distinction; pantry-staple deprioritization; weighted-item handling as estimated quantities; already-in-cart and differing-quantity detection; single H-E-B session, single store; Playwright automation with adapter-isolated selectors; CAPTCHA/MFA hand-off to user; itemized partial-failure reporting; structural checkout prevention.

## 25. Post-MVP Roadmap
Multi-account/household session support; "backup pick" pre-approved fallbacks for out-of-stock items at cart time; historical per-ingredient product memory feeding ranking; Claude computer use expanded beyond page-state classification if selector fragility proves to be a real bottleneck in practice; automated selector-health monitoring against H-E-B site changes.

## 26. Acceptance Criteria
- No item is ever added to the H-E-B cart without a corresponding explicit approval event.
- No code path exists that can reach a checkout/payment page.
- A CAPTCHA or MFA challenge always pauses the job and notifies the user; it is never auto-solved or bypassed.
- An item already present in the cart is detected and not duplicated; a differing-quantity match is surfaced, not silently overwritten.
- A weight-sold item is clearly labeled as an estimate in both the match and the cart result.
- A partial cart-add result lists every unadded item with a specific reason.
- A material substitution is never pre-selected without being visibly flagged as such.

## 27. Open Questions and Recommended Decisions
| Question | Recommendation |
|---|---|
| Match before or after user review? | Match automatically right after extraction (safe, reversible); gate only the actual cart mutation behind explicit approval. |
| Approve every item or only uncertain ones? | Default: only uncertain/material items require explicit tap-to-approve; high-confidence matches are pre-selected but always visible/editable. A "review everything" preference is available for users who want more control. |
| How to treat salt/oil/water/common spices? | Still matched, but deprioritized and pre-unchecked by default, consistent with Component 1's pantry-staple UI. |
| How to determine if an item is already in the cart? | Match by product id against a fresh cart read immediately before the add action. |
| Item present in a different quantity? | Surface the discrepancy explicitly ("already in cart: 1, this recipe needs 2") and let the user choose to increase or leave as-is — never silently overwrite. |
| Store-location changes? | Detect a mismatch between the review-time store and the live session's active store before mutating the cart; prompt to confirm/re-sync rather than proceeding silently. |
| Weighted produce/meat representation? | Represent as an approximate, priced-by-weight item with a clearly flagged estimate, both in the review UI and the underlying record. |
| Price changes between review and cart insertion? | Disclose in the result summary if the change exceeds a small threshold; still add the item — price drift is normal and not worth hard-blocking on. |
| Unavailable products at cart time? | Do not silently substitute; mark as "unavailable, needs your review" unless the user had explicitly pre-approved a specific backup (post-MVP feature). |
| Multiple H-E-B accounts/household users? | Out of scope for MVP — single session per deployment; flagged as a clear post-MVP direction requiring per-user encrypted session storage. |
| How often must login be refreshed? | Unknown until observed empirically against H-E-B's actual session lifetime; the requirement is proactive + reactive detection and graceful pause, not a hardcoded refresh interval. |
| What happens when only some products can be added? | Itemized partial success is a first-class, expected terminal state — never summarized as a flat pass/fail. |

---

## Appendix: Illustrative Examples

### A. Product-candidate record (ambiguous ingredient, Claude-assisted)
```json
{
  "ingredient_id": "ing_04",
  "canonical_name": "cream",
  "raw_text": "splash of cream",
  "ambiguity_note": "Wording doesn't specify heavy, light, or half-and-half",
  "candidates": [
    { "product_id": "HEB-30112", "name": "H-E-B Heavy Whipping Cream, 1pt", "price": 3.29, "rank_score": 0.81, "reason": "Most common default for 'cream' in savory/baking narration context" },
    { "product_id": "HEB-30118", "name": "H-E-B Half & Half, 1pt", "price": 2.49, "rank_score": 0.74 }
  ],
  "requires_user_approval": true,
  "approval_reason": "material_ambiguity"
}
```

### B. Weighted-item case
```json
{
  "ingredient_id": "ing_01",
  "canonical_name": "chicken thighs",
  "required_quantity": { "value": 1, "unit": "lb" },
  "matched_product": { "product_id": "HEB-51190", "name": "H-E-B Boneless Chicken Thighs", "sold_by_weight": true, "package_estimate": "≈1.4 lb", "estimated_price": 6.49 },
  "display_note": "Sold by weight — actual weight and price confirmed at fulfillment"
}
```

### C. Duplicate-in-cart case
```json
{
  "ingredient_id": "ing_07",
  "canonical_name": "flour tortillas",
  "cart_check": { "already_present": true, "existing_quantity": 1, "requested_quantity": 1 },
  "action_taken": "skipped_no_duplicate",
  "user_facing_note": "Already in your cart — not added again"
}
```

### D. Partial-failure cart result
```json
{
  "job_id": "cart_2291",
  "status": "partially_completed",
  "results": [
    { "ingredient_id": "ing_01", "status": "added", "product_id": "HEB-51190" },
    { "ingredient_id": "ing_04", "status": "added", "product_id": "HEB-30112" },
    { "ingredient_id": "ing_09", "status": "needs_attention", "reason": "out_of_stock_at_cart_time" }
  ],
  "summary": "2 of 3 items added"
}
```
