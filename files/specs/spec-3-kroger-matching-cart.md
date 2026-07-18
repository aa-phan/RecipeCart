# Spec 3 — Kroger Product Matching & Cart Automation

**Source PRD:** `component-3-kroger-matching-cart-prd.md` (Draft v2, July 17, 2026 — retailer pivot from H-E-B)
**Siblings:** Spec 1 (Capture & Review) · Spec 2 (Extraction) · Spec 4 (Backend Platform) · `phases.md`
**Status:** Draft for review — July 17, 2026
**Phase tags:** `[P1]` barebones pipeline · `[P2]` hardening · `[P3+]` service integration

## 0. Why this spec replaces the original H-E-B version

The original design used a Playwright adapter driving heb.com directly. The Phase 0
risk spike (`files/spike-notes.md`) found that heb.com runs Akamai Bot Manager, which
blocks CDP-driven browser automation outright — a hard, unconditional deny before any
interaction, confirmed across five distinct configurations including a documented,
publicly-available reference implementation's exact working recipe. The block operates
below the JS layer (no launch-flag or user-agent change helped), so getting past it
would mean building TLS/network-fingerprint evasion tooling — a different and more
serious category of engineering than this product calls for, and exactly the
`phases.md` "stop and rethink" gate scenario.

**Kroger has an official, self-service, sanctioned Public API** covering everything
this component needs: product search (with price/stock/fulfillment/aisle data), store
location lookup, and — critically — a `PUT` add-to-cart endpoint on an authenticated
customer's real cart. Standard OAuth2, no browser automation, no anti-bot fight. This
spec is a full architectural replacement of §2 from the H-E-B version; the
deterministic matching logic (ranking, substitution rules, pantry handling) is
retailer-agnostic and carries over unchanged.

## 1. Overview & Scope

Two modules, same conceptual split as before, now backed by a single Kroger API
client instead of a Playwright adapter:

1. **Matcher** — eager, read-only: consumes Spec 2's recipe schema, searches Kroger's
   product catalog, ranks candidates. Runs automatically after extraction; safe to
   re-run anytime; **requires no per-user authentication at all** (Products/Locations
   use app-level Client Credentials — see §2.4).
2. **Cart runner** — gated, mutating: adds *approved* items to the real cart via the
   Kroger Cart API. Triggered only by an explicit approval event, every time.

Permanent boundaries, still active from Phase 1 onward, now structurally guaranteed by
the API surface itself rather than by adapter discipline alone: **no checkout code
path exists** — Kroger's Public API has no checkout/payment endpoint to call in the
first place, so this isn't just a design choice, it's not exposed to build against.

## 2. Technical Design

### 2.1 Kroger API client `[P1]`

A thin, typed HTTP client module — no browser, no selectors, no Chromium dependency
for this component at all:

```
kroger_client:
  build_auth_url(state)         → OAuth2 authorization URL for the customer-consent
                                   redirect (Authorization Code grant)
  exchange_code(code)           → {access_token, refresh_token, expires_in}
  refresh_token(refresh_token)  → new {access_token, expires_in}
  get_app_token()                → Client Credentials grant token, for Products/
                                   Locations calls (no per-user auth needed)
  search_products(query, locationId, token) →
      [{productId, description, brand, price, promoPrice, size, fulfillment:
        {instore, shiptohome, delivery, curbside}, aisleLocations, stockLevel,
        productPageURI}]
  search_locations(zipCode, radiusMiles) → [{locationId, name, address, chain}]
  add_to_cart(productId, qty, token) → 204 No Content | error(status, reason)
```

- **Two OAuth grant types, used for different purposes** — this is the one thing
  genuinely more complex than a single-token API: Client Credentials (app-level, no
  user involved) for `search_products`/`search_locations`; Authorization Code
  (per-user, standard login+consent redirect) for `add_to_cart` and the Identity API.
  Both are documented, standard OAuth2 — no custom logic to reverse-engineer.
