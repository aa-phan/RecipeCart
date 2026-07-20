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
- Operational drills: kill the worker mid-job and confirm recovery (✅ already exercised for real during Phase 3 crash testing); verify Postgres backup restore once and document it (open); confirm no secrets appear in logs with a real-token probe (open); TTL sweep verified (✅ done — 1h sweep, confirmed working).
- Walk all four PRDs' acceptance-criteria lists and record pass/fail.
- Evaluate whether real usage justifies a Kroger Partner-tier application (removes daily rate limits, adds cart-read access — Spec 3 §25).

**Exit criteria:** All PRD acceptance criteria pass or have a documented, accepted exception (accessibility is now formally one — see above). First trusted testers invited.

---

## Phase 6 — Visual Design

**Status: scoped, not yet implemented (2026-07-20).** Full design detail (exact token values,
type scale, spacing ladder, receipt-treatment spec, wordmark approach) lives in
`files/specs/spec-5-visual-design.md` — this section is the phase-level summary only, mirroring
Phases 1–5.

**Goal:** A real, considered visual identity for the web app — not fixing broken UX (Phase 5's
job), but replacing ad-hoc, screen-by-screen CSS with a single deliberate design system.
Added 2026-07-20 after an audit of `web/src/**/*.css` found zero shared tokens, 3 drifting
"error" reds and 3 drifting "success" greens for the same semantic role, no dark mode, no
type scale (an `em`/`rem` unit mismatch between screens), two screens shipping with zero CSS
at all, and placeholder-grade PWA icons with no favicon or wordmark.

**Scope** (Spec 5, all sections `[P6]`):
- A token system (`web/src/styles/tokens.css`): a named identity palette (Ink/Ink Muted/
  Paper/Cart Blue/Basil/Border) plus status colors, with real light AND dark values —
  `:root[data-theme="dark"]` + `@media (prefers-color-scheme: dark)`, a light/dark/system
  toggle added to the Preferences screen.
- A real display/body type pairing (Fraunces + Karla, self-hosted via `@fontsource`) and a
  consistent rem-based type scale, replacing the current all-system-font, `em`/`rem`-mixed
  approach.
- A disciplined 4px/0.25rem spacing ladder, replacing off-grid one-off values.
- Every screen and shared component (`ConfidenceBadge`, `StageLine`) migrated onto the token
  system; the two currently-unstyled screens (`ConnectKroger`, `FailureCard`) get real
  treatment for the first time.
- One deliberate signature moment, confined to a single screen: a grocery-receipt-styled
  treatment on the Cart Result confirmation screen (perforated card edge, dotted-leader item
  rows, display-face pricing, a total line) — everywhere else stays quiet/disciplined.
- A typographic wordmark for "RecipeCart" in the nav (no illustrated logo mark) and a real
  favicon/monogram replacing the current near-empty placeholder PWA icons.
- A WCAG AA contrast validation pass on every token pairing, in both light and dark — narrower
  than Phase 5's full accessibility item (Dynamic Type/VoiceOver/44pt targets stay Phase 5
  scope), but ensures the new palette doesn't hand that later pass a non-compliant baseline.

**Exit criteria:** Every screen renders from the token system (zero raw hex literals left in
screen CSS), both light and dark themes render correctly across every screen, the Cart Result
signature treatment is live, and every token color pairing passes WCAG AA contrast.

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

## Post-MVP roadmap (consolidated from all four PRDs)

Not scheduled — revisit after the beta proves the loop: **photo-mode/slideshow support and deeper OCR/vision-escalation-path hardening (reclassified 2026-07-19 — see Phase 2 scope above; MVP works from the caption-sufficient assumption, most real recipe videos qualify);** native iOS app with Share Extension and APNs push; email digest; multi-user/household accounts and multi-tenant Kroger tokens; unified cross-recipe shopping list; backup-pick pre-approval for out-of-stock items; per-ingredient product memory feeding ranking; manual transcript-paste fallback; multi-video recipe stitching; evidence-image retention (requires object storage); pinned-comment ingestion; repost detection; Haiku 4.5 evaluation for the reconciliation call; Redis/BullMQ queue and bounded worker concurrency; staging environment; secret-rotation automation; Kroger Partner-tier application (removes rate limits, adds cart-read); **self-hosted local LLM for reconciliation instead of Claude — investigated and tabled (Spec 2 §2.5a), real but partial results (works on the caption-sufficient happy path, too slow on CPU and evidence-citation precision needs work; vision-escalation path untested with a capable model) — revisit with a vision-capable model and/or GPU-backed hosting, not a dead end.**
