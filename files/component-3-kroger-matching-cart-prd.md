# Kroger Product Matching and Cart Automation — Product Requirements Document

**Product:** RecipeCart — TikTok Recipe → Kroger Cart Automation (working name)
**Component:** 3 of 4 — Kroger Product Matching and Cart Automation
**Sibling documents:** Component 1 (Mobile Capture & Review) · Component 2 (TikTok Media & Recipe Extraction) · Component 4 (Backend Platform, Hosting & Orchestration)
**Scope:** Single user / small private beta
**Status:** Draft v2 — July 17, 2026 (retailer pivot from H-E-B; supersedes `component-3-heb-matching-cart-prd.md`)

### Why this document replaces the H-E-B version

The Phase 0 risk spike found that heb.com blocks Playwright-driven browser automation
outright — a hard, unconditional deny confirmed across five distinct configurations,
including reproducing a public reference implementation's exact working recipe headed
and headless. The block sits below the JS layer (no launch-flag/user-agent change
helped), meaning defeating it would require TLS/network-fingerprint evasion tooling —
out of scope for this product. Full findings: `files/spike-notes.md`.

**Kroger publishes an official, self-service developer API** that covers everything
this component needs — product search with live price/stock/aisle data, store
lookup, and an authenticated add-to-cart endpoint — via standard OAuth2. No browser
automation, no anti-bot fight, no ToS gray area. This document is the retailer-pivoted
replacement for the matching/cart component; the underlying product philosophy
(deterministic matching, gated cart mutation, itemized honest results) is unchanged.

### Shared assumptions this document relies on
- **Matching runs automatically, immediately after extraction** — it's a read-only, reversible operation (search + rank), so it doesn't need to wait for user approval. **Cart mutation is the one gated action** in this entire system, requiring explicit user approval every time.
- **Checkout is never automated, under any circumstance.** This isn't a phased rollout decision — it's a permanent boundary, now enforced doubly: at the adapter level by discipline, and structurally by the fact that Kroger's Public API has no checkout/payment endpoint to call in the first place.
- **This component uses Kroger's own sanctioned OAuth2 login for cart access.** The user authenticates directly with Kroger (never through this app) and explicitly consents to the specific scopes requested. No credential is ever seen or stored by this app.
- Automation behaves like **one careful, single user**, within Kroger's documented daily rate limits (5,000 cart-adds/day, 10,000 product searches/day) — trivial at single-account scale. This is a private, single-account tool, not a scraper.

---