- **Rate limits are documented and generous for personal use:** Products 10,000
  calls/day, Locations 1,600 calls/day/endpoint, Public Cart 5,000 calls/day. No
  action needed to stay under these at single-user volume.
- **No method can reach checkout** — not a discipline requirement, a structural fact:
  the Public API doesn't expose a checkout/payment endpoint, so there's no code path
  to accidentally build.

### 2.2 Matcher `[P1 basic, P2 full]`

Unchanged from the original design — this logic was always retailer-agnostic:

1. Normalize canonical name + units (closed set: g/kg/oz/lb, ml/l/tsp/tbsp/cup/fl oz,
   count).
2. `search_products()` against the active `locationId`, requesting Kroger's actual
   max page size (`filter.limit=50` — confirmed live: the API hard-rejects anything
   above 50, `PRODUCT-2013`). **Found via live testing: a smaller page size
   (previously 10) silently truncates the response before ranking ever runs** — a real
   covering package for "chicken breast" (3 lb) only appeared past position 10 in
   Kroger's own relevance ordering, so the matcher never saw it and wrongly flagged the
   ingredient `requires_approval`.
2b. **Orderability filter — `isOrderable()`, both conditions required.** An item is
   only a candidate if it is (a) not `TEMPORARILY_OUT_OF_STOCK` (when `inventory` is
   reported at all — it's frequently null, which is NOT treated as out-of-stock on its
   own) AND (b) has at least one `fulfillment` method true
   (curbside/delivery/inStore/shipToHome). **Found live, after a real cart add:** five
   selected items came back as "unavailable" in the actual cart. The clearest culprit —
   a "Philadelphia Garlic & Herb Cream Cheese" reporting `stockLevel: HIGH` but **all
   four fulfillment flags false** — is not orderable through any channel, yet the old
   code only checked `stockLevel` and added it. Requiring a live fulfillment method
   fixes that class outright. (Kroger's Products API availability signalling is
   imperfect; this is the strongest orderability signal it exposes, not a guarantee.)
