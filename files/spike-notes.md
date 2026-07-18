# Phase 0 Spike Notes

Findings from the two throwaway risk spikes (`spikes/tiktok-media-spike.ts`,
`spikes/heb-automation-spike.ts` + `spikes/heb-waf-diagnostic.ts`). This is the
Go/No-Go record for Phase 0.

## DECISION: retailer pivot from H-E-B to Kroger (2026-07-17)

The H-E-B automation spike below concluded NO-GO: heb.com (Akamai Bot Manager) blocks
Playwright/CDP-driven browser automation outright, confirmed across five
configurations, including reproducing a public reference implementation's exact
working recipe. Full investigation is preserved below as the record of that decision.

**Resolution: Kroger**, which publishes an official, self-service Public API (OAuth2,
no approval process) covering product search, store lookup, and cart-add — a real,
sanctioned integration path with none of the automation-detection risk. This is now
reflected throughout the specs/PRDs: see `specs/spec-3-kroger-matching-cart.md` and
`component-3-kroger-matching-cart-prd.md` (replacing the removed H-E-B versions),
plus retailer-reference updates in `phases.md` and Components 1/4. The H-E-B
investigation below is kept in full as the historical record of why this pivot
happened and what was tried — not deleted, since the reasoning (and the general
lesson about CDP-level bot detection) remains valuable.

## Spike A — TikTok media (blockers B2-1, B2-2)

**Status:** Core case (B2-1) resolved. Photo-mode (B2-2) resolved as a **confirmed
gap** — not fixable with yt-dlp alone, deferred to P2 as speced, needs a design
decision before P2 photo-mode work starts.

- yt-dlp version used: 2026.07.04 (latest stable; confirmed via `yt-dlp -U`)
- URLs tested:
  - `https://www.tiktok.com/@jalalsamfit/video/7564134038592605462` (standard video) — ok
  - `https://www.tiktok.com/t/ZTSKEBAMy/` (short link, `tiktok.com/t/...` form) — ok
  - `https://www.tiktok.com/@shreddedandfed/video/7650230773512965393` (same video, fully-expanded URL, caption has no ingredient list) — ok
  - `https://www.tiktok.com/@success.fitness/photo/7547822272153799954` (photo-mode/slideshow) — **failed**
- Download success rate: 3/4 (the 1 failure is the photo-mode case, see below)
- Short-link resolution: **works.** Tested `tiktok.com/t/ZTSKEBAMy/` — yt-dlp resolved
  and downloaded it identically to the fully-expanded URL for the same video (22s,
  11 frames, audio present). Note: the URL supplied was the `tiktok.com/t/...` short
  form rather than `vm.tiktok.com/...`; both are TikTok short-link domains and yt-dlp
  has a dedicated redirect-resolver extractor covering both (`(?:vm|vt)\.tiktok\.com|
  tiktok\.com/t`, confirmed in the installed extractor source) — not a gap.
