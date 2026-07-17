# Spec 1 — Mobile Capture & Review Experience

**Source PRD:** `component-1-mobile-capture-review-prd.md` (Draft v1, July 16, 2026)
**Siblings:** Spec 2 (Extraction) · Spec 3 (Matching & Cart) · Spec 4 (Backend Platform) · `phases.md`
**Status:** Draft for review — July 16, 2026
**Phase tags:** `[P1 interim]` terminal review stand-in · `[P3]` web review app · `[P4]` iOS Shortcut · `[P5]` polish

## 1. Overview & Scope

The only user-facing surface: an iOS Shortcut for capture and a mobile-responsive web app for review/approval. **Deliberately a rendering layer, not a logic layer** — every behavior this UI shows (confidence badges, swap candidates, itemized cart results, pantry deprioritization) must already exist as data in the pipeline output from Phase 1. In Phases 1–2 the "review experience" is a terminal table / editable JSON file; this spec defines what that interim format must already carry so the P3 web app is a re-skin, not new plumbing.

## 2. Technical Design

### 2.1 Interim review contract `[P1]`
The P1 CLI review output must include, per ingredient: confidence band + evidence snippet, quantity/unit with the distinct **"amount unclear"** flag (not folded into low confidence), pantry-staple flag (pre-unchecked), and per-candidate product info (name, size, price, unit price, store-brand flag, `requires_user_approval` + reason, weighted-item estimate note). If the terminal version can't show it, the web version won't be able to either — this is the forcing function.

