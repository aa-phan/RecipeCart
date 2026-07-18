# RecipeCart

TikTok Recipe → Kroger Cart Automation (working name).

RecipeCart takes a TikTok recipe URL and turns it into items in a real Kroger
cart: it downloads the video, extracts an evidence-backed structured recipe
(caption, on-screen text, and narration), matches each ingredient to a Kroger
product via Kroger's official Public API, and — only after explicit human
approval — adds the approved items to the cart via a standard OAuth2-authorized
API call.

## Guiding principle

**Prove the pipeline before building the product around it.** The MVP is a
barebones, local, CLI-driven pipeline. Only once a real TikTok URL can reach
a real Kroger cart end to end do we layer on the things that make it a
product: quality/safety hardening, a backend service, a phone-friendly review
UI, an iOS Shortcut, and cloud deployment. The one genuinely risky unknown —
TikTok media access (yt-dlp) — sits in the pipeline itself and is de-risked
first.

**Note on the retailer:** this product originally targeted H-E-B via
Playwright browser automation. The Phase 0 risk spike found heb.com blocks
CDP-driven browser automation outright (Akamai Bot Manager), confirmed across
five configurations including reproducing a public reference implementation's
exact working recipe — a hard block below the JS layer, not fixable with a
config change. Kroger publishes an official, self-service Public API (OAuth2,
no approval process) that covers everything this product needs, with none of
that risk. Full investigation and rationale: [`files/spike-notes.md`](files/spike-notes.md).

See [`files/phases.md`](files/phases.md) for the full phase breakdown and
exit criteria.

## How it works

1. **Extraction** (`src/pipeline/`) — resolve the TikTok URL, download the
   video via yt-dlp, and check the caption first: if it already contains a
   clear ingredient list, skip straight to audio-only processing. Otherwise
   extract deduplicated frames, run OCR, transcribe the audio (ASR), and
   reconcile everything into a single evidence-backed recipe JSON with one
   Claude call. Every populated field carries evidence or is `null` with a
   stated reason — no unsupported inference.
2. **Matching & cart** (`src/kroger/`, `src/matcher/`) — a deterministic
   matcher normalizes each ingredient, searches Kroger's Products API (no
   per-user auth required), and ranks candidates (in-stock, form fit,
   quantity-to-package fit, unit price). A separate, gated cart runner only
   adds items after explicit human approval, via Kroger's Cart API under the
   user's own OAuth2 authorization; no checkout code path exists anywhere in
   the client, because Kroger's Public API doesn't expose one.
3. **Review** — in the MVP this is a terminal table / editable review file.
   A phone-friendly web app and iOS Shortcut come later, as a re-skin of the
   same data rather than new logic (see [Spec
   1](files/specs/spec-1-mobile-capture-review.md)).
4. **Platform** (`src/platform/`) — local-first storage (SQLite/flat files
   under `./data/`), structured logging with secret redaction, and `.env`
   based secrets. Grows into a `web`/`worker` service with Postgres and a job
   queue, then a Dockerized deployment on Railway (see [Spec
   4](files/specs/spec-4-backend-platform.md)).

Full technical specs live under [`files/specs/`](files/specs/), one per
component, each tagged with the phase (`[P0]`–`[P5]`) each section belongs
to:

- [Spec 1 — Mobile Capture & Review Experience](files/specs/spec-1-mobile-capture-review.md)
- [Spec 2 — TikTok Media & Recipe Extraction](files/specs/spec-2-tiktok-extraction.md)
- [Spec 3 — Kroger Product Matching & Cart Automation](files/specs/spec-3-kroger-matching-cart.md)
- [Spec 4 — Backend Platform, Hosting & Orchestration](files/specs/spec-4-backend-platform.md)

Product-level PRDs for each component are in `files/*-prd.md`.

## Non-negotiables

- No checkout code path exists in the Kroger API client — nothing is ever
  purchased automatically, and Kroger's Public API has no checkout endpoint
  to build one against in the first place.
- Nothing is added to the cart without an explicit human approve step.
- No unsupported inference in extraction — every field is evidenced or
  `null` with a reason.
- No secrets in git; Kroger credentials are never seen or stored — the user
  authenticates directly with Kroger via standard OAuth2, and only the
  resulting token pair (encrypted at rest) is kept.
- Media temp files are deleted after every run.

## Getting started

Requires Node.js ≥22.5.0, `ffmpeg`, a Kroger developer account (free,
self-service — register at [developer.kroger.com](https://developer.kroger.com)),
and a Kroger customer account for the target store.

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, OCR/ASR keys, KROGER_CLIENT_ID/SECRET, KROGER_TOKEN_KEY
```

Run the CLI directly with `tsx`, or build first:

```bash
npm run cli -- <tiktok-url>   # dev
npm run build && recipecart <tiktok-url>   # built
```

Other scripts:

```bash
npm test              # vitest
npm run lint           # eslint
npm run format         # prettier
npm run spike:tiktok   # Phase 0 risk spike: yt-dlp + frame/audio extraction
```

## Project layout

```
src/
  cli.ts                  CLI entry point
  pipeline/                extraction: caption parsing, OCR/ASR, reconciliation, schema
  kroger/                  Kroger Public API client (OAuth2, search, cart)
  matcher/                 deterministic ingredient → product matching
  platform/                config, storage, logging
spikes/                   throwaway Phase 0 risk-spike scripts (incl. archived
                          H-E-B automation investigation — see spike-notes.md)
files/                    PRDs, technical specs, and phase plan
```

## Status

Draft / Phase 0–1 — barebones local pipeline under active development. See
[`files/phases.md`](files/phases.md) for current phase and exit criteria.
