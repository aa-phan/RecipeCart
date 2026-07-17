# RecipeCart — Development Phases

**Product:** RecipeCart — TikTok Recipe → H-E-B Cart Automation (working name)
**Companion documents:** `specs/spec-1-mobile-capture-review.md` · `specs/spec-2-tiktok-extraction.md` · `specs/spec-3-heb-matching-cart.md` · `specs/spec-4-backend-platform.md` · the four component PRDs
**Status:** Draft for review — July 16, 2026

## Guiding principle

**Prove the pipeline before building the product around it.** The MVP is a barebones, local, CLI-driven pipeline that takes a TikTok URL and ends with items in a real H-E-B cart. Only once that works end-to-end do we layer on the things that make it a product: quality/safety hardening, a backend service, a phone-friendly review UI, the iOS Shortcut, and cloud deployment. This inverts the instinct to build infrastructure first — the two genuinely risky unknowns (TikTok media access via yt-dlp, H-E-B browser automation) sit in the pipeline itself, and nothing else is worth building until they're de-risked.

Each spec tags its sections with the phase they belong to (`[P0]`–`[P5]`), so it's always clear what is MVP-core versus a later layer.

---

## Phase 0 — Risk Spikes (gate; days, not weeks)

**Goal:** Answer the two questions that determine whether this product is buildable as designed, before writing any durable code.

**Scope:** Two throwaway scripts, run locally:

1. **TikTok media spike** (feeds Spec 2 blockers B2-1/B2-2): run yt-dlp against ~5 real public TikTok recipe URLs (including a `vm.tiktok.com` short link and a photo-mode post). Confirm download works, extract audio and frames with FFmpeg, eyeball frame quality at ~1000px long edge.
2. **H-E-B automation spike** (feeds Spec 3 blockers B3-1 through B3-4): with Playwright in headed mode, manually log in to heb.com, capture storage state, restart the browser with the saved state, confirm the session survives; then search a product, read the cart contents, and add one item. Note the DOM structure/selectors encountered, whether search works logged-out, what fulfillment options (pickup/delivery) look like, and any anti-bot friction.

**Exit criteria:**
- yt-dlp downloads current public TikToks reliably; frames/audio are usable.
- H-E-B login-session capture and reuse works; product search, cart read, and cart add are all reachable through stable-enough selectors.
- Findings written down (a short notes file is fine) and the affected blockers in Specs 2 and 3 marked resolved or escalated.

**Go/no-go:** If either spike fails fundamentally (e.g., H-E-B blocks automated sessions outright), stop and rethink before Phase 1 — the fallback conversations (different retailer, manual-paste extraction input, etc.) are cheaper to have now than after the pipeline is built.

---

## Phase 1 — Barebones Local Pipeline (the MVP core)

**Goal:** One real TikTok recipe becomes items in the real H-E-B cart, end to end, on the developer's machine. No web service, no queue, no auth, no UI.

**Scope** (Spec 2 §Pipeline `[P1]` sections, Spec 3 §Matcher/§Cart-runner `[P1]` sections, Spec 4 §Local-first storage `[P1]`):
- A single CLI (`recipecart <tiktok-url>`) that runs: URL normalize → yt-dlp download (incl. caption) → caption ingredient-list check (Spec 2 §2.3a) → **if the caption suffices, skip straight to audio-only** → otherwise FFmpeg frames → frame dedup → OCR → FFmpeg audio → ASR → one Claude reconciliation call → structured recipe JSON (the Spec 2 canonical schema, even at this stage) saved to disk.
- Deterministic matcher: normalize ingredients, search H-E-B via the Playwright adapter, rank candidates, write a review file (JSON or rendered terminal table).
- Human review happens in the terminal or by editing the review file: the developer unchecks/swaps items by hand.
- On explicit confirm (`recipecart approve <recipe-id>`), the Playwright cart runner adds approved items and prints itemized results.
- State in SQLite or flat files under a local data dir; secrets (Claude key, ASR/OCR keys) in a local `.env`; H-E-B storage state in a local encrypted file.

**Explicitly deferred:** retries, confidence UX, idempotency keys, pantry logic beyond a hardcoded list, preferences, deletion endpoints — anything not needed to complete one honest end-to-end run.

**Non-negotiable even here:** no checkout code path exists; nothing is added to the cart without the explicit approve step; media temp files deleted after each run; no secrets in git.

**Exit criteria:** A real TikTok recipe URL → structured recipe with evidence → ranked H-E-B candidates → manual approval → items visible in the real H-E-B cart, with an itemized result printout. Total cost per run within the ~$0.05 Claude budget.

---

## Phase 2 — Pipeline Quality & Safety Hardening

