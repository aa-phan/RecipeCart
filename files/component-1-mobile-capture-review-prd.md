# Mobile Capture and Review Experience — Product Requirements Document

**Product:** RecipeCart — TikTok Recipe → H-E-B Cart Automation (working name, rename freely)
**Component:** 1 of 4 — Mobile Capture and Review Experience
**Sibling documents:** Component 2 (TikTok Media & Recipe Extraction) · Component 3 (H-E-B Product Matching & Cart Automation) · Component 4 (Backend Platform, Hosting & Orchestration)
**Scope:** Single user / small private beta (a handful of trusted testers)
**Status:** Draft v1 — July 16, 2026

### Shared assumptions this document relies on
These are decided once and held constant across all four PRDs so the pieces click together. Full rationale lives in Component 4.
- **No account system for v1.** A single device-bound access token identifies "the household." No email/password, no OAuth.
- **Status is pulled, not pushed, for MVP.** The web app polls the backend; push notifications arrive post-MVP with the native app.
- **Matching happens automatically, before the user asks for it.** As soon as extraction finishes, product candidates are computed in the background so the review screen never opens empty. Nothing is written to the real H-E-B cart until the user explicitly approves.
- **One review screen, one approval action.** Ingredients and proposed products are reviewed together, with a single "Add to cart" action at the end — not two sequential confirm steps.
- **Checkout is never automated**, in this component or any other.

---

## 1. Executive Summary
This component is the only part of the system the user directly touches. Everything else — media processing, extraction, product matching, cart automation — exists to make this experience possible: share a TikTok link, get a reviewed and editable grocery list, approve it, done. The bar for success is that using this app feels obviously faster than pausing a video to type ingredients into the H-E-B search bar by hand.

## 2. Problem Statement
Turning a TikTok recipe into groceries today means re-watching the video, manually transcribing ingredients and quantities (often narrated quickly or shown only as fast on-screen text), and then searching for each item one at a time in a grocery app — deciding on brand, size, and substitutions along the way. This is tedious enough that many recipes are saved and never cooked. The mobile component's job is to compress that entire manual workflow into: share → review → approve.

## 3. Product Goals
- Make sharing a TikTok recipe the only "capture" action required — no app-switching to paste a URL.
- Return an immediate, non-blocking acknowledgment every time, even before processing finishes.
- Present extracted ingredients and proposed products in a single, scannable review flow that clearly distinguishes "confident," "uncertain," and "guessed."
- Never let an automated substitution reach the cart without the user having seen it.
- Keep the user in full control of checkout at all times.

## 4. Non-Goals
- This component does not perform extraction, matching, or cart automation itself — it triggers and displays the results of Components 2–4.
- No support for non-TikTok sources in v1 (Instagram Reels, YouTube Shorts, etc.).
- No multi-user household accounts in v1 — single device/household identity only.
- No in-app checkout or payment — the H-E-B app/site owns checkout entirely.
- No recipe editing beyond ingredients (i.e., no rewriting cooking instructions/steps in v1; the product is about the grocery list, not a recipe-box app).

## 5. Target User
The private beta user is a mobile-first, iOS-based home cook who already saves TikTok recipes and is comfortable installing an iOS Shortcut. They are not necessarily technical, but the initial cohort (starting with the builder) will be. Design for "one trusted user and their household," not a general public audience — that reduces the need for robust onboarding, recovery-from-confusion flows, and support tooling in v1.