### 2.2 iOS Shortcut `[P4]`
- Share-sheet entry accepting URLs; local regex check for `tiktok.com` / `vm.tiktok.com` — non-TikTok links rejected on-device with a clear message, **no backend call**.
- `POST /api/recipes` with the device token (stored in the Shortcut's text field at install) — returns `job_id` synchronously; Shortcut shows native "Got it — processing now" with a View-progress link to the web app. Target: confirmation within 2s of the share tap.
- Duplicate response (`existing recipe`) → Shortcut offers "View existing" link; the web app owns the "view / reprocess" choice.
- Token provisioning (A1-2): first web-app visit generates the token; a setup page displays it + a one-tap "copy into Shortcut" instruction, or the Shortcut is distributed pre-configured for the single-household beta.

### 2.3 Web app `[P3]`
- Mobile-responsive, installable to home screen (manifest + icons `[P4]`). Framework per A1-1; complexity is modest (5 screens, polling) — any mainstream choice works.
- **Auth:** device token as secure HTTP-only cookie set on first visit; all API calls through Spec 4's authenticated surface.
- **Polling:** while foregrounded, poll the recipes list / active job every ~3–5s with backoff when idle (A1-3); pull-to-refresh forces a poll; stop when backgrounded. Polling *is* the notification system for MVP — the persistent Recipes list is the source of truth.
- **Screens → job states** (state machine owned by Spec 4 §2.3):
  | Screen | States rendered |
  |---|---|
  | Recipes list | all — plain-language stage line per card ("Extracting ingredients…") |
  | Review | `Awaiting review` — ingredients + proposed products, one flow, one approve action |
  | Cart progress | `Adding to cart` — "Adding 8 of 12…" via poll |
  | Cart result | `Completed`/`Partially completed` — itemized added / skipped / needs-attention with reasons |
  | Failure card | `Failed` — one plain-language card + one recovery action per failure class; never raw errors |
  | Connect H-E-B | `Requires user intervention` (session) — guided login (Spec 3), resume on success |
  | Preferences `[P5]` | store-brand/organic/dietary toggles, pantry always-owned list |
  | Privacy/Data `[P5]` | what's stored + why; per-recipe delete; full wipe |

### 2.4 Review screen behavior `[P3]`
- Layout per PRD §10.2: title/source/serves + overall-confidence banner → editable ingredients → proposed products → single **"Add N items to cart"**.
- Ingredient actions: edit quantity/unit, remove, mark "already have it," add manual ingredient (`PATCH`/`POST` per Spec 4 API). Product actions: swap from candidate list, reject/skip (`PATCH /matches/:iid`).
- Confidence rendering: **icon + label + color, never color alone**; "amount unclear" is its own badge defaulting to smallest reasonable purchase unit, always flagged for confirmation. Inferred dietary tags rendered visually subordinate to stated ones (Spec 2 schema-level safety rule). Material substitutions never pre-checked; safe swaps pre-checked but visible.
- Evidence expand: tap a badge → transcript snippet / timestamp from the evidence refs.
- Low overall confidence → persistent banner, still renders. Matching degraded → review proceeds with fewer/no suggestions rather than blocking.
- **Duplicate-add protection:** approve button disabled/idempotent while a cart run is in flight (client sends the `Idempotency-Key`; generated per approval tap, reused on retry); fully-added recipes show "Added."

### 2.5 Accessibility `[P3 baseline, P5 pass]`
Dynamic Type without clipping; VoiceOver labels on every control including badges ("High confidence" spoken, not an icon name); ≥44×44pt targets on list actions; WCAG AA contrast; status conveyed icon + text + color redundantly.

## 3. Data Contracts

Consumes: Spec 4 REST API (canonical table in Spec 4 §2.5), Spec 2 recipe schema (confidence/evidence/dietary fields), Spec 3 candidate + cart-result records. Produces: ingredient edits, match selections, the approval event, preference values. Every ingredient edit is logged server-side as an extraction-quality signal (Spec 2 §8).

## 4. Setup & Environment

- `[P3]`: frontend toolchain per A1-1; served by or beside the Spec 4 `web` service; local testing on a phone against the Docker Compose stack (LAN IP or tunnel).
- `[P4]`: iOS Shortcuts app (no App Store review, no dev account needed); web manifest/icons for home-screen install; production URL (Spec 4 A4-4).

## 5. Open Action Items

- [ ] **A1-1 — Web framework.** Recommendation: keep it light — server-rendered pages + a sprinkle of JS (e.g., htmx/Alpine) or a small React/Vite SPA, in the same language as A4-1 (if TypeScript/Node, a React SPA or SSR framework is natural). Decide at P3 start.
- [ ] **A1-2 — Shortcut token provisioning.** Recommendation: pre-configured Shortcut for the household beta (simplest); a setup page with copyable token as the general path. Before P4.
- [ ] **A1-3 — Polling cadence.** Recommendation: 3s while a job is active, 15s idle-foreground, paused backgrounded. Before P3.
- [ ] **A1-4 — Default pantry-staple always-owned list** (salt, pepper, olive oil, …). Recommendation: seed ~15 common staples, user-editable in Preferences. Before P5.
- [ ] **A1-5 — PWA depth.** Recommendation: manifest + icons only (installable); skip service-worker offline support — the app is useless offline anyway. Before P4.
- [ ] **A1-6 — "Review everything" preference** (PRD C3 §27 mentions an opt-in stricter mode where nothing is pre-selected). Recommendation: defer to P5 or post-MVP; default behavior first.

## 6. Blockers

- **B1-1 — Spec 4 API must exist** before P3 UI work; mitigate with contract-first development (the endpoint table is already fixed — a stub server unblocks UI work if schedules ever overlap).
- **B1-2 — H-E-B connect-flow UX depends on Spec 3's A3-5 decision** (how guided login works once cloud-hosted). The web app's "Connect H-E-B" screen can't be finalized until that lands.
- **B1-3 — iOS Shortcut capability check `[P4]`:** confirm Shortcuts can do the POST + stored-token + result-alert flow as designed (high confidence it can; verify early in P4 with a 30-minute prototype).

## 7. Considerations

- **Setup:** Test on a real iPhone early and often — share-sheet ergonomics, Dynamic Type, and home-screen install behavior don't reproduce in a desktop browser. The Shortcut is a distribution artifact (an `.shortcut` file / iCloud link), so version it alongside the repo.
- **Functionality:** Every wait state is dismissible — no blocking screens anywhere; the user can always leave and return via the Recipes list. Every failure card = one plain-language message + one concrete recovery action (retry / reprocess / reconnect / different link) — no raw backend errors, ever. Substitutions are never silent: pre-approved when safe, but always visible. Partial cart success is a normal outcome and always itemized. Deletion (single recipe, full wipe) is one tap + confirm and takes effect within the request cycle.
- **Metrics (rendered from Spec 4 data, `[P5]`):** share→job latency, share→ready-to-review time, % jobs reaching review, ingredient-edit rate (Spec 2 regression signal), % products accepted unchanged (Spec 3 signal), cart completion rate, abandoned-before-approval rate.