2a. **Two-direction broadened fallback search**, tried in order, stopping at the first
   that returns anything, when EITHER (a) the specific-name search returned zero
   results outright — any ingredient category, not just core/quantified ones — or
   (b) a core (non-seasoning, quantified) ingredient's search found candidates but
   none covers the needed quantity:
   - **Trailing-word drop** (tried first): drop the last word of the canonical name
     (e.g. "garlic & herb cream cheese" → "garlic & herb cream"). Live-verified case:
     Kroger sells a same-flavor product under a different category name (a "gourmet
     cheese"/"spreadable cheese" rather than literally "cream cheese") that the
     exact-name query never surfaces. **Requires the dropped word to still appear in
     the candidate's description** (e.g. "cheese" must appear somewhere) — found live
     that omitting this let a completely wrong product ("Soules Kitchen Creamy Garlic
     & Herb CHICKEN") score identically to the real cheese alternatives, since
     "cream" fuzzy-matches "creamy" regardless of cheese vs. meat; requiring "cheese"
     specifically throws out the chicken while keeping the real matches.
   - **Leading-word drop** (tried second, only if the first found nothing): drop the
     *first* word instead (e.g. "Light Garlic & Herb Cream Cheese" → "Garlic & Herb
     Cream Cheese"). Live-verified case, found via a real cart-add: Kroger's search
     returned **zero results** for "Light Garlic & Herb Cream Cheese" verbatim from a
     real caption — and trailing-drop alone ALSO returned zero ("Cheese" wasn't the
     problem word; "Light" was). Dropping the leading word found real candidates.
     **Does NOT require the dropped word back** — unlike trailing-drop, the point of
     dropping a leading descriptive modifier ("Light"/"Fresh"/"Organic") is finding
     the product *without* that modifier, so requiring it back would defeat the
     broadening entirely; ordinary text-relevance scoring against the full original
     name is the safety net here instead. Deliberately stops at one word per
     direction — dropping to just the middle flavor words (e.g. "garlic herb")
     returned pasta sauce, seasoning shakers, and pork chops at the exact same
     text-relevance score as real matches, with no reliable way to tell them apart
     locally.

   **Any candidate found only via either broadened-search direction is always
   `requires_approval`, even if it would otherwise deterministically win its ranking
   (§2.2 step 3, or the smallest-package default for seasonings/no-quantity
   ingredients)** — it wasn't found under the ingredient's own name, so per this
   spec's existing materiality rule ("different ingredient as stand-in = material...
   when in doubt → material"), a human should confirm it's an acceptable substitute
   before it's ever added to a real cart. This is a local, deterministic safety net,
   not the actual Claude-delegated materiality judgment `[P2]` already scopes — it
   only ever makes a previously-invisible option visible and flagged, never makes the
   accept/reject call on its own.
3. Rank: text/semantic relevance gate → product-form fit (shredded vs block;
   Claude-delegated when text is inconclusive) → quantity-to-package fit (closest-over
   preferred; large mismatch flagged, not excluded if it's the only option) → user
   preference boosts/filters `[P3, needs Spec 1 prefs]` → unit price tiebreak.
   **For "core" ingredients with a usable quantity (not a seasoning, not
   no-stated-quantity — §2.2 step 3a), this is now a hard, deterministic bucket
   rule, not a blended score:** convert the needed quantity into the candidate
   package's unit, bucket candidates into "fully covers the need" vs "undersized"
   (a covering package ALWAYS outranks an undersized one, regardless of surplus
   size — `covers` field, `rank.ts`), then within the covering bucket pick the
   smallest surplus (closest-over), price as the final tiebreak. This replaced a
   blended `textScore*10 + qFit.score*3` ranking + a fixed `AMBIGUITY_MARGIN`
   gate, which — even after the density-conversion and seasoning fixes above —
   still routinely swallowed a real, correctly-computed quantity-fit signal: e.g.
   two same-size, different-price bottles of olive oil both "covering" the need
   scored identically on the blended metric and stayed stuck at
   `requires_approval` even though price alone cleanly picks a winner. Falls back
   to the old blended-score/margin check only when quantity-fit is un-computable
   for every candidate (e.g. a stated amount in a genuinely unparseable unit like
   "2 knobs") — there's nothing to convert toward in that case, so the
   deterministic rule doesn't apply. **Multi-package purchases and a name-relevance
   gate were added after this, both from live-data findings — see 3a/3b below.**
3a. **Multi-package purchase math.** "No package covers the need" is not, on its
   own, a reason to stop — `cli.ts`'s `approve` no longer hardcodes quantity 1 per
   ingredient (that P1 limitation is resolved; `addToCart`'s `quantity` param was
   already wired end-to-end, just never populated with anything but 1).
   `quantityFitScore` (rank.ts) now generalizes "closest-over" across N units of
   the same UNIT-sold package — e.g. a 1600g potato need from 20oz bags just means
   buying 3, the normal outcome, not a failure to match (note: this applies to
   fixed-`soldBy: UNIT` packages only — variable-weight items are handled by 3c).
   Capped at
   `MAX_AUTO_MULTI_UNIT_PURCHASE` (3): past that (or when even that many units of
   the best candidate still can't reach the need), it's not auto-resolved — still
   reported with the real unit count, but flagged `requires_approval` rather than
   silently generating an oddly large cart line. `ProductCandidate.quantityToOrder`
   carries this through to `cli.ts`'s `selectApprovedItems` → `ApprovedCartItem`.
3b. **Text-relevance gate ahead of fit-tightness, within a coverage bucket.**
   Found live: once multi-package math was added, "Kroger® Shaved Chicken" (a deli
   product — "breast" doesn't appear in its name at all) beat real "chicken
   breast" purely because 3×10oz landed a couple percentage points closer to the
   exact target than 2×1lb of the actual cut. Coverage bucket (§2.2 step 3) still
   decides first, but within a bucket, a text-relevance gap of at least
   `RELEVANCE_GAP_THRESHOLD` (0.2) now wins outright before fit-tightness or price
   ever get a vote — a candidate whose name is a clearly worse match for the
   ingredient can't win just because its package math is numerically tighter.
   The raw-vs-prepared gap this note originally flagged (e.g. plain potatoes vs a
   "Roasted Redskin Potatoes" side) is now largely addressed by the prepared-food
   penalty in 3c — though relevance still can't distinguish products that differ
   ONLY by a word not in the penalty list (a bare "potatoes" ingredient vs a
   frozen "Garlic Herb Baby Potatoes" side both score full relevance), so 3c leans
   on the `soldBy: WEIGHT` handling to keep plain produce/meat ahead there.
3c. **Variable-weight items, prepared-food penalty, and cheapest-price default —
   all three from a real cart add's fallout.** After a live `approve` put 20 items
   in a real cart, five were unavailable (fixed by 2b) and several were the wrong
   product; three coordinated ranking fixes:
   - **`soldBy: WEIGHT` items.** Kroger returns `size: "1 lb"` on weight-sold items
     as a *price-per-lb basis*, not a package size — the old multi-package math read
     it as a 1lb package and ordered "2" of a ~5lb variable-weight chicken breast
     pack for an 800g need. A WEIGHT-sold item is now modelled as what it is: one
     variable-weight package, ordered as **quantity 1** (which for a normal recipe
     amount over-covers; exact weight is set at pickup), treated as a valid qty-1
     covering fit so plain weight-sold meat/produce competes on equal footing with
     UNIT-packaged (often more processed) forms instead of being dropped below them.
   - **Prepared-food penalty (`PREPARED_KEYWORDS`).** A description containing a
     prepared/pre-flavored word (seasoned, marinated, roasted, breaded, achiote,
     rotisserie, "cracked black pepper", rinds, …) that the ingredient name does NOT
     ask for subtracts from its text-relevance score, so a plain product wins when
     one exists — but it's a penalty, not an exclusion, so a prepared product still
     surfaces (flagged) as a last resort. Deliberately excludes FORM words like
     "ground"/"shaved": those misfire on spices ("ground paprika" is the correct
     product, not a downgrade), and the WEIGHT handling + plain relevance already
     keep whole raw cuts ahead of ground/deli forms without them.
   - **Cheapest-price default** for seasonings / no-stated-quantity ingredients
     (§2.2 step 3a), replacing an earlier "physically smallest package" rule that
     live picked absurd specialty items — a 1.75oz "Florida Pure Sea Salt" ($8.99)
     over "Kroger® Salt" 26oz ($0.99), and a "Parmigiano Reggiano Rinds" (size
     "1 ct", magnitude 1) over real grated parmesan because a bare count sorted
     smaller than any weight. Ranking is now best-name-match first (same
     `RELEVANCE_GAP_THRESHOLD`), then cheapest total price — both more sensible and
     naturally free of those specialty-priced/degenerate-size outliers.
4. Purchase-quantity math from a deterministic conversion table (volume↔fl oz/ml;
   standard densities like flour ≈120g/cup). Smallest-package-covers rule; surplus is
   normal. **Implemented (`density.ts`) as a small, explicit per-ingredient density
   list, deliberately scoped to "core" bulk ingredients only** — meats, produce,
   flour, sugar, oil, dairy, etc. — where the stated recipe amount is a real
   purchasing decision (2 lb of chicken vs 5 lb; 2 cups of oil vs 1 tbsp). Used only
   to bridge `quantityFitScore` across the volume/weight category split for those
   ingredients (e.g. "2 cups flour" against a package sold in lb) — an ingredient not
   on the list gets no conversion (skip the fit boost, same as an unparseable unit),
   never a guessed density.
5. **Seasonings and no-stated-quantity ingredients both default to the cheapest
   well-matched product (§2.2 step 3a, refined in 3c) — skip quantity-fit scoring and
   the ambiguity-margin check entirely.** Two distinct triggers, same resulting
   behavior:
   - **No stated quantity** — a genuinely vague or absent amount (a vague phrase like
     "a pinch"/"to taste", or nothing stated at all) leaves nothing for
     `quantityFitScore` to score, so a text-score tie between near-identical branded
     options isn't real ambiguity — it's "there's nothing to decide on" masquerading
     as one.
   - **Known small-quantity seasonings** (`seasonings.ts` — salt, pepper, garlic/onion
     powder, paprika, chili flakes, dried herbs, etc.), **even when a real quantity
     IS stated** ("3 tsp salt"). Unlike core ingredients, no reasonable recipe amount
     of a seasoning changes which shaker/jar to buy — quantity-fit scoring a
     seasoning is a distinction without a purchasing difference, so these are folded
     into the same cheapest-well-matched default rather than routed through
     `density.ts`'s cross-category conversion at all. This was needed in practice,
     not just in theory: an end-to-end smoke test found nearly every spice-rack
     ingredient (salt, garlic powder, onion powder, paprika, chili flakes, Italian
     seasoning — all stated in tsp) getting zero (or negligible)
     quantity-fit signal against oz-labeled packages even after adding density
     conversion, which alone accounted for most of one real recipe's ingredients
     being flagged `requires_approval` for no real reason.

   Both cases resolve deterministically to the **best name match, cheapest total
   price as the tiebreak** (see 3c — this replaced an earlier "physically smallest
   package" rule that picked specialty-priced/degenerate-size outliers). The final
   price tiebreak is a swappable choice, not a quality judgment — an "organic" or
   other preference-based tiebreak is a natural `[P3]` extension once Spec 1
   preferences exist to drive it.
6. Pantry staples (Spec 2 flag): matched anyway, deprioritized + pre-unchecked —
   display default, not a matching shortcut.

**Claude-delegated judgments only** (never the deciding vote on cart mutation):
ambiguous ingredient disambiguation, inconclusive form-matching, and **materiality**
of a substitution. Materiality rule `[P2]`, unchanged: same ingredient/different
brand-size = *safe*; different ingredient as stand-in = *material*. When in doubt →
material.

Staleness `[P2]`: re-run search if the recipe has sat in `awaiting_review` past a
config window (default suggestion: 24h) before a cart run uses its prices.

### 2.3 Cart runner `[P1 basic, P2 safeguards]`

**One real design change from the H-E-B version:** the Public Cart API is
**write-only** — there is no `GET` cart-read endpoint at this tier (that exists only
in Kroger's Partner tier, which requires a separate business-approval process, not
pursued for this product). This removes the "fresh `read_cart()` before mutating" and
"re-read after write to confirm" patterns the original design relied on. Mitigations:

1. Pre-flight: confirm the stored access token is valid, refresh via `refresh_token`
   if near/past expiry — replaces `get_session_status()`.
2. `add_to_cart()` per approved item, sequential. **The API response is A
   confirmation signal, but NOT a fulfillment guarantee** — `204 No Content` = Kroger
   accepted the write; any other status carries a specific error reason. **Live-found
   caveat (2026-07-18):** a paprika UPC got a clean 204 accept, and Kroger's own
   Products search API still reports it `stockLevel: HIGH` / fully fulfillable right
   now — yet it showed as out-of-stock in the real cart. Kroger's fulfillment-time
   stock check evidently differs from both the search-time and write-time signals,
   and the write-only Cart API exposes no way to detect this at add time. The 204
   signal is real (stronger than "no error thrown" was in the original DOM-based
   design), just not as strong as originally documented here — it confirms Kroger
   *accepted the request*, not that the item will actually be fulfillable.
3. **No duplicate-in-cart detection is possible via API read at this tier.** Mitigated
   by: (a) idempotency key still prevents the same approval event from re-submitting
   on retry (Spec 4 §Idempotency) — this covers the case the original design's fresh
   cart-read was mainly guarding against; (b) the user can always see their real cart
   state in the Kroger app directly. A duplicate add from two *different* approval
   events (e.g. re-approving a recipe) is accepted as a known, minor limitation of the
   Public tier — flagged for revisit if it proves to be a real problem (§6).
4. Per-item transient retry (small cap); when Kroger actually REJECTS an add (a
   detectable failure — out of stock, invalid productId, etc.), **the next-ranked
   match candidate is tried automatically** (`ApprovedCartItem.fallbacks`,
   `cart_runner.ts`'s `addItemWithFallback`) before falling through to
   `needs_attention`. Stops immediately on a 401 (auth failure) without burning
   fallback attempts — that's a connection problem, not a product problem. Does
   **not** help the point-2 silent-accept case, since there's no rejection to react
   to; only the detectable-rejection case has a fallback path today.
5. Terminal states: `completed` | `partially_completed` (first-class, itemized) |
   `failed` | `requires_user_intervention` (token expired/revoked — resumable via
   re-authorization, re-attempts only remaining items `[P2]`).
6. Idempotency `[P3]`: run bound to an approval event + idempotency key (Spec 4
   §Idempotency) — now the primary duplicate guard, not a second layer behind a fresh
   cart read.

### 2.4 Authentication & token management `[P1 local, P3 platform]`

Replaces the original "guided browser login capturing storage state" entirely with
standard OAuth2:

- **Authorization Code grant** (Cart, Identity): the user is redirected to Kroger's
  own login+consent page — they authenticate directly with Kroger, never through this
  app — and redirected back with a code, exchanged for an access token + refresh
  token. This app never sees a Kroger password, same privacy property the original
  design had, achieved by a standard mechanism instead of a bespoke browser-capture
  flow.
- **Client Credentials grant** (Products, Locations): app-level token, no per-user
  interaction needed at all — matching can run with zero user connection.
- P1: refresh token stored in a local encrypted file (same encryption mechanism as
  before, smaller/simpler payload — a token pair instead of a full browser storage
  state blob).
- P3+: token pair stored in the `kroger_auth` table (replaces `heb_sessions`),
  encrypted with Spec 4's env-var key.
- **This resolves what was action item A3-5 in the original spec** ("guided-login UX
  once cloud-hosted" — previously deferred as an open question). An OAuth2
  authorization-code redirect works identically whether the redirect URI points at a
  local CLI callback server or the real deployed Phase 4 web app — this is the
  standard, well-solved pattern third-party web apps already use to integrate with
  OAuth providers. No special cloud-hosting story is needed.
- Access token expiry and refresh-token rotation are standard OAuth2 (specific TTLs to
  confirm from Kroger's docs during P1 setup) — a fundamentally more robust model than
  the original design's empirically-observed, potentially-short H-E-B session
  lifetime, and nothing like Akamai's ~11-minute `reese84` re-warming cycle.

## 3. Data Contracts

- **In:** Spec 2 canonical recipe schema (ingredients: canonical name, quantity/unit,
  pantry flag, prep note). Spec 1 approvals/swaps/preferences `[P3]`.
- **Out:** candidate records and itemized cart results, same shape as the original
  design's PRD Appendix examples (ambiguous-ingredient candidates with
  `requires_user_approval` + `approval_reason`; weighted-item `package_estimate` +
  display note; partial-failure result) — `product_id` values now come from Kroger's
  catalog instead of H-E-B's. The duplicate-in-cart example no longer applies at
  Public tier (§2.3). Events `[P3]`: `recipe.matching.completed` / `.degraded`,
  `cart.add.requested` / `.completed` / `.partial` / `.failed` per the PRD.

## 4. Setup & Environment

- **`[P0/P1]`:** a Kroger developer account (self-service, free — create account,
  verify email, register an application to get `client_id`/`client_secret`; no
  approval process, no waitlist) with the target store's `locationId` looked up via
  the Locations API; local encrypted token-storage file.
- **`[P4]`:** no Chromium/Playwright dependency for this component at all — removes
  the heaviest process from Spec 4's Docker image and worker sizing (§7). The OAuth
  redirect URI just needs to point at the deployed web app's real URL.

## 5. Open Action Items

- [ ] **A3-1 — Target store.** Look up via the Locations API (`filter.zipCode`); no
  pickup-vs-delivery ambiguity to resolve at the API level — `fulfillment` is returned
  per-product (`instore`/`shiptohome`/`delivery`/`curbside`), not a store-wide mode
  switch. Needed before P1.
- [ ] **A3-2 — Search reachable without per-user auth?** **Resolved: yes.**
  Products/Locations use Client Credentials — matching runs with zero user connection
  required, strictly better than the original open question ever hoped for.
- [ ] **A3-3 — Materiality defaults.** Unchanged, retailer-agnostic. Confirm before P2.
- [ ] ~~A3-4 — Pacing parameters.~~ **Obsolete** — no browser automation to pace; the
  API's documented daily rate limits are the only constraint, well within single-user
  volume.
- [ ] ~~A3-5 — Guided-login UX once cloud-hosted.~~ **Resolved by §2.4** — standard
  OAuth2 redirect, no special story needed.
- [ ] **A3-6 — Search staleness window.** Unchanged. Recommendation: 24h default,
  config value.
- [x] **A3-7 — Exact OAuth2 scope strings and token TTLs. RESOLVED — verified live**
  during P1 implementation (2026-07-18), not just read from docs: `product.compact`
  is the correct Client Credentials scope (Products/Locations); `cart.basic:write` is
  the correct Authorization Code scope (a guessed `profile.compact` scope was
  rejected by the authorize endpoint with `invalid_scope`, confirming this needed
  live verification rather than trusting the docs page). Client Credentials tokens
  expire in 1800s (30 min). Full OAuth2 loop (authorize → user login/consent →
  callback → code exchange → encrypted token storage) and a real `addToCart` call
  both completed successfully end-to-end against the live API and the target Dallas
  store — see `src/kroger/` and its test suite.

## 6. Known Limitations (replaces the original "Blockers" section)

The original spec's blockers (site structure unknown, anti-bot posture, session
lifetime, ToS risk) are **resolved by construction** — there's no scraping, no
fingerprinting fight, no empirically-observed session lifetime to worry about, and
using an official public API is squarely within Kroger's own developer terms. What
remains, genuinely new to this design:

- **L3-1 — No cart-read at Public tier.** Covered in §2.3; mitigated by idempotency
  keys, accepted as a known limitation. Revisit if duplicate-add-across-approvals
  proves to be a real problem in practice (would require a Kroger Partner-tier
  business-approval application to get read access).
- **L3-2 — Daily rate limits.** 5,000 cart-adds/day, 10,000 product searches/day —
  trivial at personal/private-beta scale, but a real ceiling if the product ever grows
  meaningfully past that (same Partner-tier path as L3-1 removes the limits entirely).
- **L3-3 — Two-account reality.** The developer needs both a registered Kroger
  developer/app account (for `client_id`/`client_secret`) and a normal Kroger
  customer account (the one that actually gets a cart) — not a blocker, just a setup
  step to be explicit about.

## 7. Considerations

- **Setup:** The dominant original operational risk — selector fragility against
  H-E-B markup changes — no longer exists; there's no markup to break against. Removes
  Chromium as the heaviest process in the system, meaningfully simplifying Spec 4's
  worker sizing and Docker image (no more "Chromium + ffmpeg + OCR deps" bulk from
  this component — just ffmpeg + OCR deps remain, from Spec 2).
- **Functionality:** Partial success remains a *normal terminal state*, not an error —
  unchanged. Weighted items are estimates and must say so in the record itself.
  Dietary preference filters deprioritize conflicting products but never silently
  substitute — unchanged, still allergy-safety-adjacent. Price drift between review
  and cart-add is disclosed above a small threshold but never blocks — unchanged,
  though now sourced from the Products API's `price`/`promoPrice` fields directly
  rather than a scraped page.
- **Metrics `[P3]`:** match acceptance rate (as-is/swapped/rejected) by category; %
  ingredients with ≥1 in-stock candidate; % high-confidence matches accepted unedited;
  material-substitution flag accuracy; cart success/partial/fail rates; failure-reason
  breakdown (now: out-of-stock vs invalid-product vs rate-limited vs token-expired,
  replacing the old selector-miss/CAPTCHA/session breakdown); cart-job duration.