## 6. Primary User Journey
1. User is watching a recipe TikTok, taps **Share → RecipeCart** (the installed Shortcut) from the native share sheet.
2. The Shortcut does a cheap client-side sanity check (is this a `tiktok.com` / `vm.tiktok.com` link?), then POSTs the URL and device token to the backend.
3. Backend returns a job id immediately. The Shortcut shows a native "Got it — processing now" confirmation with a **View progress** link into the web app. No blocking wait, no spinner screen.
4. User can close TikTok and continue their day. The job processes in the background (Components 2 and 3).
5. User opens the web app whenever convenient — from the confirmation link, from a home-screen icon, or by returning later. The **Recipes** list shows the job as "Processing" with a lightweight status line ("Extracting ingredients…").
6. Once extraction and matching both complete, the card updates to "Ready to review."
7. User opens it into the **Review screen**: recipe title/source at top, editable ingredient list (with confidence and evidence) in the middle, proposed H-E-B products at the bottom, each already pre-selected where confidence is high.
8. User edits ingredients as needed (remove, adjust quantity, mark "I already have this"), swaps or rejects any proposed product they disagree with, then taps **Add N items to cart**.
9. Backend runs the cart-add job; the screen shows live-ish progress via polling ("Adding 8 of 12…").
10. Result screen reports a clean itemized outcome — added, skipped, needs attention — with a button to **Open H-E-B** to review the cart and check out there.

## 7. Secondary and Failure-State Journeys
| Scenario | Behavior |
|---|---|
| Shared link isn't a TikTok URL | Shortcut rejects it locally with a clear message before ever calling the backend. |
| Same TikTok URL shared twice | Backend detects the duplicate source URL and the app offers "View existing recipe" or "Reprocess" instead of silently creating a second job. |
| Video is private, deleted, age-restricted, or region-locked | Job fails at the download stage (owned by Component 2). Review screen is replaced with a plain-language failure card and a "Try a different link" action. |
| Extraction succeeds but overall confidence is low (e.g., music-only video, little on-screen text) | Review screen still renders with a persistent low-confidence banner encouraging the user to double check quantities before approving. |
| User has no H-E-B session connected yet when they reach "Add to cart" | Flow pauses with a "Connect your H-E-B account" prompt (guided login handled by Component 3/4), then resumes automatically once connected. |
| H-E-B session expires mid-cart-job | Job pauses in "Needs your attention" state; push/poll surfaces a "Please reconnect H-E-B" card; resuming re-attempts only the remaining items. |
| Cart job partially succeeds | Result screen always itemizes success/skip/attention — "partial success" is a normal outcome, not an error state. |
| TikTok or H-E-B automation is fully unavailable | Recipe stays saved in "Extracted" or "Matched" state indefinitely; user can retry later without re-sharing from TikTok. |

## 8. Functional Requirements
- Accept a TikTok URL via iOS Shortcut (MVP) and, later, a native Share Extension.
- Create a recipe-processing job and return a job id synchronously, before processing begins.
- Detect and surface duplicate source URLs.
- Poll job status and render state transitions (queued → processing → ready to review → cart in progress → cart result).
- Render extracted ingredients with quantity, unit, confidence badge, and a link/expand to evidence (transcript snippet or timestamp).
- Support per-ingredient actions: edit quantity/unit, remove, mark "already have it" (pantry override), add a manual ingredient.
- Render proposed product matches per ingredient: name, size, price, store-brand flag, confidence; support swap-to-alternate (from a short list), and explicit reject/skip.
- Trigger the cart-add job only on explicit user approval.
- Render cart results with per-item outcome and reasons for anything not added.
- Maintain a persistent, revisitable list of past recipes with their current state.
- Support recipe deletion (single item and "delete everything") with immediate effect on stored data.
- Support "Reprocess" to re-run extraction on an existing recipe's source URL.
- Provide a Preferences screen (store-brand, organic, dietary tags, pantry always-owned items).
- Provide a Privacy/Data screen describing what's stored and offering deletion controls.

