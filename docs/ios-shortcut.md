# iOS Shortcut Build Guide — RecipeCart Capture

> **This is a human build guide, not automation.** Nothing in this repo can
> construct, install, or verify an iOS Shortcut — the Shortcuts app only
> exists on a real iPhone. A person must follow the steps below on their own
> device. This doc's job is to be precise enough that they don't have to
> guess at endpoint shapes, header names, or field names — every request/
> response detail below was read directly out of the current route/auth
> code (`src/api/routes/recipes.ts`, `src/api/lib/auth.ts`,
> `src/api/lib/dto.ts`, `src/api/server.ts`) on 2026-07-19, not inferred
> from the spec. Where the spec (`files/specs/spec-1-mobile-capture-review.md`
> §2.2) says something slightly different from the real code, that's called
> out explicitly rather than silently reconciled.

## 1. Overview

The Shortcut is RecipeCart's only capture surface (Spec 1 §1). It runs from
the iOS share sheet: while watching a recipe video in the TikTok app, the
user taps Share → RecipeCart. The Shortcut validates the link is a TikTok
URL entirely on-device, then POSTs it to the RecipeCart API, which enqueues
a background processing job and returns immediately. The Shortcut shows a
native confirmation ("Got it — processing now") with a link into the web
app to watch progress. The slow work (video download, OCR/ASR, Claude
extraction, product matching) all happens later in the worker — the
Shortcut's own round trip only has to wait on job creation, so the target
is a confirmation within 2 seconds of the share tap (Spec 1 §2.2).

## 2. Prerequisites

- **A device token.** Visit `/setup` on the deployed web app (e.g.
  `https://<your-production-domain>/setup`) and click "Generate device
  token." This mints a fresh token, displays it once for copying, and —
  as of this session — also logs the browser you're viewing it in in
  automatically (it sets an HttpOnly auth cookie server-side in the same
  response, so there's no separate paste-it-back-in step for the browser).
  The Shortcut still needs the raw value copied into its "Get device token"
  step below, since a Shortcut can't read a cookie.

  A CLI fallback still exists if you have shell access to the machine
  running the API (`npm run cli -- create-device-token`, or `node
  dist/cli.js create-device-token` against a built image) — same
  crypto/storage under the hood as `/setup`, just without a browser.

  Either way, only the SHA-256 hash is stored server-side — if the token is
  lost, generate a new one.

  **Important caveat found in the code, not the spec:** minting a token
  writes to a single hardcoded `DEFAULT_USER_ID` row (see
  `src/platform/database.ts`). There is currently only one device-token
  "slot" in the whole system. Minting again **overwrites** that same
  user's token — it does not mint a second, independent token for a second
  household member. Anyone who already built a Shortcut with the old token
  will start getting 401s the moment someone else generates a new one.
  Until per-user tokens exist, treat token minting as a one-time,
  whole-household event, or coordinate before re-running it.

- **The API's base URL.**
  - Local-network testing (before Phase 4 cloud deploy): `http://<lan-ip-of-the-machine-running-the-api>:3001` — replace `<lan-ip>` with that machine's LAN IP (e.g. `192.168.1.42`). Port `3001` is confirmed from `src/api/index.ts` / `src/platform/config.ts`: `apiPort` defaults to `3001`, overridable via the `PORT` or `API_PORT` env vars — if either is set when the API process is started, use that value instead. The iPhone and the API host must be on the same Wi-Fi network.
  - Production: the deployed API's public HTTPS URL, once Phase 4 deploy lands. Update the Shortcut's URL text field when that changes.

## 3. Step-by-step Shortcut build

Open the **Shortcuts** app → **+** (new shortcut) → rename it something
like "Add to RecipeCart".

### 3.1 Accept the share-sheet input

1. Tap the shortcut's settings (the "i" / details icon) → enable **"Show
   in Share Sheet"**.
2. Under **Share Sheet Types**, restrict accepted input to **URLs** (and
   **Text**, as a fallback — TikTok sometimes shares a caption+link as
   plain text depending on iOS version/app version).
3. As the first action in the shortcut, add **"Receive [URLs, Text] input
   from Share Sheet"** (Shortcuts auto-adds a placeholder for this when
   "Show in Share Sheet" is on — confirm it's configured for URLs and
   Text). This gives you a `Shortcut Input` variable to reference below.

### 3.2 On-device TikTok validation (no network call)

Per Spec 1 §2.2: "local regex check for `tiktok.com` / `vm.tiktok.com` —
non-TikTok links rejected on-device with a clear message, no backend call."

1. Add **"Get Text from Input"** action, set its input to `Shortcut Input`
   — this normalizes a URL or Text share into a plain text value.
2. Add **"Match Text"** action:
   - Input: the text from step 1.
   - Regular Expression: `tiktok\.com|vm\.tiktok\.com`
