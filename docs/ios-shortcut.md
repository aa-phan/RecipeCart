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

- **A Shortcut token.** First sign in to the deployed web app with Google
  (`https://<your-production-domain>/login`) — `/setup` is authenticated-only
  as of multi-tenancy Slice 1, so this step comes first, not `/setup`
  itself. Once signed in, visit `/setup` (nav: "Devices") and click
  "Generate Shortcut token." This mints a fresh token and displays it once
  for copying. It does NOT sign this browser in or change its own session
  in any way (2026-07-22 re-scoping) — it exists purely to hand a raw
  token to the Shortcut, which can't do a browser sign-in or read a
  cookie itself. Keep the value handy — you'll paste it into the
  Shortcut's first-run prompt (§3.2 below).

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

### 3.2 Get or prompt for the device token

**This replaces the old design of pasting the token directly into the POST
action's header field (buried three steps deep in an action's
configuration).** Instead, the Shortcut remembers the token itself, across
runs, using a small text file in iCloud Drive — the simplest "remember one
string between runs" mechanism the Shortcuts app has without third-party
actions. On the very first run (or if that file is ever missing/emptied),
the Shortcut stops and asks the user to paste their token once, saves it,
and only then continues; every run after that skips the prompt entirely.

1. Add a **"Text"** action. Set its content to the fixed path
   `Shortcuts/recipecart-token.txt`. Rename this action's output (tap the
   "..." on the action → **Rename Variable**) to `Token File Path` so it's
   easy to reference below.
2. Add a **"Get File"** action.
   - Tap the **File** parameter. Instead of browsing to a file, use the
     variable-insertion control (the small icon in the input field) to
     select the `Token File Path` variable from step 1 — this makes "Get
     File" treat the text as an iCloud Drive path rather than opening a
     file picker.
   - Tap **"Show More"** and turn **OFF "Error if Not Found."** This is the
     critical setting: on the first-ever run this file doesn't exist yet,
     and without disabling this, the Shortcut would crash instead of
     falling through to the prompt in step 4 below.
   - Rename this action's output to `Stored Token File`.
3. Add **"Get Text from Input"**, input = `Stored Token File`. Rename its
   output to `Stored Token`. (If the file wasn't found in step 2, this
   produces empty/no text — that's the signal the "If" below checks.)
4. Add an **"If"** action on `Stored Token`, condition **"has any value"**.
   - **If true (token already stored from a previous run):** add **"Set
     Variable"**, name `Device Token`, value = `Stored Token`. Nothing else
     to do in this branch — it falls through to 3.3 below with
     `Device Token` populated and no prompt shown.
   - **Otherwise (first run, or the stored file is missing/empty):**
     a. Add **"Ask for Input"** — Input Type: **Text**, Prompt: **"Paste
        your RecipeCart device token"** (the value from the `/setup` page,
        §2 above).
     b. Add **"Set Variable"**, name `Device Token`, value = the text just
        entered in (a).
     c. Add **"Save File"** — content = `Device Token`, path =
        `Token File Path` (service: iCloud Drive), with **"Overwrite If
        File Exists"** turned **ON**. This writes the freshly-entered token
        back to disk so every future run finds it in step 2 and skips the
        prompt.
   - End the "If" block. Both branches now leave a populated `Device Token`
     variable in scope, so everything below this point — including 3.3's
     validation and 3.4's POST — is identical regardless of which branch
     ran.

### 3.3 On-device TikTok validation (no network call)

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
   - **If-true branch:** continue with 3.4 below.

### 3.4 The POST request

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
    cookie. The value is the `Device Token` variable set in §3.2 above —
    **not** a literal pasted string typed into this field.
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
3. Headers: add `Authorization` with value built as literal text `Bearer `
   followed by the `Device Token` variable from §3.2 (use the
   variable-insertion control to append it after typing `Bearer ` — do not
   type or paste the token itself into this field; that's exactly the
   buried-editing step this design replaces), and `Content-Type` =
   `application/json`.
4. Request Body: **JSON**, add a field `sourceUrl` whose value is the
   matched text from step 3.3.

### 3.5 Handling the response

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

## 4. Sharing the Shortcut (now token-less — one link works for everyone)