## 1. Executive Summary
This component turns a reviewed ingredient list into real, purchasable items sitting in the user's own Kroger cart — and stops exactly there. It owns two distinct jobs that must not blur together: figuring out *what to buy* (search, rank, and propose products via Kroger's Products API) and *actually buying it* (adding approved items to the cart via Kroger's Cart API, under standard OAuth2 authorization). The first is safe to run eagerly and automatically, and needs no per-user authentication at all. The second is a one-way action on a real account and is gated behind explicit user approval, every time, with no exceptions.

## 2. Problem Statement
A recipe's ingredient list doesn't map cleanly onto a grocery store's product catalog: "1 cup heavy cream" needs to become a specific package size at a specific price; "salt" probably shouldn't be added to the cart at all; "cream" without more context is genuinely ambiguous between products with different prices and uses. Doing this matching well — and then reliably adding the right items to a real Kroger cart — is tedious enough by hand that it's the second half of the manual-effort problem this whole product exists to remove.

## 3. Product Goals
- Propose relevant, correctly-sized product matches automatically, so the review screen is never empty.
- Make the deterministic/judgment-call split explicit: math and filtering are deterministic; genuinely ambiguous substitutions are surfaced for a human (or, when wording is ambiguous, informed by Claude) rather than silently guessed.
- Never add anything to the cart without prior approval, and never touch checkout.
- Report cart outcomes honestly and specifically — partial success is a first-class, expected result, not a failure mode to be smoothed over.

## 4. Non-Goals
- No checkout or payment automation, ever, under any framing — and no code path could reach one, since the Public API doesn't expose checkout at all.
- No multi-account or household support in v1 — one authorized Kroger account per deployment.
- No browser automation, scraping, or anti-bot evasion of any kind — this component only calls Kroger's documented, sanctioned Public API.
- No guarantee of price or availability accuracy beyond what was true at the moment of the last check — grocery inventory and pricing change constantly, and this system discloses that rather than pretending otherwise.

## 5. Product-Matching User Journey
1. Component 2 emits a structured recipe; this component receives the ingredient list automatically.
2. Ingredient names are normalized (canonical name, unit normalization) as a deterministic pass.
3. Each ingredient is searched against Kroger's Products API for the user's selected store location (`locationId`) — using an app-level token, no per-user login required for this step.
4. Candidates are ranked (§9); pantry staples and pantry-marked ingredients are still matched, just deprioritized for display (mirrors Component 1's UI treatment).
5. High-confidence, unambiguous matches are pre-selected; low-confidence or materially ambiguous ingredients surface multiple candidates instead of one.
6. Results are attached to the recipe as soon as they're ready — no user action was required to get here.
7. User reviews and approves (or swaps/rejects) in Component 1's Review screen.
8. On explicit approval, this component calls the Kroger Cart API for approved items only, using the user's previously-authorized OAuth token.
9. Results — added / needs-attention — are reported back per item. (Kroger's Public Cart API has no read endpoint, so "already-in-cart" detection isn't available at this tier — see §16, §17.)

## 6. Functional Requirements
Receive structured ingredients from Component 2; normalize names and units; determine purchase quantity from package size; search Kroger's Products API for the active store location; filter to in-stock items; rank candidates; apply user preferences (brand, store-brand, dietary, budget where feasible); detect and flag store-brand options; handle weight-sold items; handle pantry staples; handle substitutions and flag material ones for approval; avoid proposing duplicate products for the same ingredient; add approved items via the Kroger Cart API; maintain and securely refresh an OAuth token pair (access + refresh) for the authorized Kroger account; detect expired/revoked tokens and prompt re-authorization; report complete/partial/failed cart outcomes; structurally prevent checkout/payment submission (by construction — no such endpoint exists to call).

## 7. Ingredient-Normalization Requirements
- Canonical ingredient name (from Component 2) is the primary search key; `raw_text` is retained for display/debugging only.
- Units are normalized to a small closed set (weight: g/kg/oz/lb; volume: ml/l/tsp/tbsp/cup/fl oz; count) before quantity-to-package-size logic runs.
- Preparation notes ("melted," "diced") are retained but do not affect matching unless they imply a different product form (e.g., "shredded cheese" vs. a block).

## 8. Product-Search Requirements
- Search runs per-canonical-ingredient against the active store's catalog (`locationId`), not a generic nationwide catalog, since availability and price are store-specific.
- Search results exclude out-of-stock items outright rather than surfacing and deprioritizing them, using the Products API's `stockLevel` field (`TEMPORARILY_OUT_OF_STOCK` excluded).
- Search is re-run (not cached indefinitely) if the recipe sits in "awaiting review" long enough that price/availability could plausibly have changed — a practical staleness window is a reasonable implementation-time tuning knob, not a fixed number this PRD needs to prescribe.
- Search requires no per-user authentication — an app-level Client Credentials token is sufficient, so matching can run even before a user has connected their Kroger account.

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
| Excluding out-of-stock candidates (via `stockLevel`) | Judging whether a product's *form* matches the recipe's need when text similarity alone is inconclusive (e.g., "cheese" ingredient vs. a cheese platter product) |
| Applying an explicit store-brand/organic/dietary filter the user set | Deciding whether a substitution is *material* enough to require explicit user approval, versus safe enough to pre-select (a store-brand swap of canned tomatoes is not material; swapping "heavy cream" for "condensed milk" is, even if a naive text search ranked them similarly) |
| — | — |
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

## 14. Store and Fulfillment-Location Handling
Store selection is a user preference set during onboarding, resolved via Kroger's Locations API (search by zip code → `locationId`). Fulfillment isn't a store-wide mode switch the way it might be elsewhere — each product result carries its own `fulfillment` object (`instore`/`shiptohome`/`delivery`/`curbside` booleans), so availability-by-fulfillment-type is a per-product fact returned directly by the API, not something this component needs to infer. If the user changes their preferred store between review and cart-insertion, this component detects the mismatch (stored `locationId` on the recipe vs. current preference) before mutating the cart and prompts to confirm/re-sync rather than silently adding items priced or stocked for the wrong location.

## 15. Kroger API Integration Requirements
- **Kroger's official Public API** (`developer.kroger.com`) as the sole integration mechanism — no browser automation, no scraping. A thin, typed client module (`searchProducts()`, `searchLocations()`, `addToCart()`, token management) so the rest of the system never talks to Kroger's HTTP API directly.
- **Two OAuth2 grant types:** Client Credentials (app-level) for Products/Locations search — no user interaction required; Authorization Code (per-user, standard login+consent) for Cart/Identity — the user authenticates directly with Kroger.
- **Documented daily rate limits** (Products 10,000/day, Locations 1,600/day/endpoint, Cart 5,000/day) are respected by design; trivial to stay under at single-user volume, so no special throttling logic is needed beyond basic request tracking.
- **No checkout code path exists, structurally** — the API has no checkout/payment endpoint, so there is nothing to accidentally call.

## 16. Authentication and Token-Management Requirements
- The user connects their Kroger account once through a standard OAuth2 Authorization Code redirect — they log in and consent directly on Kroger's own site, never through this app; the raw credential is never seen or stored by this app, same privacy property the original design had, now achieved by an industry-standard mechanism.
- The resulting access token + refresh token pair is encrypted at rest (Component 4 owns the encryption mechanism) — a smaller, simpler payload than a full browser session state.
- Token validity is checked **proactively** (refresh if near/past expiry before starting a cart job) and **reactively** (mid-job auth failure, e.g. token revoked by the user in their Kroger account settings) — either path pauses the job in "requires reconnection" state and notifies the user, rather than failing silently or retry-looping against an invalid token.
- Access token/refresh token TTLs follow Kroger's documented OAuth2 lifetimes (to be confirmed from their docs during implementation) — a standard, predictable model, not an empirically-observed unknown.

## 17. Cart Mutation Safeguards
- **Preview/dry-run separation:** computing proposed matches (what *would* be added) never touches the real Kroger cart — only the explicit "Add to cart" approval action does.
- **Idempotent, approval-tokened commit:** the actual cart-add action is tied to a specific approval event and idempotency key (Component 4), so a retried request from a flaky mobile connection can't double-add items. This is now the **primary** duplicate-prevention mechanism, not a second layer behind a cart re-read (see next point).
- **No read-after-write cart re-read is available** — Kroger's Public Cart API is add-only, with no `GET` endpoint at this tier (that capability exists only behind a separate Kroger Partner-tier business-approval process, not pursued for v1). Confirmation instead relies on the `add_to_cart` API response itself: a `204 No Content` response is Kroger's own confirmation that the item was accepted onto the account's cart. This is disclosed as a known limitation, not silently glossed over (§27).
- **Structural checkout prevention:** the API client simply has no method capable of reaching a checkout/payment endpoint, because Kroger's Public API doesn't expose one. This isn't a prompt-level instruction that could be argued around — it's the absence of both the code path and the underlying API surface.

## 18. Partial-Failure and Recovery Requirements
Transient failures (timeout, momentary rate-limit hit) retry automatically a small, capped number of times. Permanent failures (out of stock at cart-add time, invalid/discontinued product id, daily rate limit exhausted) surface to the user with a specific reason and no further automatic retry. A job with some successes and some failures is a normal terminal state (`Partially completed`), distinct from total failure (e.g., token expired before anything was added, which is `Failed`/`Requires user intervention`).

## 19. Security and Privacy Requirements
- Kroger credentials (username/password) are never handled or stored by this app — by construction, since OAuth2 Authorization Code redirects the user to authenticate directly with Kroger (§16).
- The OAuth token pair is encrypted at rest; access to trigger cart automation requires the same device-token auth as the rest of the app (Component 1/4).
- This component uses only Kroger's official, documented Public API under its own developer terms of service — there is no automated-access ToS ambiguity the way there was for direct browser automation against a retailer's consumer site. The system still degrades gracefully (pause and prompt re-authorization) if a token is revoked or a rate limit is hit, rather than retrying blindly.

## 20. Observability Requirements
Match acceptance rate (proposed-as-is vs. swapped vs. rejected) by ingredient category; cart add success/partial/fail rates; average candidates surfaced per ingredient; API failure-reason breakdown (out-of-stock vs. invalid-product vs. rate-limited vs. token-expired/revoked); average cart-job duration; daily API call volume against the documented rate-limit ceilings (an early-warning signal well before the ceiling is actually hit at personal-use scale).

## 21. Product-Match Quality Metrics
% of ingredients receiving at least one in-stock candidate; % of high-confidence matches accepted with zero edits (ranking-quality proxy); % of low-confidence matches where the user picked something other than the top candidate (signal to retune ranking weights); rate of material substitutions correctly flagged vs. later corrected by the user (a proxy for whether the deterministic/Claude split in §9.1 is drawing the line in the right place).

## 22. Dependencies on the Other Three Components
- **From Component 2:** the structured recipe/ingredient schema — canonical names, quantities, units, pantry-staple flags — as the entire input to matching.
- **From Component 1:** approved/rejected/swapped selections and the explicit cart-approval action; user preferences (store-brand, organic, dietary).
- **From Component 4:** job orchestration, encrypted token storage, secrets management (`client_id`/`client_secret`), and the retry/idempotency infrastructure that makes cart-add safe to run exactly once per approval.
- **To Component 1:** ranked candidates per ingredient and itemized cart results.

## 23. API and Data-Contract Expectations
This component is invoked as an internal worker stage (matching) and a triggered worker task (cart-add), not a public HTTP service, mirroring Component 2's architecture.
| Event | Emitted when | Payload |
|---|---|---|
| `recipe.matching.completed` | Ranking finishes for all ingredients | `job_id`, candidates per ingredient |
| `recipe.matching.degraded` | Matching partially fails (e.g., Products API unavailable/rate-limited for some items) | `job_id`, affected ingredient ids |
| `cart.add.requested` | User approves via `/api/recipes/:id/cart:approve` (Component 1/4) | `job_id`, approved item list, idempotency key |
| `cart.add.completed` \| `cart.add.partial` \| `cart.add.failed` | Cart job reaches a terminal state | `job_id`, per-item results and reasons |

## 24. MVP Scope
Automatic post-extraction matching (no per-user auth required); deterministic ranking with the Claude-delegated ambiguity cases in §9.1; safe-vs-material substitution distinction; pantry-staple deprioritization; weighted-item handling as estimated quantities; single Kroger account, single store; Kroger Public API integration (Products, Locations, Cart) under standard OAuth2; itemized partial-failure reporting; structural checkout prevention.

## 25. Post-MVP Roadmap
Multi-account/household token support; "backup pick" pre-approved fallbacks for out-of-stock items at cart time; historical per-ingredient product memory feeding ranking; **Kroger Partner-tier application** — unlocks cart read access (removing the L3-1 duplicate-detection limitation) and removes daily rate limits, worth pursuing if the product grows meaningfully past personal/private-beta scale.

## 26. Acceptance Criteria
- No item is ever added to the Kroger cart without a corresponding explicit approval event.
- No code path exists that can reach a checkout/payment endpoint (verified by the fact that the underlying API has none).
- An expired or revoked OAuth token always pauses the job and prompts the user to reconnect; it is never silently retried against an invalid token.
- A weight-sold item is clearly labeled as an estimate in both the match and the cart result.
- A partial cart-add result lists every unadded item with a specific reason.
- A material substitution is never pre-selected without being visibly flagged as such.
- Daily API call volume stays observably within Kroger's documented rate limits.

## 27. Open Questions and Recommended Decisions
| Question | Recommendation |
|---|---|
| Match before or after user review? | Match automatically right after extraction (safe, reversible, no auth required); gate only the actual cart mutation behind explicit approval. |
| Approve every item or only uncertain ones? | Default: only uncertain/material items require explicit tap-to-approve; high-confidence matches are pre-selected but always visible/editable. |
| How to treat salt/oil/water/common spices? | Still matched, but deprioritized and pre-unchecked by default, consistent with Component 1's pantry-staple UI. |
| How to determine if an item is already in the cart? | **Not possible at Public tier** (no cart-read endpoint) — accepted as a known limitation (§17); idempotency keys prevent same-approval-event duplication, which covers the common case. Revisit via Kroger Partner tier if it proves to be a real problem. |
| Store-location changes? | Detect a mismatch between the review-time `locationId` and the user's current store preference before mutating the cart; prompt to confirm/re-sync rather than proceeding silently. |
| Weighted produce/meat representation? | Represent as an approximate, priced-by-weight item with a clearly flagged estimate, both in the review UI and the underlying record. |
| Price changes between review and cart insertion? | Disclose in the result summary if the change exceeds a small threshold; still add the item — price drift is normal and not worth hard-blocking on. |
| Unavailable products at cart time? | Do not silently substitute; mark as "unavailable, needs your review" unless the user had explicitly pre-approved a specific backup (post-MVP feature). |
| Multiple Kroger accounts/household users? | Out of scope for MVP — single authorized account per deployment; flagged as a clear post-MVP direction requiring per-user encrypted token storage. |
| How often must the token be refreshed? | Standard OAuth2 refresh-token rotation per Kroger's documented TTLs — proactive + reactive detection and graceful pause on failure, same pattern as before but on a predictable, documented cycle instead of an empirically-observed unknown. |
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
    { "product_id": "0001111041600", "name": "Kroger Heavy Whipping Cream, 1pt", "price": 3.19, "rank_score": 0.81, "reason": "Most common default for 'cream' in savory/baking narration context" },
    { "product_id": "0001111041617", "name": "Kroger Half & Half, 1pt", "price": 2.39, "rank_score": 0.74 }
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
  "matched_product": { "product_id": "0001111051190", "name": "Kroger Boneless Chicken Thighs", "sold_by_weight": true, "package_estimate": "≈1.4 lb", "estimated_price": 6.29 },
  "display_note": "Sold by weight — actual weight and price confirmed at fulfillment"
}
```

### C. Partial-failure cart result
```json
{
  "job_id": "cart_2291",
  "status": "partially_completed",
  "results": [
    { "ingredient_id": "ing_01", "status": "added", "product_id": "0001111051190" },
    { "ingredient_id": "ing_04", "status": "added", "product_id": "0001111041600" },
    { "ingredient_id": "ing_09", "status": "needs_attention", "reason": "out_of_stock_at_cart_time" }
  ],
  "summary": "2 of 3 items added"
}
```