3. Add an **"If"** action on the result of "Match Text" (condition: `Matches
   Text` has any value / is not empty — Shortcuts' "Match Text" produces
   matches you can test with "If ... has any value").
   - **Otherwise branch:** add **"Show Alert"** (or "Show Notification")
     with text like "That doesn't look like a TikTok link — RecipeCart only
     works with TikTok recipe videos." Then **"Stop This Shortcut"**. No
     network action should be reachable from this branch — that's the
     "no backend call" requirement.
   - **If-true branch:** continue with 3.3 below.

### 3.3 The POST request

Confirmed request shape from `src/api/routes/recipes.ts` and
`src/api/lib/dto.ts` (`SubmitRecipeRequest`):

- **Method:** `POST`
- **URL:** `<API_BASE_URL>/api/recipes`
- **Headers:**
  - `Authorization: Bearer <device-token>` — confirmed in
    `src/api/lib/auth.ts`'s `extractToken()`: it checks
    `request.headers.authorization` for a string starting with literally
    `"Bearer "` (capital B, one space), then falls back to a
    `recipecart_device_token` cookie. Shortcuts can't easily set cookies on
    a raw `Get Contents of URL` call, so **use the Bearer header**, not a
    cookie.
  - `Content-Type: application/json`
- **Body (JSON):**
  ```json
  { "sourceUrl": "<the TikTok URL text from step 3.2>" }
  ```
  The field is `sourceUrl` (camelCase) — confirmed in `dto.ts`'s
  `SubmitRecipeRequest` interface and the route handler
  (`body?.sourceUrl`). It must be a non-empty string or the API returns
  `400 { "error": { "code": "bad_request", "message": "sourceUrl is
  required and must be a non-empty string." } }`.

Build this with **"Get Contents of URL"**:
1. URL: `<API_BASE_URL>/api/recipes`
2. Method: `POST`
3. Headers: add `Authorization` = `Bearer <paste-token-here>` (see §4 for
   how the token gets into this field for distributed copies), and
   `Content-Type` = `application/json`.
4. Request Body: **JSON**, add a field `sourceUrl` whose value is the
   matched text from step 3.2.

### 3.4 Handling the response

Confirmed response shape from `SubmitRecipeResponse` in `dto.ts` and the
route handler:

```json
{ "jobId": "<uuid>", "status": "<job status string>", "created": true }
```

- HTTP status is **201** when a new job was created, **200** when the same
  `sourceUrl` was already submitted (dedup) — same body shape either way,
  distinguished only by the `created` boolean (there is no separate
  `"existing recipe"` string field; Spec 1 §2.2 describes this in prose as
  a "duplicate response" but the actual field to branch on is
  `created: false`).
- On any non-2xx (e.g. 401 unauthorized, 400 bad request), the body is
  `{ "error": { "code": "...", "message": "..." } }` (from `server.ts`'s
  global error handler) — surface `error.message` in the alert rather than
  raw response text, per Spec 1's "never raw errors" rule.

Build this with:
1. Add **"Get Dictionary from Input"** on the "Get Contents of URL" result,
   to parse the JSON response.
2. Add **"Get Dictionary Value"** for key `created`.
3. Add an **"If"** action on `created`:
   - **True (new job):** **"Get Dictionary Value"** for key `jobId`, then
     **"Show Result"** (or a notification, since this runs from the share
     sheet and may not present a full-screen alert depending on iOS
     version) with text **exactly**: `Got it — processing now` (per Spec 1
     §2.2's quoted string), plus a tappable link built as
     `<WEB_APP_BASE_URL>/recipes/<jobId>` (see below for why this path).
   - **False (duplicate / existing recipe):** **"Get Dictionary Value"**
     for key `jobId`, then **"Show Result"** with text like "Already
     submitted — here's the existing recipe" and a link to
     `<WEB_APP_BASE_URL>/recipes/<jobId>`, i.e. a **"View existing"**
     affordance instead of implying a new job started (Spec 1 §2.2).
   - On a non-2xx / error dictionary, show the `error.message` field from
     the response instead.

**Progress-link path:** confirmed against `web/src/App.tsx`'s route table
— `GET /recipes/:id` renders the `Review` screen. Because the route file's
own header comment confirms "a job's id and its eventual recipe's id are
the SAME value by construction" (`src/api/routes/recipes.ts` lines 5–10),
the `jobId` returned here is exactly the `:id` that route expects while
the job is anywhere in its lifecycle, not only once review is ready — so
`<WEB_APP_BASE_URL>/recipes/<jobId>` is correct as a general "view
progress" link even immediately after submit (the web app is responsible
for rendering whatever stage the job is currently in on that same path).

