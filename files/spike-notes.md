# Phase 0 Spike Notes

Findings from the two throwaway risk spikes (`spikes/tiktok-media-spike.ts`,
`spikes/heb-automation-spike.ts`). Fill in as each spike runs; this doubles as the
Go/No-Go record before Phase 1 starts.

## Spike A — TikTok media (blockers B2-1, B2-2)

**Status:** Partially run — 1 of ~5 target URLs tested so far. Standard `tiktok.com/@user/video/id`
case confirmed working end-to-end; still need a `vm.tiktok.com` short link and a
photo-mode/slideshow post to fully resolve B2-1/B2-2.

- yt-dlp version used: 2026.07.04
- URLs tested:
  - `https://www.tiktok.com/@jalalsamfit/video/7564134038592605462` — ok
  - *(still need: one `vm.tiktok.com` short link, one photo-mode/slideshow post)*
- Download success rate: 1/1 (100% so far, small sample)
- Short-link (`vm.tiktok.com`) resolution: **not yet tested**
- Photo-mode posts: **not yet tested**
- Frame quality at ~1000px long edge (eyeballed): **good** — overlay ingredient-card
  text ("Olive Oil", "Paprika") is crisp and clearly legible on 2s-interval frames;
  this is exactly the OCR chrome-masking / escalation-selection target case in Spec 2
  §2.3/§2.4.
- Audio extraction: clean — 16kHz mono WAV, 58.7s, matches the `media_split` target
  format exactly; ffprobe confirms real audio track (not silent/corrupt).
- Video: 58s duration, has_audio=true, not photo-mode, 29 frames extracted at the
  2s-interval fallback (well under the 40 raw-frame cap; scene-change detection
  should reduce this further at dedup).
- Friction / errors encountered: none.

**B2-1 (yt-dlp viability):** looking good on 1 sample, standard-link case — need the
short-link + photo-mode cases before calling this fully resolved.
**B2-2 (photo-mode support):** unresolved — no photo-mode post tested yet.

## Spike B — H-E-B automation (blockers B3-1..B3-4, action items A3-1, A3-2, A3-4)

**Status:** Not yet run — needs your real H-E-B account, run interactively (headed
browser, your login).

- Target store + fulfillment mode (A3-1): —
- Login-capture-and-reuse: works / fails —
- Search selectors observed: —
- Product-tile selectors observed: —
- Cart (read) selectors observed: —
- Cart (add-to-cart confirmation signal) observed: —
- **Search reachable logged out? (A3-2):** —
- Anti-bot friction observed (CAPTCHA, fingerprinting, rate limiting): —
- Session lifetime (revisit after a few days and note when it expires): —

**B3-1 (site structure):** unresolved
**B3-2 (anti-bot posture):** unresolved
**B3-3 (session lifetime):** unresolved
**B3-4 (ToS):** standing item, not a P0 gate — documented, accepted for personal use.

## Go/No-Go decision

Not yet made — pending both spikes above.
