# RecipeCart — Development Phases

**Product:** RecipeCart — TikTok Recipe → Kroger Cart Automation (working name)
**Companion documents:** `specs/spec-1-mobile-capture-review.md` · `specs/spec-2-tiktok-extraction.md` · `specs/spec-3-kroger-matching-cart.md` · `specs/spec-4-backend-platform.md` · the four component PRDs · `spike-notes.md` (Phase 0 findings, incl. the H-E-B → Kroger retailer pivot rationale)
**Status:** Draft for review — July 17, 2026 (retailer pivot from H-E-B to Kroger)

## Guiding principle

**Prove the pipeline before building the product around it.** The MVP is a barebones, local, CLI-driven pipeline that takes a TikTok URL and ends with items in a real Kroger cart. Only once that works end-to-end do we layer on the things that make it a product: quality/safety hardening, a backend service, a phone-friendly review UI, the iOS Shortcut, and cloud deployment. This inverts the instinct to build infrastructure first — the genuinely risky unknown (TikTok media access via yt-dlp) sits in the pipeline itself, and nothing else is worth building until it's de-risked.

**Why Kroger, not H-E-B:** the original design targeted H-E-B via Playwright browser automation. The Phase 0 risk spike found heb.com blocks CDP-driven automation outright (Akamai Bot Manager, confirmed across five configurations including a documented reference implementation's exact working recipe) — a hard block below the JS layer, not something a config change fixes. Kroger publishes an official, self-service Public API (OAuth2, no approval process) covering product search, store lookup, and cart-add — a real, sanctioned integration path with none of that risk. Full investigation: `spike-notes.md`.

Each spec tags its sections with the phase they belong to (`[P0]`–`[P5]`), so it's always clear what is MVP-core versus a later layer.

---

## Phase 0 — Risk Spike (gate; days, not weeks)

**Goal:** Answer the one remaining question that determines whether this product is buildable as designed, before writing durable pipeline code.

**Status: substantially complete.** The TikTok media spike and the (now-superseded) H-E-B automation spike both ran; see `spike-notes.md` for full findings, including the retailer-pivot investigation. What remains is lightweight Kroger developer setup, not a risk spike — the Kroger Public API is documented and self-service, so there's no "does this even work" unknown left to de-risk the way there was with H-E-B.

**Scope (completed):**
1. **TikTok media spike** (fed Spec 2 blockers B2-1/B2-2, now resolved): ran yt-dlp against real public TikTok recipe URLs, including a short link and a photo-mode post. B2-1 (standard video download) resolved cleanly. B2-2 (photo-mode) resolved as a confirmed, documented gap — yt-dlp doesn't retrieve slideshow images beyond a single cover thumbnail — already scoped to Phase 2, not a Phase 1 blocker.
2. **H-E-B automation spike** (superseded): found heb.com blocks Playwright automation outright, across five configurations. This finding is what drove the Kroger pivot — see `spike-notes.md` for the full technical investigation, including reading a public reference implementation's actual source code to rule out a config-based fix.

**Remaining before Phase 1 (setup, not a spike):**
- Register a free Kroger developer account and application (self-service — no approval process) to get `client_id`/`client_secret`.
- Confirm exact OAuth2 scope strings and token TTLs from Kroger's docs (Spec 3 A3-7).
- Look up the target store's `locationId` via the Locations API.

**Go/no-go:** Already exercised once, for H-E-B — see the guiding principle above. Kroger's Public API is documented and self-service, so there's no comparable "stop and rethink" risk gate remaining for Phase 1. If Kroger's actual API behavior meaningfully diverges from its documentation during Phase 1 setup, that would reopen this gate — but there's no reason to expect that going in.

---

## Phase 1 — Barebones Local Pipeline (the MVP core)

**Goal:** One real TikTok recipe becomes items in the real Kroger cart, end to end, on the developer's machine. No web service, no queue, no auth, no UI.

**Scope** (Spec 2 §Pipeline `[P1]` sections, Spec 3 §Matcher/§Cart-runner `[P1]` sections, Spec 4 §Local-first storage `[P1]`):
- A single CLI (`recipecart <tiktok-url>`) that runs: URL normalize → yt-dlp download (incl. caption) → caption ingredient-list check (Spec 2 §2.3a) → **if the caption suffices, skip straight to audio-only** → otherwise FFmpeg frames → frame dedup → OCR → FFmpeg audio → ASR → one Claude reconciliation call → structured recipe JSON (the Spec 2 canonical schema, even at this stage) saved to disk.
- Deterministic matcher: normalize ingredients, search Kroger's Products API (app-level Client Credentials token, no per-user auth needed), rank candidates, write a review file (JSON or rendered terminal table).
- Human review happens in the terminal or by editing the review file: the developer unchecks/swaps items by hand.
- On explicit confirm (`recipecart approve <recipe-id>`), the Kroger API client adds approved items via the Cart API (using the user's previously-authorized OAuth token) and prints itemized results.
- State in SQLite or flat files under a local data dir; secrets (Claude key, ASR/OCR keys, Kroger `client_id`/`client_secret`) in a local `.env`; the user's Kroger OAuth token pair (access + refresh) in a local encrypted file.

**Explicitly deferred:** retries, confidence UX, idempotency keys, pantry logic beyond a hardcoded list, preferences, deletion endpoints — anything not needed to complete one honest end-to-end run.

**Non-negotiable even here:** no checkout code path exists (structurally true — Kroger's Public API has no checkout endpoint); nothing is added to the cart without the explicit approve step; media temp files deleted after each run; no secrets in git.

**Exit criteria:** A real TikTok recipe URL → structured recipe with evidence → ranked Kroger candidates → manual approval → items visible in the real Kroger cart, with an itemized result printout. Total cost per run within the ~$0.05 Claude budget.

---

## Phase 2 — Pipeline Quality & Safety Hardening

**Goal:** Make the pipeline trustworthy, still local and CLI-driven. This is where the PRDs' extraction-quality and cart-safety requirements get fully implemented, while the iteration loop is still fast.

**Scope** (Spec 2 `[P2]` sections, Spec 3 `[P2]` sections):
- Full confidence/evidence model: per-field confidence bands, evidence references, `null`-with-reason for unevidenced fields, ambiguity flags and conflict rules (on-screen text preferred over narration and caption, all retained).
- Stated-vs-inferred dietary attribute split enforced at the schema level.
- Failure classification and retry policy (download failures, model-call failures, schema-validation corrective re-prompt, `not_a_recipe` result type).
- Vision-escalation scoring with the ≤8-frame cap — **done** (inverse-OCR-confidence weighting, early-frame bonus, always-include-earliest-frame rule).
- Photo-mode/slideshow reduced pipeline and deeper OCR/vision-escalation-path hardening — **reclassified as non-blocking future expansion (2026-07-19), not required for MVP-core.** Most real recipe TikToks put the full ingredient list in the caption, so the `caption_sufficient` gate (§2.3a) already covers the common case at zero vision cost; the OCR/frame-extraction/vision-escalation pipeline exists and works (built in Phase 1/2), but further investment in it — and photo-mode support specifically, which is additionally blocked on B2-2 (yt-dlp can't retrieve slideshow images past one cover thumbnail; a real fix means reintroducing Playwright/browser automation, the exact dependency the Kroger pivot eliminated — a product/architecture decision, not a code task) — is deferred until the MVP pipeline is proven end-to-end on caption-sufficient videos. Revisit once real usage shows caption-insufficient/photo-mode volume actually matters.
- Matching: safe-vs-material substitution split with Claude-delegated materiality judgment; pantry-staple classification and deprioritization; package-size/unit-conversion table; weighted-item estimates.
- Cart runner safeguards within the Kroger Public API's actual capabilities: idempotency-key-based duplicate prevention (the primary safeguard, since there's no cart-read endpoint at this tier — Spec 3 §17), rate-limit tracking against documented daily ceilings, token-expiry/revocation detection → paused state.

**Exit criteria:** The Spec 2 and Spec 3 acceptance criteria (mirroring PRD C2 §26 and the Kroger PRD C3 §26) pass against a test set of varied real, caption-sufficient TikToks (narration-only, non-recipe, conflicting quantities, vague quantities — the categories that exercise the pipeline as it's actually expected to run day to day). Extraction edit-worthiness is judged by hand — the developer would accept most recipes with minor edits. **Text-only (OCR-dependent) and photo-mode cases are non-blocking** per the reprioritization above — nice to validate opportunistically, not required to call Phase 2 done.

---

## Phase 3 — Backend Service + Minimal Web Review UI

**Goal:** Replace "developer at a terminal" with "phone browser," by wrapping the proven pipeline in the Component 4 service shape — still runnable locally.

**Scope** (Spec 4 `[P3]` sections, Spec 1 `[P3]` sections):
- `web`/`worker` split with Postgres (migrating off SQLite/flat files), the `jobs` queue table (`FOR UPDATE SKIP LOCKED`, single job at a time), the job-state machine, heartbeat/staleness requeue, graceful shutdown.
- The phone-facing REST API (Spec 4 endpoint table): submit, list, detail, ingredient edits, match selection, cart approve with `Idempotency-Key`, reprocess, delete.
- Device-token auth (hashed at rest), duplicate-URL detection, event log.
- Minimal mobile-responsive web app: Recipes list, Review screen (ingredients + proposed products, edit/swap/skip, confidence badges), cart approve, itemized Cart Result, failure cards. Polling for status. Preferences and Privacy screens can be stubs.
- Local run via Docker Compose mirroring the two-service shape.

**Exit criteria:** Submit a TikTok URL over HTTP (curl or a simple form), watch it progress by polling, review and approve on a phone browser pointed at the locally hosted app, items land in the cart. Idempotency verified: duplicate submit returns the existing job; duplicate approve never runs the cart twice.

---

## Phase 4 — iOS Capture + Cloud Deployment

**Goal:** The full "share from TikTok → review → cart" loop with nothing running on the dev machine.

**Scope** (Spec 1 `[P4]` sections, Spec 4 `[P4]` sections):
- iOS Shortcut: share-sheet entry, local TikTok-URL validation, POST with device token, native "Got it — processing" confirmation with a View-progress link.
- Single Dockerfile (yt-dlp, FFmpeg, OCR deps) with build caching — **no Chromium in the image**, a direct simplification from the Kroger pivot (Spec 3 §7): two Railway services from the one image; Railway-managed Postgres; worker volume for temp media with TTL sweep.
- Secrets as Railway env vars; Kroger OAuth token pair encrypted with an env-var key; log redaction by field name; `/health` + deploy checks; GitHub auto-deploy on push to main; external uptime ping.
- OAuth2 redirect URI updated to point at the deployed web app's real URL — this is the standard pattern, not a special cloud-hosting story (this resolves what would have been H-E-B action item A3-5; see Spec 3 §2.4).
- Web app installable to the home screen.

**Exit criteria:** From the phone, with the laptop closed: share a TikTok → confirmation within 2 seconds → later, review and approve in the web app → items in the Kroger cart. A `git push` redeploys both services; a worker restart mid-job requeues or cleanly fails the job. The Spec 4 deployment checklist is fully checked off.

---

## Phase 5 — Beta Polish & Readiness

**Goal:** Everything the PRDs promise for the private beta that isn't on the critical path of the pipeline itself.

**Scope** (Spec 1 `[P5]` sections, remaining items across specs):
- ✅ Preferences screen (store-brand/organic/dietary toggles, pantry always-owned list) wired into ranking. Done 2026-07-20.
- ✅ Privacy/Data screen; per-recipe delete and `DELETE /api/account/data` full wipe, verified end-to-end. Done.
- ✅ Reprocess action; duplicate-share "view existing or reprocess" flow; Kroger connect/reconnect (re-authorize) flows polished. Done 2026-07-20.
- ~~Accessibility pass: Dynamic Type, VoiceOver labels (confidence badges read aloud), 44pt targets, WCAG AA contrast.~~ **Explicitly deprioritized (2026-07-20) — open, non-blocking.** This is a hobby project with no ADA-compliance obligation; a full accessibility pass isn't worth the investment absent real user demand. Revisit if/when real usage or an actual accessibility need surfaces — this is the "documented, accepted exception" the exit criteria below already allows for, not a gap to silently work around.
- ✅ Operational drills: kill the worker mid-job and confirm recovery (already exercised for real during Phase 3 crash testing); Postgres backup restore, verified 2026-07-20 (local `pg_dump`/`pg_restore` drill, see `docs/deploy-railway.md` §E); log redaction verified with a real token probe, 2026-07-20 (see `docs/deploy-railway.md` §D); TTL sweep verified (1h sweep, confirmed working). All done.
- ✅ Walk all four PRDs' acceptance-criteria lists and record pass/fail. Done 2026-07-20 — see each `files/component-N-*-prd.md`'s own annotated Acceptance Criteria section for the full record. 28 criteria total: 19 passed outright, 2 are documented accepted exceptions (accessibility; the Shortcut's on-device URL-rejection check, unverifiable without a physical iPhone), and 7 real gaps found were fixed the same day (per-ingredient confidence now persisted/rendered; the 5-minute extraction timeout now actually enforced; `not_a_recipe` now gets its own friendly failure card instead of the generic one; quantity values now carry the same evidence/conflict guarantees every other field has; weight-sold estimate notes now rendered in both Review and Cart Result; Kroger rate-limit usage now logged/observable).
- ~~Evaluate whether real usage justifies a Kroger Partner-tier application (removes daily rate limits, adds cart-read access — Spec 3 "Known Limitations" L3-1/L3-2).~~ **Explicitly deprioritized (2026-07-20) — open, non-blocking.** Kroger's Public API tier's real limits (5,000 cart-adds/day, 10,000 product searches/day, no cart-read endpoint) are well beyond what a hobby/single-household usage pattern will ever hit, and Partner tier requires a separate business-approval process not worth pursuing without an actual reason. Revisit only if usage patterns genuinely change (e.g. opened up beyond one household and rate limits start to bite).

**Exit criteria: MET (2026-07-20).** All PRD acceptance criteria pass or have a documented, accepted exception (accessibility and the Kroger Partner-tier evaluation are the two formal exceptions — see above). **Phase 5 is done.** First trusted testers can be invited.

---

## Phase 6 — Visual Design

**Status: DONE (2026-07-20).** Implemented same-day as scoping, via 3 staged rounds of parallel
subagents (foundation → 6 parallel migration/build slices → 2 parallel contrast-audit passes).
Full design detail (exact token values, type scale, spacing ladder, receipt-treatment spec,
wordmark approach, and the real computed WCAG contrast tables) lives in `files/specs/
spec-5-visual-design.md` — this section is the phase-level summary only, mirroring Phases 1–5.

**Goal:** A real, considered visual identity for the web app — not fixing broken UX (Phase 5's
job), but replacing ad-hoc, screen-by-screen CSS with a single deliberate design system.
Added 2026-07-20 after an audit of `web/src/**/*.css` found zero shared tokens, 3 drifting
"error" reds and 3 drifting "success" greens for the same semantic role, no dark mode, no
type scale (an `em`/`rem` unit mismatch between screens), two screens shipping with zero CSS
at all, and placeholder-grade PWA icons with no favicon or wordmark.

**Scope** (Spec 5, all sections `[P6]`) — all done:
- ✅ A token system (`web/src/styles/tokens.css`): a named identity palette (Ink/Ink Muted/
  Paper/Cart Blue/Basil/Border) plus status colors, with real light AND dark values —
  `:root[data-theme="dark"]` + `@media (prefers-color-scheme: dark)`, a light/dark/system
  toggle added to the Preferences screen (`theme.ts`, `localStorage`-backed, applied
  synchronously before first render to avoid a theme-flash).
- ✅ A real display/body type pairing (Fraunces + Karla, self-hosted via `@fontsource`) and a
  consistent rem-based type scale, replacing the prior all-system-font, `em`/`rem`-mixed
  approach (including a real audited fix of `Review.css`'s em/rem drift).
- ✅ A disciplined 4px/0.25rem spacing ladder, replacing off-grid one-off values.
- ✅ Every screen and shared component (`ConfidenceBadge`, `StageLine`) migrated onto the token
  system; `ConnectKroger`/`FailureCard` (previously zero CSS) got real treatment from scratch;
  `Preferences.css`'s pre-existing rules (missed in the first migration pass, caught during
  integration) also migrated.
- ✅ The signature moment: a grocery-receipt-styled treatment on the Cart Result confirmation
  screen (CSS `clip-path` perforated edge, dotted-leader item rows, display-face pricing, a
  double-rule total line) — confined to that one screen, everywhere else stays disciplined.
- ✅ A typographic wordmark ("Recipe" in muted body weight, "Cart" in bold display-face brand
  blue) in the nav, plus a hand-authored SVG monogram favicon and real regenerated PWA icons
  (rasterized via a newly-added `sharp` dev dependency — no design tool was available in this
  environment, so this was built from scratch as part of the work).
- ✅ A real WCAG AA contrast validation pass on every token pairing, in both light and dark —
  narrower than Phase 5's full accessibility item (Dynamic Type/VoiceOver/44pt targets stay
  Phase 5 scope, and remain explicitly deprioritized there). This was a genuine audit, not a
  formality: it found and fixed real failures — `--color-border`/`--color-basil-border` were
  badly failing the 3:1 non-text threshold (as low as 1.23:1) against both surface colors, and
  `--color-error-border`/`--color-warning-border` were failing the same way; all four fixed.
  Full computed ratio tables live in `files/specs/spec-5-visual-design.md` §2.7.

**Exit criteria: MET.** Every screen renders from the token system (zero unintended raw hex
literals left in screen CSS, confirmed via a repo-wide sweep), both light and dark themes
render correctly, the Cart Result signature treatment is live, and every token color pairing
has a real, computed, passing WCAG AA contrast ratio on record.

---

## Phase 7 — Open Items / Backlog

**Status: not a build phase — a living, curated list.** Everything below was found and
documented across Phases 1–6 (real production incidents, live-tested findings, explicit
user defer-calls) but never given a home of its own; this section is that home. Pulled
together from the auto-memory log and the specs' own deferred/open markers so there's one
place to work from instead of five. Items get added here as they're found and removed once
actually resolved (move the resolution note to the relevant phase above, don't just delete
the line silently). Not prioritized/ordered — add priority/sequencing here as items get
picked up.

### Known issues (needs a fix or a concrete repro)

- **Local Whisper ASR OOM on caption-insufficient videos.** Real, measured: `transcribe()`
  alone peaks ~1.3–2GB against real audio, reliably exceeding the Railway worker's 1024MB
  limit — not one bad video, every caption-insufficient job hit this. As of 2026-07-21, ASR
  is hard-disabled in production (`ASR_ENABLED=false` on the worker service;
  `config.extraction.asrEnabled` in code) after a live incident where retries kept
  re-triggering worker crashes even with a per-job retry cap in place. Caption-insufficient
  jobs still get OCR, just no transcript. Options to actually re-enable, not yet pursued:
  bump the worker's memory tier; deeper ONNX Runtime session tuning (arena limits, smaller
  `chunk_length_s`, explicit inter-chunk cleanup); or accept local Whisper isn't viable in
  this resource envelope and drop it for good. See `recipecart-worker-asr-oom` memory for
  the full measurement writeup.
- **Ingredient merge/dedup.** The same ingredient (e.g. garlic powder) appearing in multiple
  recipe components (a meat rub AND a sauce) shows as separate review rows instead of one
  summed line — confirmed via a real production recipe, not a hypothetical. No merge/dedup
  rule exists anywhere in the pipeline today. A real fix needs matching on canonical name
  AND compatible unit (or a conversion table), summing only when units genuinely
  match/convert, falling back to separate rows otherwise. See
  `recipecart-ingredient-merge-backlog` memory.
- **Amount-edit re-match works "partially."** Editing an ingredient's quantity/unit on the
  Review screen is supposed to re-run product matching (`editIngredient` →
  `rematchIngredient`). A real root cause (missing `DATA_DIR` on the API service) was found
  and fixed (commit `e86863a`), but post-fix user testing found it still "works partially" —
  no confirmed repro yet (which ingredient, which amount change, what the UI showed vs.
  expected). Needs a concrete repro + a check of whether `rematchIngredient`/Kroger search
  calls actually fire on the edit before attempting another fix. See
  `recipecart-amount-rematch-partial` memory.
- **Worker volume usage** was at 442MB/500MB after the 2026-07-20 ASR-OOM crash-loop fix —
  not yet re-verified whether that's stable/expected or a slow leak (temp-media sweep should
  be cleaning `data/tmp/`, worth confirming it actually is).
- **First-time Setup doesn't route to Kroger connection.** Confirmed 2026-07-21 via a real
  second-user test: the Setup screen (device-token onboarding, `web/src/screens/Setup/
  Setup.tsx`) never mentions or links to Kroger at all — `ConnectKroger` is currently only
  reachable as a `FailureCard` recovery link (`kroger_not_connected`/`kroger_token_expired`),
  i.e. only AFTER a new user submits a recipe and hits a failure. A new user finishes Setup
  believing they're done, then hits a confusing failure later instead of being walked through
  Kroger auth as part of onboarding. Needs Setup to check connection status and route into
  the Kroger OAuth flow before (or right after) minting a device token — not just wait for a
  failure to surface it.

### Architecture: multi-tenancy

**Slice 1 — SHIPPED 2026-07-21 (code complete; needs Google Cloud credentials before it can
actually deploy — see below).** Real per-household accounts via Google sign-in
(`src/auth/google.ts`, `src/api/routes/google_auth.ts`), replacing the single hardcoded
`DEFAULT_USER_ID` as the only account that can ever exist. Resolved as part of this slice:

- ~~`POST /api/setup/device-token` is unauthenticated and unthrottled.~~ **Fixed.** The route
  no longer hardcodes `DEFAULT_USER_ID` or sets `skipAuth: true` — it's a normal authenticated
  route now (`request.userId`), used only to add an *additional* device once already signed in
  via Google. The standalone shared-passphrase gate built earlier the same day was explicitly
  reverted in favor of this real fix rather than shipping throwaway work (commits
  `341b25b`/`384f69c` reverted it; `google_auth.ts` + the `setup.ts` rewrite are the real fix).
- ~~"Delete my data" actually deletes everyone's data.~~ **Fixed.** `account.ts`'s
  `deleteFrom("recipes")` is now scoped via a subquery through `jobs.user_id` (recipes has no
  `user_id` column of its own — `recipes.id === jobs.id` by construction, so scoping goes
  through the job instead of a redundant column; see `migrations/005_multi_tenant_users.ts`'s
  header and `api/lib/ownership.ts`).
- **New, closed in the same pass, not previously tracked as its own item:** `recipes.ts`
  (`GET /`, `GET /:id`, `DELETE /:id`, the ingredient/match PATCH routes) and `cart.ts` (both
  routes) used to trust a URL id alone with no ownership check at all — any authenticated
  caller could read/edit/delete/approve-cart-for ANY user's recipe, not just their own. Fixed
  via `api/lib/ownership.ts`'s `requireOwnedJob`/`requireOwnedIngredient`, with real regression
  tests in `recipes.test.ts` proving cross-tenant isolation.
- Device/browser tokens being minted per-surface (adding the Shortcut vs. a browser) is
  unaffected by this slice and remains true by design — that was never the actual problem;
  the problem was that every token pointed at the same one account regardless of who was
  signing in. Real per-user identity now exists underneath the same per-device-token model.

**Explicitly still open (Slice 2, not yet started):** Kroger OAuth connection and store
location are still single-slot/shared across every account — `kroger_auth`/`store_config.ts`
untouched by Slice 1. Every account currently shares ONE real Kroger cart and ONE store.
**Don't invite a second real household to actually approve carts until Slice 2 lands.**

**Before Slice 1 can actually go live:** a Google Cloud OAuth client must be created (external
action, can't be done by an agent) — see `docs/deploy-railway.md`'s "8b. Set up Google
sign-in" step for the exact steps and the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
`GOOGLE_REDIRECT_URI`/`ALLOWED_EMAILS`/`OWNER_EMAIL` env vars that must be set on the `api`
Railway service before deploying. Until then this is implemented and tested but not deployed.

### Testing & CI gaps

- **The web app (React/Vite) has zero automated tests.** No vitest config in `web/`, no
  `*.test.tsx` files anywhere in `web/src`. All existing test coverage is backend-only —
  every screen/UI change (styling, new components, wiring) is currently verified by hand,
  not by any automated check.

### Cost & pricing watch (time-boxed — has a real deadline)

- **Sonnet 5 pricing cliff, 2026-08-31.** The `reconcile` call costs ~$0.046/recipe at
  introductory pricing ($2/$10 per MTok) — inside the ~$0.05/recipe budget (Spec 2 §2.5) but
  only ~9% margin. At standard post-introductory pricing ($3/$15 per MTok) it's
  ~$0.068/recipe, ~36% OVER budget. Needs a decision before the cliff: trim the
  evidence-per-field payload to cut output tokens, evaluate Haiku 4.5 for this call, or
  accept the higher price and raise the budget target in Spec 2. See
  `recipecart-sonnet5-pricing-cliff` memory — the $0.046 figure hasn't been re-benchmarked
  since Phase 2's prompt grew (confidence bands, conflict records), so re-measure before
  trusting it still holds.

### Deferred pipeline scope

- **Photo-mode/slideshow support + deeper OCR/vision-escalation hardening.** Reclassified
  2026-07-19 as non-blocking: most real recipe TikToks put the full ingredient list in the
  caption, so the `caption_sufficient` gate already covers the common case. The OCR/frame/
  vision-escalation pipeline exists and works (built in Phase 1/2) but isn't getting further
  investment. Photo-mode specifically is additionally blocked on yt-dlp only retrieving one
  cover thumbnail from a slideshow — a real fix means reintroducing Playwright/browser
  automation, the exact dependency the Kroger pivot eliminated (a product/architecture
  decision, not a code task). Revisit once real usage shows caption-insufficient/photo-mode
  volume actually matters.
- **Exit-gate test video curation** — narrowed to caption-sufficient categories (narration-
  only, non-recipe, conflicting/vague quantities), not text-only/photo-mode. Two known-good
  real URLs already in use: `@jalalsamfit/video/7564134038592605462`,
  `@shreddedandfed/video/7650230773512965393` — reuse these rather than re-finding test
  videos.
- **Self-hosted local LLM for `reconcile` instead of Claude.** Investigated and tabled, not
  rejected (Spec 2 §2.5a, `spikes/ollama-reconcile-spike.ts`, kept runnable): works
  reasonably on clean caption-only input, but 172s latency (vs. a 60-90s pipeline target) and
  imprecise evidence citations are real gaps, and it fabricated an entirely wrong recipe on
  noisy OCR input. Revisit with a vision-capable model and/or GPU-backed hosting.

### Post-MVP feature roadmap (consolidated from all four PRDs)

Not scheduled — revisit after the beta proves the loop: native iOS app with Share Extension
and APNs push; email digest; unified cross-recipe shopping list; backup-pick
pre-approval for out-of-stock items; per-ingredient product memory feeding ranking; manual
transcript-paste fallback; multi-video recipe stitching; evidence-image retention (requires
object storage); pinned-comment ingestion; repost detection; Redis/BullMQ queue and bounded
worker concurrency; staging environment; secret-rotation automation; Kroger Partner-tier
application (removes rate limits, adds cart-read).

---

## Cross-phase gates: action items that must be resolved before each phase

| Before phase | Must be decided/confirmed (see spec action-item IDs) |
|---|---|
| P0 | Nothing — start immediately. |
| P1 | Runtime language/framework (A4-1 — gates everything); OCR engine (A2-1) and ASR provider (A2-2); Anthropic API key + billing in place; Kroger developer account + registered app + target store `locationId` (A3-1); exact OAuth2 scopes/TTLs confirmed (A3-7). |
| P2 | Confidence-band thresholds accepted as speced (A2-4); material-substitution defaults (A3-3). |
| P3 | Web app framework (A1-1); polling interval (A1-3); Postgres migration approach (A4-2). |
| P4 | Railway account + plan (A4-3); domain/URL for the web app (A4-4); Shortcut token-provisioning flow (A1-2); OAuth2 redirect URI updated to the production URL. |
| P5 | Default pantry-staple list (A1-4); beta tester list and what "invite" means operationally. |