**Speed target:** the whole flow above (steps 3.1–3.4) should complete
inside ~2 seconds of tapping Share, since `POST /api/recipes` only
enqueues a job row and returns — it does not wait on video download, OCR/
ASR, or the Claude extraction call (those happen later in the worker
process). If it's taking noticeably longer than 2s in testing, the
bottleneck is network/DNS to the API host, not backend processing time.

## 4. Pre-configured household Shortcut (single-household beta)

Per Spec 1 A1-2's recommendation (and this session's decision to build
both the web setup-page flow and this documented pre-configured path): for
a small trusted household beta, it's simpler to build the Shortcut once,
with the device token already pasted into the `Authorization` header field
from §3.3, and share the finished Shortcut file rather than making every
household member run the CLI and edit the Shortcut themselves.

**To distribute:**
1. In the Shortcuts app, open the finished shortcut → tap the share icon →
   **"Share"** (not "Share Sheet" toggle — the actual iCloud share action).
2. Choose **"Copy iCloud Link"**. This produces a URL that opens the
   Shortcuts app on any device it's sent to, showing an install/"Add
   Shortcut" screen with the shortcut's actions already configured
   (including whatever is typed into the header field).
3. Send that link to other household members (Messages, AirDrop, etc.).
   Each person taps it, reviews the actions Shortcuts shows them (iOS
   shows a permissions/actions summary before allowing install), and taps
   **"Add Shortcut"**.

**Security caveat (do not skip this when distributing):** the raw device
token is embedded in plain text inside the shared `.shortcut` artifact —
anyone who receives the iCloud link can open the shortcut's actions and
read the token directly out of the `Authorization` header field, and it
also means every recipient is authenticating as the same single
`DEFAULT_USER_ID` account (see §2's caveat — there's currently no
per-person token). This distribution method is only appropriate for a
small, trusted, single-household beta where everyone receiving the link is
already trusted with account access. It is **not** appropriate for general
/ public distribution — do not post the iCloud link anywhere public, and
do not reuse this pattern once multi-user tokens exist without revisiting
this doc.

**Versioning convention:** Spec 1 §7 notes "The Shortcut is a distribution
artifact (an `.shortcut` file / iCloud link), so version it alongside the
repo." No `.shortcut` file exists in this repo yet (it can only be
exported from an iPhone that has built one, which this environment can't
do). When someone does export one (Shortcuts app → share icon → "Export
File" produces a `.shortcut` file), the convention going forward should be
to commit it under a top-level `shortcuts/` directory (e.g.
`shortcuts/recipecart-capture.shortcut`), named for what it does, with the
device token **stripped/blanked** before committing (a `.shortcut` file is
a binary plist — treat it like any other file that might carry a secret;
never commit one with a live token baked in). This directory doesn't exist
yet — this doc only records the convention for whoever does the export.

## 5. Testing checklist

Mirrors Spec 1 §7 ("Setup" considerations) and blocker B1-3:

- [ ] **B1-3 capability check** — before building the full Shortcut, spend
      ~30 minutes prototyping just the core loop (stored Bearer token in a
      "Text" action → "Get Contents of URL" POST → "Show Result" on the
      response) against a running local API instance, to confirm Shortcuts
      can actually do this end-to-end before investing in the polished
      version with share-sheet input and validation branches.
- [ ] Test on a **real iPhone**, not the Simulator — share-sheet
      ergonomics, Dynamic Type text sizing in the "Show Result" alert, and
      home-screen/Shortcuts-app install behavior don't reproduce in a
      desktop browser (Spec 1 §7).
- [ ] Share a real TikTok video URL from the TikTok app's share sheet (not
      pasted manually) — confirms the share-sheet input type negotiation
      actually works with TikTok's share extension.
- [ ] Share a non-TikTok URL (e.g. an Instagram Reels link) — confirm the
      on-device regex check rejects it with the clear message and that no
      network request fires (check API server logs to confirm zero
      requests for that attempt).
- [ ] Share a TikTok URL already submitted once — confirm the
      `created: false` branch fires and offers "View existing" rather than
      implying a new job.
- [ ] Time the tap-to-confirmation interval a few times — should land
      close to the ~2s target on a normal home Wi-Fi connection; investigate
      network path if it's consistently much slower.
- [ ] Confirm the "View progress" link actually opens the web app to the
      right recipe/job (`/recipes/<jobId>`) and that the web app is
      reachable from the phone (same LAN, or public URL once deployed).
- [ ] If distributing via iCloud link (§4), have a second household
      member's phone install it from the link and confirm it works with no
      further configuration on their end.

## 6. Open questions / things this doc could not confirm from code

- The exact **path** of the forthcoming web setup page (`routes/setup.ts`)
  is not yet decided by that parallel workstream; `/setup` is a guess, not
  a confirmed path. Re-check once that route lands.