## 9. UX and Interface Requirements
- **Taps to first confirmation:** 1 (the Shortcut action itself) — nothing else required to "capture" a recipe.
- **No blocking screens.** Every wait state is dismissible; the user can always navigate away and come back to a job in progress.
- **Confidence is never color-only.** Every confidence indicator pairs an icon/label with color, for accessibility and because color meaning ("is high confidence green or is available/in-stock green?") gets overloaded fast in this UI.
- **Substitutions are always visible, never silent.** Even a same-brand size swap is shown, just pre-approved when confidence is high; the user can always see what was decided on their behalf.
- **Duplicate-add protection.** The "Add to cart" action is disabled/idempotent while a cart job for that recipe is already in flight, and a recipe already fully added shows "Added" rather than offering to add again.
- **Recovery is always one tap away.** Every failure card offers a concrete next action (retry, reprocess, reconnect, try a different link, contact nothing — this is a private beta, so "recovery" means self-service, not a support ticket).

## 10. Screen-by-State Specification

### 10.1 Recipes List (Home)
```
┌─────────────────────────────────┐
│ RecipeCart                  ⚙  │
├─────────────────────────────────┤
│ ⏳ Brown Butter Cookies          │
│    Processing — extracting…      │
├─────────────────────────────────┤
│ ✅ Weeknight Chicken Tacos       │
│    Ready to review               │
├─────────────────────────────────┤
│ 🛒 Garlic Butter Shrimp          │
│    10 of 12 added — needs review │
├─────────────────────────────────┤
│ ✔️ Sheet Pan Salmon              │
│    All 9 items added             │
└─────────────────────────────────┘
```
Each row is tappable into the matching state below. Pull-to-refresh forces a poll; otherwise polling is automatic while the app is foregrounded.

### 10.2 Review Screen (ingredients + products, one flow)
```
┌─────────────────────────────────┐
│ ← Weeknight Chicken Tacos    ••• │
│  via @realtacotuesday · Serves 4 │
│  ⚠ Overall confidence: Medium    │
├─── INGREDIENTS ──────────────────┤
│ ✓ 1 lb    chicken thighs   ●high │
│ ✓ 8       small tortillas  ●high │
│ ⌂ 1 tsp   cumin  [pantry staple] │
│ ✓ ¾ cup   sour cream  “unclear   │
│           amount” · tap to fix   │
│                    [+ Add item]  │
├─── PROPOSED PRODUCTS ────────────┤
│ ☑ H-E-B Chicken Thighs, 1.4lb    │
│    $6.49 · $4.64/lb              │
│    [swap ▾]                      │
│ ☑ H-E-B Bakery Flour Tortillas   │
│    (8ct) — $2.79      [swap ▾]  │
│ ☐ Cumin — skipped (pantry)       │
│ ☑ H-E-B Sour Cream, 8oz — $1.89  │
│    ⚠ amount unclear — confirm    │
├───────────────────────────────────┤
│      [ Add 3 items to cart ]     │
└─────────────────────────────────┘
```

### 10.3 Cart Result
```
┌─────────────────────────────────┐
│ ← Cart Results                   │
│  Weeknight Chicken Tacos         │
├─────────────────────────────────┤
│ ✔️ Added (2)                     │
│   • Chicken Thighs               │
│   • Flour Tortillas              │
├─────────────────────────────────┤
│ ⚠ Needs attention (1)            │
│   • Sour Cream — out of stock    │
│     [ choose alternate ]         │
├─────────────────────────────────┤
│ [ Open H-E-B to finish shopping ]│
└─────────────────────────────────┘
```

### 10.4 Failure Card (generic pattern)
```
┌─────────────────────────────────┐
│ ⚠ Couldn't access this video     │
│                                   │
│  This TikTok looks private,      │
│  deleted, or region-restricted.  │
│                                   │
│  [ Try a different link ]        │
└─────────────────────────────────┘
```

## 11. Notification Requirements
- **MVP:** the Shortcut's own native "Show Result" alert on submission (no push infrastructure required), plus the persistent Recipes list as the source of truth the user returns to.
- **Post-MVP:** APNs push notification when a job reaches "Ready to review" or "Cart result," once a native app exists to register a device token; optional daily/weekly email digest of pending recipes as a fallback channel for users who don't have the app open.