**Goal:** Make the pipeline trustworthy, still local and CLI-driven. This is where the PRDs' extraction-quality and cart-safety requirements get fully implemented, while the iteration loop is still fast.

**Scope** (Spec 2 `[P2]` sections, Spec 3 `[P2]` sections):
- Full confidence/evidence model: per-field confidence bands, evidence references, `null`-with-reason for unevidenced fields, ambiguity flags and conflict rules (on-screen text preferred over narration, both retained).
- Stated-vs-inferred dietary attribute split enforced at the schema level.
- Failure classification and retry policy (download failures, model-call failures, schema-validation corrective re-prompt, `not_a_recipe` result type).
- Vision-escalation scoring with the ≤8-frame cap; photo-mode/slideshow reduced pipeline; music-only handling.
- Matching: safe-vs-material substitution split with Claude-delegated materiality judgment; pantry-staple classification and deprioritization; package-size/unit-conversion table; weighted-item estimates.
- Cart runner safeguards: read-after-write confirmation, already-in-cart and differing-quantity detection, unexpected-page detection and pause, CAPTCHA/MFA/session-expiry detection → paused state, deliberate pacing.

**Exit criteria:** The Spec 2 and Spec 3 acceptance criteria (mirroring PRD C2 §26 and C3 §26) pass against a test set of ~10 varied real TikToks (narration-only, text-only, music-only, non-recipe, photo-mode, conflicting quantities, vague quantities). Extraction edit-worthiness is judged by hand — the developer would accept most recipes with minor edits.

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
- Single Dockerfile (yt-dlp, FFmpeg, Playwright + Chromium, OCR deps) with build caching; two Railway services from the one image; Railway-managed Postgres; worker volume for temp media with TTL sweep.
- Secrets as Railway env vars; H-E-B session storage-state encrypted with an env-var key; log redaction by field name; `/health` + deploy checks; GitHub auto-deploy on push to main; external uptime ping.
- Web app installable to the home screen.

**Exit criteria:** From the phone, with the laptop closed: share a TikTok → confirmation within 2 seconds → later, review and approve in the web app → items in the H-E-B cart. A `git push` redeploys both services; a worker restart mid-job requeues or cleanly fails the job. The Spec 4 deployment checklist is fully checked off.

---

## Phase 5 — Beta Polish & Readiness

**Goal:** Everything the PRDs promise for the private beta that isn't on the critical path of the pipeline itself.

**Scope** (Spec 1 `[P5]` sections, remaining items across specs):
- Preferences screen (store-brand/organic/dietary toggles, pantry always-owned list) wired into ranking.
- Privacy/Data screen; per-recipe delete and `DELETE /api/account/data` full wipe, verified end-to-end.
- Reprocess action; duplicate-share "view existing or reprocess" flow; H-E-B connect/reconnect flows polished.
- Accessibility pass: Dynamic Type, VoiceOver labels (confidence badges read aloud), 44pt targets, WCAG AA contrast.
- Operational drills: kill the worker mid-job and confirm recovery; verify Postgres backup restore once and document it; confirm no secrets appear in logs with a real-token probe; TTL sweep verified.
- Walk all four PRDs' acceptance-criteria lists and record pass/fail.

**Exit criteria:** All PRD acceptance criteria pass or have a documented, accepted exception. First trusted testers invited.

---

## Cross-phase gates: action items that must be resolved before each phase

| Before phase | Must be decided/confirmed (see spec action-item IDs) |
|---|---|
| P0 | Nothing — start immediately. |
| P1 | Runtime language/framework (A4-1 — gates everything); OCR engine (A2-1) and ASR provider (A2-2); Anthropic API key + billing in place; H-E-B account + target store (A3-1). |
| P2 | Confidence-band thresholds accepted as speced (A2-4); material-substitution defaults (A3-3). |
| P3 | Web app framework (A1-1); polling interval (A1-3); Postgres migration approach (A4-2). |
| P4 | Railway account + plan (A4-3); domain/URL for the web app (A4-4); Shortcut token-provisioning flow (A1-2). |
| P5 | Default pantry-staple list (A1-4); beta tester list and what "invite" means operationally. |

## Post-MVP roadmap (consolidated from all four PRDs)

Not scheduled — revisit after the beta proves the loop: native iOS app with Share Extension and APNs push; email digest; multi-user/household accounts and multi-tenant H-E-B sessions; unified cross-recipe shopping list; backup-pick pre-approval for out-of-stock items; per-ingredient product memory feeding ranking; manual transcript-paste fallback; multi-video recipe stitching; evidence-image retention (requires object storage); pinned-comment ingestion; repost detection; Haiku 4.5 evaluation for the reconciliation call; Redis/BullMQ queue and bounded worker concurrency; staging environment; secret-rotation automation.
