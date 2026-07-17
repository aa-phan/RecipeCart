# Spec 3 — H-E-B Product Matching & Cart Automation

**Source PRD:** `component-3-heb-matching-cart-prd.md` (Draft v1, July 16, 2026)
**Siblings:** Spec 1 (Capture & Review) · Spec 2 (Extraction) · Spec 4 (Backend Platform) · `phases.md`
**Status:** Draft for review — July 16, 2026
**Phase tags:** `[P0]` risk spike · `[P1]` barebones pipeline · `[P2]` hardening · `[P3+]` service integration

## 1. Overview & Scope

Two deliberately separate modules sharing one Playwright adapter:

1. **Matcher** — eager, read-only: consumes Spec 2's recipe schema, searches H-E-B, ranks candidates. Runs automatically after extraction; safe to re-run anytime.
2. **Cart runner** — gated, mutating: adds *approved* items to the real cart. Triggered only by an explicit approval event, every time.

Permanent boundaries, enforced structurally, active from Phase 1 onward: **no checkout code path exists in the adapter**; CAPTCHA/login/MFA always pause and hand off to the human; automation paces itself like one careful user (sequential actions, one H-E-B session).

## 2. Technical Design

### 2.1 Playwright adapter `[P0 discovery, P1 build]`

A thin module owning every selector, so H-E-B markup changes are a one-file fix:

```
heb_adapter:
  login_guided()        → opens headed/embedded browser for the USER to log in; captures storage state only
  get_session_status()  → lightweight authenticated check (e.g., load account fragment); valid | expired | challenged
  set_store(location)   → verify/select fulfillment store; report active store
  search(query, store)  → [{product_id, name, size, unit_price, price, in_stock, sold_by_weight, brand, url}]
  read_cart()           → [{product_id, name, quantity, price}]
  add_to_cart(product_id, qty) → confirmed | failed(reason)   # performs read-after-write internally [P2]
```

- Selectors named and versioned in one registry (`selectors.ts`-style map), with expected-page assertions (URL pattern + key element) after every navigation/action; mismatch → pause + flag, never continue blind `[P2]`.
- No method navigates to `/checkout` or any payment surface — the absence of the code path is the safeguard, not a prompt or a flag.
- Pacing: configurable delay between actions (default 1.5–3s jittered), one browser context at a time.
- Claude computer-use as **classification-only fallback** `[P2, optional]`: when a selector fails, a screenshot + "what state is this page in" call informs which deterministic branch to take (retry / pause-for-user / fail). It never drives login, MFA, or CAPTCHA.

### 2.2 Matcher `[P1 basic, P2 full]`