Because §3.2 moved token entry into a first-run prompt stored per-device in
iCloud Drive, the Shortcut itself no longer contains anyone's token — it's
generic. That's an improvement over the old design: previously, sharing the
Shortcut meant sharing whatever raw token happened to be pasted into the
header field at export time (see the superseded caveat below). Now, build
it once, share the single iCloud link with the whole household, and each
person who installs it gets prompted for their own copy of the token on
their own first run — nobody has to open the Shortcut's actions or edit
anything.

**To distribute:**
1. In the Shortcuts app, open the finished shortcut → tap the share icon →
   **"Share"** (not "Share Sheet" toggle — the actual iCloud share action).
2. Choose **"Copy iCloud Link"**. This produces a URL that opens the
   Shortcuts app on any device it's sent to, showing an install/"Add
   Shortcut" screen with the shortcut's actions already configured.
   Because §3.2's token file starts out missing on a fresh install, this
   link is now safe to share broadly among trusted household members —
   there is no secret baked into it.
3. Paste that URL into the `SHORTCUT_ICLOUD_URL` constant in
   `web/src/lib/shortcutConfig.ts` (see the comment there). Once set, the
   `/setup` web page's "Add Shortcut to your device" button links straight
   to it — no more manually sending the link over Messages/AirDrop, though
   that still works too.
4. Anyone installing it (via the button or a direct link) reviews the
   actions Shortcuts shows them (iOS shows a permissions/actions summary
   before allowing install), taps **"Add Shortcut,"** and is prompted for
   their token on the very first run per §3.2.

**Still true, and unaffected by this change:** there's currently only one
device-token "slot" server-side (see §2's `DEFAULT_USER_ID` caveat) — every
person who pastes a token in step 4 above is still authenticating as the
same single account, and generating a new token via `/setup` invalidates
whatever every other household member pasted in. This is a backend
limitation the token-storage redesign in §3.2 doesn't (and isn't meant to)
fix; it only removes the *plaintext-token-in-a-shared-file* problem, not
the *single-account* one.

<details>
<summary>Superseded: the old baked-in-token distribution caveat (kept for
history, no longer applicable)</summary>

Previously, the Shortcut had the device token pasted directly into the
`Authorization` header field, so the shared `.shortcut` artifact contained
the token in plain text — anyone with the iCloud link could open the
shortcut's actions and read it out directly, which meant the link itself
was sensitive and had to be restricted to people already trusted with
account access, never posted anywhere public. §3.2's first-run-prompt
design removes this problem: the distributed Shortcut has no token in it
at all.

</details>

**Versioning convention:** Spec 1 §7 notes "The Shortcut is a distribution
artifact (an `.shortcut` file / iCloud link), so version it alongside the
repo." No `.shortcut` file exists in this repo yet (it can only be
exported from an iPhone that has built one, which this environment can't
do). When someone does export one (Shortcuts app → share icon → "Export
File" produces a `.shortcut` file), the convention going forward should be
to commit it under a top-level `shortcuts/` directory (e.g.
`shortcuts/recipecart-capture.shortcut`), named for what it does. With the
§3.2 redesign the exported file no longer has a live token baked into an
action's fields (the token only ever lives in the per-device iCloud Drive
file created at runtime), so this is lower-risk than it used to be — but
still treat a `.shortcut` file (a binary plist) as something to skim
before committing, in case a future edit reintroduces a hardcoded value.
This directory doesn't exist yet — this doc only records the convention
for whoever does the export.

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
- [ ] **First-run prompt (§3.2):** delete/rename `recipecart-token.txt`
      from iCloud Drive (or install fresh) and confirm the "Paste your
      RecipeCart device token" prompt appears before anything else, and
      that submitting a TikTok share afterward still succeeds using the
      just-entered token.
- [ ] **Token persistence (§3.2):** after the first run above, run the
      Shortcut again (new share) and confirm the prompt does **not**
      reappear — it should go straight to validation/POST using the
      stored file.
- [ ] If distributing via iCloud link (§4), have a second household
      member's phone install it from the link and confirm it prompts them
      for their own token on their first run (not the token from whoever
      built the original Shortcut) and works with no further
      configuration after that.

## 6. Open questions / things this doc could not confirm from code

- ~~The exact path of the web setup page is not yet decided~~ — resolved:
  `/setup` is the real, live path (`web/src/screens/Setup/Setup.tsx`),
  verified working end-to-end against production
  (`https://recipecart-production.up.railway.app/setup`) on 2026-07-20.