- Photo-mode posts: **yt-dlp does not support the `/photo/<id>` URL pattern at all.**
  - The installed TikTok extractor's `_VALID_URL` regex only matches `/video/<id>`
    (and `/embed/<id>`) — `/photo/<id>` isn't recognized, so yt-dlp falls back to its
    generic extractor and fails immediately with "Unsupported URL".
  - **Workaround found:** manually rewriting `/photo/<id>` → `/video/<id>` in the URL
    lets the TikTok extractor pick it up. It downloads successfully — but only as an
    **audio-only track** (the extractor's slideshow path assumes music, not images)
    plus **exactly one cover thumbnail** (`thumbnails: [cover, originCover]`, both
    pointing to the identical image URL/hash). **The other slides are never
    retrieved.** Confirmed by inspecting the extractor source
    (`tiktok.py`, `_extract_web_formats` / `_parse_aweme_video_web`) — there's no
    code path that surfaces a multi-image `imagePost.images[]` array at all.
  - Tried fetching the page HTML directly (plain `curl`, no session) to parse
    TikTok's embedded `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON for the full image
    array (this is where the real slide URLs live in TikTok's own page). The script
    tag exists but the fetched page didn't contain the real post payload — TikTok's
    anti-bot/SSR gate needs a proper browser session or fingerprinting (yt-dlp itself
    warns `"attempting impersonation, but no impersonate target is available"` for
    this exact extractor). A plain unauthenticated HTTP fetch isn't sufficient;
    getting the real slide URLs would need a Playwright-rendered page (the same
    infra Spike B is already building for H-E-B) rather than yt-dlp or curl.
  - This specific test post's caption ("More recipes in my bio ✅ #highproteinmeals
    #dinnerideas...") has **no ingredient list at all** — confirmed by running it
    through `parseCaption()`: 0 matched lines. So for a post like this, the
    caption-first gate correctly falls through to "needs OCR" — but there would be
    no images to OCR with the current tooling. This is the realistic failure mode:
    caption-sparse photo-mode posts are a dead end right now, not just an edge case.
- Frame quality (standard video) at ~1000px long edge: **good** — overlay
  ingredient-card text ("Olive Oil", "Paprika") is crisp and legible on 2s-interval
  frames; this is exactly the OCR chrome-masking / escalation-selection target case
  in Spec 2 §2.3b/§2.4.
- Audio extraction: clean — 16kHz mono WAV, matches the `media_split` target format
  exactly; ffprobe confirms real audio tracks (not silent/corrupt) on all 3 working
  cases.
- Friction / errors encountered: none on standard-video/short-link cases; the
  photo-mode failure above is the only issue found.
- **Caption-sufficiency gate (Spec 2 §2.3a) — real data across 3 videos:**
  - `@jalalsamfit` sheet-pan chicken: caption has a complete, detailed ingredient
    list → `captionSufficient: true` (17 matched lines). Correctly identified — OCR
    would be skippable for this recipe.
  - `@shreddedandfed` beef bulgogi: caption is prose + a macro line, no ingredient
    list (as the user confirming this test case described — "no recipe in the
    caption, only in the video itself") → `captionSufficient: false` (only 1 matched
    line, the macro stats — correctly below the threshold of 3). This is the
    negative-path confirmation: the gate correctly falls through to OCR/ASR for a
    genuinely caption-sparse video.
  - `@success.fitness` photo-mode post: caption has no ingredient list →
    `captionSufficient: false` — correct call, but as noted above there's no OCR
    fallback available for this one right now.
  - Two real scorer bugs were caught and fixed against the `@jalalsamfit` caption
    during implementation: (1) captions glue the unit directly onto the number with
    no space ("800g", not "800 g"), which a naive `\bunit\b` regex can't match across
    a digit/letter boundary; (2) TikTok's API returned that caption as one run-on
    line with no real newlines, using " - " as an inline list separator instead — a
    newline-only line-splitter found zero matches until the splitter was taught to
    also split on " - "/bullet characters with surrounding whitespace. Both are now
    covered by regression tests (`src/pipeline/extract/ingredient_likelihood.test.ts`).

**B2-1 (yt-dlp viability): RESOLVED.** 3/3 standard-video downloads succeeded across
two URL forms (fully-expanded + short link), clean audio/frame extraction, no
friction. Confident enough to proceed to Phase 1 on the standard-video path.

**B2-2 (photo-mode support): RESOLVED AS A GAP, not a Phase 1 blocker.** Photo-mode
is already scoped as `[P2]` reduced-pipeline work in Spec 2 (phases.md Phase 2), not
part of Phase 1's happy path — so this doesn't block starting Phase 1. But it does
mean the P2 photo-mode plan needs a real decision before that work starts, since
"OCR the slides" (the speced reduced pipeline) currently has no way to fetch the
slides at all. Options to evaluate then: (a) build a small Playwright-based fetcher
for the `imagePost.images[]` array from the rendered TikTok page — reuses Spike B's
browser-automation muscle, feels like the most robust fix; (b) treat caption-sparse
photo-mode posts as a distinct `not_a_recipe`-adjacent terminal case for now, and
revisit if it turns out to be common; (c) check yt-dlp's GitHub issues for an
in-flight fix before building a custom fetcher. Not deciding this now — flagging it
so it's not a surprise when P2 starts.

## Spike B — H-E-B automation (blockers B3-1..B3-4, action items A3-1, A3-2, A3-4)

**Status: DONE. B3-2 confirmed as a hard blocker for the as-designed architecture.
Go/No-Go: NO-GO on Playwright/CDP-driven browser automation against heb.com.**

### What was tried

**Attempt 1 — Playwright's bundled Chromium.** Navigating to heb.com returned an
explicit WAF block page before any login attempt or interaction:
```json
{"incidentId":"...","hostName":"www.heb.com","errorCode":"15",
 "description":"This page could not load. It looks like an ad blocker, antivirus
 software, VPN, or firewall may be causing an issue...","proxyId":"1433-100", ...}
```
The wording is a generic cover message; the `proxyId`/`proxyIp` fields and the fact
that heb.com loads fine in the same user's regular browser on the same network
(confirmed) point to WAF/bot-fingerprint detection of the automated browser itself.

**Attempt 2 — real installed Google Chrome via Playwright's `channel: "chrome"`,**
still a fresh Playwright-created context (still CDP-automated). **Blocked
identically** — same error code 15, same page. This rules out "wrong browser binary"
as the cause: the block travels with the automation protocol (CDP), not the browser
executable.

**Attempt 3 — the user's actual real Chrome profile** (real cookies/login state) via
`launchPersistentContext`, to test whether a genuine, non-fresh browser identity fares
differently. This attempt never produced a clean signal — it failed three times in a
row on unrelated environment/plumbing issues rather than a new WAF response: (a) the
automated window opened behind/separate from a restored session window and appeared
blank; (b) after adding explicit page enumeration and a hard launch timeout, the
launch itself silently hung past 45s with the Chrome process confirmed running via
`ps` but never completing its CDP handshake back to Playwright; (c) on retry, a
**separate, fully non-automated Chrome instance** (no `--remote-debugging-pipe`, no
`--disable-blink-features`, real extensions active) was found running against the
same profile — almost certainly a macOS/Chrome auto-relaunch (login item or
background-app setting) grabbing the profile's singleton lock out from under the
automated launch, so Playwright was left waiting on a CDP connection that would never
arrive. Each failure had a distinct, diagnosable environmental cause, none of which
were a new or different WAF response — this attempt is **inconclusive by itself**,
but it didn't need to be conclusive: attempts 1 and 2 already agree cleanly.

### Conclusion

**B3-2 (anti-bot posture): CONFIRMED — heb.com blocks CDP-driven browser automation
(Playwright/Puppeteer/Selenium-class tooling) outright, before any interaction,
regardless of which real browser binary drives it.** This is a harder result than the
spec anticipated ("pause-and-hand-off constantly" for CAPTCHA/session friction) — it's
a wall before the front door, not friction during the session. Per `phases.md`'s own
exit condition for this exact scenario ("H-E-B blocks automated sessions outright"),
this is a **NO-GO on Spec 3's Playwright-adapter design as currently speced** — every
downstream piece of Spec 3 (§2.1 adapter, §2.2 matcher's `search()` call, §2.3 cart
runner) assumes a controllable Playwright session can reach heb.com at all, which it
currently cannot.

**B3-1 (site structure): not reached** — never got past the WAF to observe real
selectors.
**B3-3 (session lifetime): not reached** — same reason.
**B3-4 (ToS):** unchanged standing item, but now more directly relevant — see next
steps below regarding unofficial-API approaches.

### Option 2 (companion browser extension) ruled out

Browser extensions are desktop-only: Chrome for iOS has no third-party extension
support at all (Apple requires every iOS browser to use WebKit, and doesn't expose
Chrome's extension APIs there), and Android Chrome doesn't support arbitrary
third-party extension installs either. Since the product's actual target UX is
"share a TikTok from your phone → review → cart" (Spec 1's iOS Shortcut + phone web
app), an extension-based architecture can't satisfy the core requirement. Ruled out
without further investigation.

### Option 3 (unofficial internal APIs) investigated — inherits the same blocker

An existing open-source project, `texas-grocery-mcp` (GitHub, `mgwalkerjr95`), claims
H-E-B cart automation via "unofficial web APIs and browser automation against
HEB.com." Reading its actual `auth/browser_refresh.py` implementation surfaced real,
directly relevant findings:

- **H-E-B runs Akamai Bot Manager** — confirmed by the `reese84` cookie name
  referenced in their code, which is Akamai's specific bot-detection sensor token.
  This is a sophisticated, industry-standard anti-bot vendor, consistent with the
  hardness of the block we observed.
- **Full source read** (cloned the repo, read `auth/browser_refresh.py` [1629 lines],
  `auth/session.py`, `clients/graphql.py` [2400 lines], `pyproject.toml`):
  - **No anti-detection library at all.** Dependencies are plain `playwright>=1.40.0`
    + `httpx`. No `patchright`, `playwright-stealth`, `undetected-chromedriver`,
    `curl_cffi`, `tls-client`, no `add_init_script` fingerprint patching, no
    `channel="chrome"`, no proxy. Repo-wide grep for all of these: zero hits.
  - **Their exact Playwright launch** (bundled Chromium): `args=[
    "--disable-blink-features=AutomationControlled", "--no-first-run",
    "--no-default-browser-check", "--disable-infobars"]`, plus a
    `new_context(user_agent="...Mac OS X 10_15_7...Chrome/120.0.0.0 Safari/537.36")`
    override and a reused `storage_state` file. That is the entire recipe.
  - **They do not defeat Akamai.** Headless path: on a detected challenge it does
    `raise BrowserRefreshError("Security challenge detected in headless mode. Run
    session_refresh(headless=False)...")` — i.e. it gives up. Headed path: on a
    challenge it injects a banner *"Complete it in this browser, then tell your agent
    'done'"*, screenshots it, and **hands off to a human to solve it manually**. This
    is exactly the pause-for-human handoff Spec 3 §2.1 already committed to — not a
    bypass.
  - **The whole thing hinges on the `reese84` token** (Akamai Bot Manager's sensor
    token — its presence confirms H-E-B runs Akamai). `session.py` reads `reese84`
    out of the browser-minted `storage_state` localStorage and checks its `renewTime`
    expiry; its own comment: *"HEB's WAF rejects requests with expired tokens."*
    `graphql.py`'s httpx client (`get_httpx_cookies()`) then **replays those
    browser-minted cookies** for direct GraphQL/`_next/data` API calls. So the fast
    "unofficial API" path is 100% dependent on a browser (potentially a human)
    first passing Akamai to mint `reese84`; the token expires ~every 11 min and must
    be re-warmed by re-visiting in a valid browser session.
  - **Net:** their methodology = *human passes Akamai once in a visible browser →
    save cookies+reese84 → replay via httpx for ~11 min → re-warm → re-solve when it
    fully expires.* It presupposes an established, human-blessed session; it is not a
    cold-start bypass.

**Does their methodology transfer to OUR product? Partially — and only to Phase 1.**
The decisive mismatch is *where a human is available to solve Akamai's challenge*:
- **texas-grocery-mcp runs on the user's own laptop, with the user present.** When
  Akamai demands a challenge, a visible browser pops up and the human solves it. That
  is a fine assumption for a desktop MCP tool.
- **Our product (per the specs) is phone-first and cloud-hosted.** Spec 1 is an iOS
  Shortcut + phone web app; Spec 4 runs `web`+`worker` on Railway with no desktop and
  no human at a browser. A challenge that requires a human at a visible desktop
  browser every ~11 minutes cannot be satisfied there. Spec 3 §A3-5 ("guided login
  once, reuse session") assumed session lifetime measured in *days*; Akamai's
  `reese84` expiring every ~11 min + periodic full re-challenge breaks that assumption
  outright.
- **BUT Phase 1 is explicitly local + CLI, with the developer present at the machine.**
  In that setting their methodology *could* apply: a human-in-the-loop guided login
  (headed browser, solve the Akamai challenge by hand once, capture `storage_state`)
  is viable exactly the way texas-grocery-mcp does it. Whether it survives to Phase 4
  (cloud) is a separate, harder question that their approach does **not** answer in
  our favor.
- **Precondition still unproven for us:** all of the above assumes we can even reach
  a *solvable* Akamai challenge. Every automated attempt so far got the *un*solvable
  `errorCode: 15` hard-deny instead — see the pending headed test below.

**RESULT — headed test of their EXACT recipe** (`npm run spike:heb-diag -- --headed`,
run 2026-07-17): **outcome (a) — `errorCode: 15` hard-deny again.** Their precise
recipe (bundled Chromium, headed/visible, UA override, their 4 args), run
interactively, still gets the unconditional block page — NOT the solvable challenge
their human-handoff code is built for. The human never gets a challenge to solve; the
automated browser is denied at the door. This is the strongest possible negative:
**their methodology does not even reach the state it depends on, so it does not apply
to us — not even for Phase-1-local human-guided login.**

Side note on IPs: this run reported `clientIp: 184.93.1.155` / `proxyId: 211-100`,
whereas the very first block (headed, real Chrome) reported `clientIp: 24.27.81.75` /
`proxyId: 1433-100` — two different source IPs, both hard-denied, while the user's
normal (non-automated) browser loads heb.com fine on the same network. This isolates
the trigger to the **automation fingerprint itself, not IP reputation** — and since
JS-layer countermeasures (`--disable-blink-features=AutomationControlled`, UA
override) don't help, the detection is almost certainly below the JS layer
(TLS/HTTP2/JA3 fingerprint of the CDP-launched browser, and/or Akamai sensor JS
detecting CDP instrumentation).

**Reproduced their exact config against heb.com (`spikes/heb-waf-diagnostic.ts`):**
headless bundled Chromium, their precise args, their exact user-agent string, fresh
context (no stored session) → **identical hard block**, same branded
`errorCode: 15` / `incidentId` JSON response, not even a solvable challenge page.
This test ran from a different network/IP than the earlier attempts and got the same
result — ruling out IP-reputation-of-this-specific-network as the explanation; the
block travels with the automation fingerprint itself.

This also means **option 3 doesn't actually route around the problem**: their
"unofficial API" calls still require a Playwright session to first pass Akamai's
challenge and mint a valid session/token. That first-contact step is exactly what's
blocked for us in every configuration tried (4 total: bundled Chromium headed, real
Chrome headed via fresh context, real Chrome via real profile [inconclusive/plumbing],
headless bundled Chromium with a documented working config). **Not pursuing this
further** — going past this would mean attacking the TLS/network-layer fingerprint
directly (the block persisting across every JS/DOM-level countermeasure tried points
to detection below the JS layer, e.g. TLS/JA3 fingerprinting), which is a different
and more serious category of tooling to build than what's been done so far, and isn't
something to reach for without a very explicit conversation.

### Other context gathered

- **No official H-E-B developer/partner API** for cart or product access was found.
  H-E-B Marketplace (`supplierportal.heb.com`) is an unrelated B2B purchase-order
  system for suppliers, not a consumer shopping API.
- **Kroger has an official partner Cart API** (`developer.kroger.com`) — a real,
  sanctioned developer program with cart write access. Relevant only if a
  different-retailer pivot is on the table.

## Go/No-Go decision

**NO-GO on the architecture as speced. Both spikes are done; Spike A cleared, Spike B
did not.**

- Spike A (TikTok media): **no blocker for Phase 1.** B2-1 resolved cleanly; B2-2
  (photo-mode) is a real, confirmed gap but one already scoped out of Phase 1 by the
  phasing doc, so it doesn't hold up starting Phase 1's standard-video happy path.
- Spike B (H-E-B automation): **NO-GO.** heb.com (Akamai Bot Manager) blocks
  Playwright/CDP-driven browser automation outright with an unconditional
  `errorCode: 15` deny page, confirmed across **five** configurations: bundled
  Chromium headed; real Chrome headed (fresh context); real Chrome via real profile
  (inconclusive/plumbing); headless bundled Chromium with texas-grocery-mcp's exact
  recipe; and **headed bundled Chromium with their exact recipe incl. UA override** —
  the last being a direct application of the only known reference implementation's
  methodology. On two different source IPs, while the user's normal browser works
  fine on the same network. This is exactly the `phases.md` exit condition for
  stopping before Phase 1: *"If either spike fails fundamentally (e.g., H-E-B blocks
  automated sessions outright), stop and rethink before Phase 1."* Spec 3's entire
  adapter design (§2.1–§2.3) assumes a controllable Playwright session can reach
  heb.com, which it cannot — this blocks Phase 1 as-speced, not just Spec 3's
  hardening phase. The block is below the JS layer (JS-level countermeasures don't
  help), so getting past it would require TLS/network-fingerprint-level evasion
  tooling — out of scope without an explicit, deliberate decision to build that.

**This does not block Phase 0/1 work on Spec 2 (extraction)** — that pipeline has no
dependency on H-E-B automation and can proceed independently. It blocks the cart
side specifically: matching can still run (search-only, if reachable — untested,
A3-2 unresolved) but nothing can add to a real cart until the architecture question
below is resolved.

### Next steps — status of each option as of this investigation

1. **Manual/checklist cart flow** — keep automated extraction + matching, drop
   automated cart *writes*; the tool produces a ranked, quantity-matched shopping
   list the user adds to their own real H-E-B cart by hand (app or site). **Still
   viable** — doesn't touch heb.com programmatically at all, so it's unaffected by
   anything found here. Smallest change, most robust, but reintroduces the manual
   step the product was designed to remove. Open question: can search/matching still
   run (read-only) against heb.com at all, or is even that blocked the same way? —
   untested (A3-2), worth a quick check since it determines whether matching stays
   automated or the checklist is names-only.
2. **Companion browser extension.** **RULED OUT** — desktop-only mechanism (no iOS
   Chrome extension support, no arbitrary Android extension installs), incompatible
   with the product's actual phone-first target UX (Spec 1's iOS Shortcut + phone web
   app). Ruled out without a spike, on product-requirements grounds alone.
   Note for the record: had it been viable, it would have been the most promising
   option — same reasoning as option 3 below shows the block is about the automation
   fingerprint, and a real, non-CDP browser session (which an extension would run
   inside) doesn't carry that fingerprint at all.
3. **heb.com's internal APIs via Playwright (texas-grocery-mcp's approach).**
   **INVESTIGATED AND RULED OUT.** Fully source-analyzed and their exact recipe
   reproduced, headed and headless — see the detailed section above. It depends on a
   browser session first passing Akamai to mint `reese84`; for us that first step is
   the unconditional `errorCode: 15` deny across all five configs tried, so the
   approach never reaches the state it relies on. Going past this = TLS/network-layer
   fingerprint evasion, a materially different and more serious category of tooling,
   not pursued.
3b. **Borrow the token from the user's OWN normal browser** (variant of option 3 that
    avoids launching an automated browser at all). The user's normal Chrome passes
    Akamai fine; in principle its cookies + `reese84` localStorage could be lifted
    after they browse heb.com, and replayed via `httpx` for reads/matching exactly
    like texas-grocery-mcp's `graphql.py` does. **Not tested.** Ceiling is low: fragile
    (encrypted cookie DB + leveldb localStorage extraction), token expires ~11 min so
    it needs constant re-warming from the real browser, still ToS-adjacent (B3-4), and
    critically **still doesn't work for Phase 4** (cloud/phone-first — no user browser
    present to source or re-warm the token). At best a Phase-1-local-only crutch.
4. **Different retailer** — e.g. Kroger, which has an official, sanctioned partner
   Cart API. **Still viable**, and the only option that preserves full programmatic
   cart automation end-to-end (including cloud/Phase 4) without an unresolved
   technical blocker or ToS-adjacency. Cost: the product is no longer H-E-B-specific —
   the largest change, since H-E-B is in the product's name.

**Net effect: options 1 and 4 are the two realistic paths.** Option 1 keeps the
product's identity (H-E-B) at the cost of the last manual step (and possibly of
automated matching too, if reads are also blocked — untested, A3-2). Option 4 keeps
full automation end-to-end at the cost of the product's identity. Options 2, 3, 3b are
ruled out or dead-ended. No decision made yet in this file — captured here so the
reasoning survives past the conversation it came from.