## 12. Authentication and Session Requirements
- Single device-bound bearer token, generated on first web-app visit or first Shortcut run, stored as a secure HTTP-only cookie (web) and embedded in the Shortcut's stored text (client).
- Token maps to a `user_id` in the backend from day one (see Component 4) even though v1 has exactly one row — this avoids an auth rewrite if multi-user support is added later.
- Settings screen supports "Log out this device" (revokes the token) as the only session-management action needed for v1.
- The token authenticates *this app's* API only. It has no relationship to the user's H-E-B credentials, which Component 3/4 manage separately and never expose to this layer.

## 13. Accessibility Requirements
- Full Dynamic Type support; layouts must not clip or truncate at larger text sizes.
- VoiceOver labels on every interactive control, including confidence badges (e.g., "High confidence" read aloud, not just an icon).
- Minimum 44×44pt tap targets on all list actions (swap, remove, checkbox).
- Confidence and status communicated redundantly through icon + text + color, never color alone.
- Sufficient contrast (WCAG AA) for status text against card backgrounds.

## 14. Privacy Requirements
- The app stores: shared URLs, extracted recipe/ingredient data, product match decisions, cart results, and user preferences.
- The app does **not** retain raw video, audio, or extracted frames beyond the processing window (owned by Components 2/4; this component simply must not assume persistent media exists to display).
- A visible, plain-language explanation of what leaves the device and why (shown once, and always available from Settings) — TikTok URL and derived text go to the backend and to Claude for extraction; nothing is sent to H-E-B until cart-add time, and only the specific approved product list is sent then.
- Per-recipe delete and full-account "delete everything" are both one tap plus a confirmation, and take effect immediately.
- H-E-B session data is never surfaced to or stored by this component (owned by Component 3/4).

## 15. Analytics and Success Metrics
| Metric | Why it matters |
|---|---|
| Share → job-created latency | Confirms the "no blocking wait" goal is actually true. |
| Share → "Ready to review" time | Primary speed metric for the whole pipeline, as experienced by the user. |
| % jobs reaching "Ready to review" without failure | Overall pipeline health, from the user's vantage point. |
| Ingredient edit rate (edits per recipe) | Proxy for extraction quality — a rising edit rate signals a Component 2 regression. |
| % proposed products accepted with zero changes | Proxy for match quality — feeds back to Component 3. |
| Cart completion rate (items added / items approved) | Health of Component 3's automation layer. |
| Recipes abandoned before approval | Signals confusing review UX or low trust in the extraction. |

## 16. Error and Recovery Behavior
Every terminal or paused state maps to exactly one plain-language card and one primary recovery action. No raw error strings, stack traces, or backend status codes are ever shown to the user. Categories: video inaccessible (retry with different link), extraction failed (retry / reprocess), matching degraded (proceed with fewer/no product suggestions rather than blocking review), H-E-B not connected (connect flow), H-E-B session expired (reconnect flow), cart partially failed (itemized, not blocking), automation fully down (recipe stays saved, retry later).

## 17. Dependencies on the Other Three Components
- **From Component 2:** structured recipe JSON (ingredients, quantities, confidence, evidence references) and a distinct "not a recipe" result type so this UI can show a friendly message instead of a garbled ingredient list.
- **From Component 3:** ranked product candidates per ingredient (computed automatically post-extraction) and itemized cart-add results including failure reasons.
- **From Component 4:** the job/status API this screen polls, the auth/token system, storage of recipe history, and (post-MVP) the push-notification dispatch hook.