Deterministic pipeline per ingredient:
1. Normalize canonical name + units (closed set: g/kg/oz/lb, ml/l/tsp/tbsp/cup/fl oz, count).
2. `search()` against the active store; **exclude** out-of-stock outright.
3. Rank: text/semantic relevance gate → product-form fit (shredded vs block; Claude-delegated when text is inconclusive) → quantity-to-package fit (closest-over preferred; large mismatch flagged, not excluded if it's the only option) → user preference boosts/filters `[P3, needs Spec 1 prefs]` → unit price tiebreak.
4. Purchase-quantity math from a deterministic conversion table (volume↔fl oz/ml; standard densities like flour ≈120g/cup). Smallest-package-covers rule; surplus is normal.
5. Pantry staples (Spec 2 flag): matched anyway, deprioritized + pre-unchecked — display default, not a matching shortcut.

**Claude-delegated judgments only** (never the deciding vote on cart mutation): ambiguous ingredient disambiguation ("cream" → heavy vs half-and-half, with candidates + ambiguity note), inconclusive form-matching, and **materiality** of a substitution. Materiality rule `[P2]`: same ingredient/different brand-size = *safe* (pre-selectable, always visible); different ingredient as stand-in = *material* (never pre-selected, labeled why). When in doubt → material.

Staleness `[P2]`: re-run search if the recipe has sat in `awaiting_review` past a config window (default suggestion: 24h) before a cart run uses its prices.

### 2.3 Cart runner `[P1 basic, P2 safeguards]`

1. Pre-flight: `get_session_status()` (proactive check) and `set_store()` mismatch detection — store changed since review → pause + confirm, don't mutate.
2. Fresh `read_cart()`; for each approved item: already present by product id → skip with note; present at different quantity → surface, never overwrite `[P2]`.
3. Sequential `add_to_cart()` per item with read-after-write confirmation `[P2]` — "no error" ≠ success.
4. Per-item transient retry (small cap); permanent failures (out of stock now, selector break) → `needs_attention` with reason, no auto-retry.
5. Terminal states: `completed` | `partially_completed` (first-class, itemized) | `failed` | `requires_user_intervention` (session/CAPTCHA/MFA — resumable, re-attempts only remaining items `[P2]`).
6. Idempotency `[P3]`: run bound to an approval event + idempotency key (Spec 4 §Idempotency); the fresh cart read is the second, independent duplicate guard.

### 2.4 Session management `[P1 local, P3 platform]`
- `login_guided()` captures **storage state only** — credentials never seen or stored.
- P1: storage state in a local encrypted file. P3+: `heb_sessions` row, encrypted with Spec 4's env-var key.
- Validity checked proactively (before cart runs) and reactively (mid-run auth failure); both → paused `requires login` state surfaced to Spec 1. Session lifetime is observed empirically, not assumed.

## 3. Data Contracts

- **In:** Spec 2 canonical recipe schema (ingredients: canonical name, quantity/unit, pantry flag, prep note). Spec 1 approvals/swaps/preferences `[P3]`.
- **Out:** candidate records and itemized cart results exactly as PRD C3 Appendix examples (ambiguous-ingredient candidates with `requires_user_approval` + `approval_reason`; weighted-item `package_estimate` + display note; duplicate-in-cart skip; partial-failure result). Events `[P3]`: `recipe.matching.completed` / `.degraded`, `cart.add.requested` / `.completed` / `.partial` / `.failed` per PRD C3 §23.

## 4. Setup & Environment

- **`[P0/P1]`:** Playwright + Chromium locally (headed mode for the login flow and for debugging selectors); an H-E-B account with the target store configured; local encrypted storage-state file; pacing/selector config file.
- **`[P4]`:** Chromium in the Docker image (Playwright's bundled build); headed login flow needs a story once cloud-hosted — see A3-5.

## 5. Open Action Items

- [ ] **A3-1 — Target store + fulfillment mode** (pickup vs delivery; whether the site's cart differs between them). Confirm from the P0 spike. Needed before P1.
- [ ] **A3-2 — Search reachable logged-out?** If yes, matching can run without burning session; if no, every match run consumes the session. P0 spike answers this; affects matcher design.
- [ ] **A3-3 — Materiality defaults.** Confirm the safe-vs-material line and the "when in doubt, material" bias before P2. Recommendation: accept as speced.
- [ ] **A3-4 — Pacing parameters** (inter-action delay, per-run item cap). Recommendation: 1.5–3s jittered, no hard item cap at single-recipe scale; tune from P0 observations.
- [ ] **A3-5 — Guided-login UX once cloud-hosted `[P4]`.** Options: (a) user logs in via a proxied/embedded browser view, (b) session bootstrapped locally and uploaded once, (c) re-login is rare enough that a documented local-capture ritual suffices for a private beta. Recommendation: (c) for MVP, decide after observing session lifetime. Needs confirmation before P4.
- [ ] **A3-6 — Search staleness window.** Recommendation: 24h default, config value.

## 6. Blockers (largest of any spec)

- **B3-1 — H-E-B site structure unknown** until the P0 spike: selectors for login, search, product tiles, cart. Everything in §2 assumes the spike documents these.
- **B3-2 — Anti-bot posture.** If heb.com blocks Playwright sessions outright (fingerprinting, persistent CAPTCHA), the design degrades to pause-and-hand-off constantly, which breaks the product promise. P0 must characterize this honestly.
- **B3-3 — Session lifetime** is empirical; short lifetimes (days) make A3-5 urgent rather than deferrable.
- **B3-4 — ToS review.** Automated access to TikTok and H-E-B may be restricted. For a personal tool on the user's own account this is a documented, accepted consideration (per PRD C3 §19), but a real review is recommended **before any scaling beyond personal use** — flag as a standing item, not a P0 gate.

## 7. Considerations

- **Setup:** Selector fragility is the dominant maintenance burden — the versioned selector registry plus the failure-reason breakdown metric (selector-miss vs CAPTCHA vs session vs stock) is the early-warning system; build both in P1 even in rough form. Chromium is the heaviest process in the whole system — this drives Spec 4's worker sizing.
- **Functionality:** Partial success is a *normal terminal state*, not an error — every consumer (CLI printout in P1, Spec 1 result screen in P3) must itemize per-item outcomes with reasons. Weighted items are estimates and must say so in the record itself, not just the UI. Dietary preference filters deprioritize conflicting products but never silently substitute a different ingredient — that's always a flagged material substitution (allergy-safety adjacent). Price drift between review and cart-add is disclosed above a small threshold but never blocks.
- **Metrics `[P3]`:** match acceptance rate (as-is/swapped/rejected) by category; % ingredients with ≥1 in-stock candidate; % high-confidence matches accepted unedited; material-substitution flag accuracy (flagged vs later corrected — the health check on the deterministic/Claude split); cart success/partial/fail rates; failure-reason breakdown; cart-job duration.