## 18. API and Data-Contract Expectations
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/recipes` | POST | Submit a TikTok URL (Shortcut entry point); returns `job_id`, `status` |
| `/api/recipes` | GET | List recipes/jobs for the Recipes screen |
| `/api/recipes/:id` | GET | Full detail: recipe, ingredients, matches, job status |
| `/api/recipes/:id/ingredients/:ingredientId` | PATCH | Edit quantity/unit, remove, mark owned |
| `/api/recipes/:id/ingredients` | POST | Add a manual ingredient |
| `/api/recipes/:id/matches/:ingredientId` | PATCH | Select alternate product or skip |
| `/api/recipes/:id/cart:approve` | POST | Trigger cart-add (requires `Idempotency-Key` header) |
| `/api/recipes/:id/cart` | GET | Cart result detail |
| `/api/recipes/:id/reprocess` | POST | Re-run extraction on the existing source URL |
| `/api/recipes/:id` | DELETE | Delete recipe and associated data |
| `/api/preferences` | GET/PATCH | Store-brand, organic, dietary, pantry defaults |
| `/api/heb/session` | POST/GET | Start guided H-E-B login; check connection status |
| `/api/account/data` | DELETE | Full data wipe |

All mutating endpoints that a flaky mobile connection might retry (`cart:approve` especially) require an idempotency key so a duplicate network retry never double-triggers cart automation.

## 19. MVP Scope
iOS Shortcut entry point; mobile-responsive web app for review (installable to home screen); single combined Review screen; device-token auth; polling-based status; itemized cart results; recipe history with delete controls; basic Preferences (store-brand/organic/dietary toggles, pantry always-owned list).

## 20. Post-MVP Roadmap
Native iOS app with Share Extension; push notifications; email digest; multi-user/household accounts; unified shopping list merging duplicate ingredients across pending recipes; backup-pick selection for out-of-stock items; manual transcript-paste fallback when a video can't be accessed; per-ingredient "always use this product" memory surfaced in-app.

## 21. Acceptance Criteria
- Sharing a valid TikTok URL via the Shortcut produces a visible confirmation within 2 seconds, without waiting on extraction.
- Sharing an invalid (non-TikTok) URL is rejected locally with no backend call.
- Re-sharing an already-submitted URL surfaces "existing recipe" rather than creating a duplicate job.
- Every ingredient shown in Review carries a confidence indicator and is editable.
- No product is added to the H-E-B cart without the item being visible and approved (implicitly via pre-selection or explicitly) in the Review screen first.
- A partial cart-add result always lists every unadded item with a reason.
- Deleting a recipe removes it from the list and from the backend within one request/response cycle.
- All primary flows are operable via VoiceOver and at the largest Dynamic Type setting.

## 22. Open Questions and Recommended Decisions
| Question | Recommendation |
|---|---|
| Shortcut, PWA, or both? | Both — Shortcut is the fastest-to-build MVP entry point (native share sheet, no App Store review); the web app is needed regardless as the review surface, and installs to the home screen at near-zero extra cost. Native app deferred until the flow is validated. |
| Polling, push, email, or status page? | Polling + the persistent Recipes list *is* the status page for MVP. Push/email are post-MVP, once a native app exists to hold a device token. |
| Is account creation needed for v1? | No — a single device token is sufficient for a private beta of one household. |
| How should pantry staples appear in review? | Shown but auto-deprioritized (pantry-staple chip, pre-unchecked for cart-adding), never hidden — user can always override. |
| How do users specify organic/store-brand/dietary/budget preferences? | A small global Preferences screen (toggles, not per-purchase forms) plus per-item override via the swap action; hard budget caps deferred post-MVP. |
| How should unknown-quantity ingredients be reviewed? | A distinct "amount unclear" badge (not folded into low-confidence), defaulting to the smallest reasonable purchase unit, always flagged for confirmation rather than silently guessed. |
| How should duplicate ingredients across recipes be handled? | Out of scope for MVP — each recipe's cart action is independent. Flagged as a known limitation; unified list merging is post-MVP. |
| How should partial cart additions be communicated? | Always itemized with per-item reason, never summarized as a single pass/fail. |
| Should the app store recipe history? | Yes — recipe/ingredient/match data persists until the user deletes it; raw source media never persists beyond processing. |
| Should users be able to resubmit/reprocess? | Yes — an explicit "Reprocess" action re-runs extraction on the stored source URL without requiring a fresh share from TikTok. |
