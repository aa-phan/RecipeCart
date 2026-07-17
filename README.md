# RecipeCart

TikTok Recipe → H-E-B Cart Automation (working name).

RecipeCart takes a TikTok recipe URL and turns it into items in a real H-E-B
cart: it downloads the video, extracts an evidence-backed structured recipe
(caption, on-screen text, and narration), matches each ingredient to an H-E-B
product, and — only after explicit human approval — adds the approved items
to the cart via browser automation.

## Guiding principle

**Prove the pipeline before building the product around it.** The MVP is a
barebones, local, CLI-driven pipeline. Only once a real TikTok URL can reach
a real H-E-B cart end to end do we layer on the things that make it a
product: quality/safety hardening, a backend service, a phone-friendly review
UI, an iOS Shortcut, and cloud deployment. The two genuinely risky unknowns —
TikTok media access (yt-dlp) and H-E-B browser automation (Playwright) — sit
in the pipeline itself and are de-risked first.

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
2. **Matching & cart** (`src/heb/`, `src/matcher/`) — a deterministic matcher
   normalizes each ingredient, searches H-E-B via a Playwright adapter, and
   ranks candidates (in-stock, form fit, quantity-to-package fit, unit
   price). A separate, gated cart runner only adds items after explicit
   human approval; no checkout code path exists anywhere in the adapter.
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
- [Spec 3 — H-E-B Product Matching & Cart Automation](files/specs/spec-3-heb-matching-cart.md)
- [Spec 4 — Backend Platform, Hosting & Orchestration](files/specs/spec-4-backend-platform.md)

Product-level PRDs for each component are in `files/*-prd.md`.

## Non-negotiables

- No checkout code path exists in the H-E-B adapter — nothing is ever
  purchased automatically.
- Nothing is added to the cart without an explicit human approve step.
- No unsupported inference in extraction — every field is evidenced or
  `null` with a reason.
- No secrets in git; H-E-B credentials are never seen or stored, only a
  captured browser session state (encrypted at rest).
- Media temp files are deleted after every run.

## Getting started

Requires Node.js ≥22.5.0, `ffmpeg`, and an H-E-B account for the target
store.

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, OCR/ASR keys, HEB_SESSION_KEY
```

Run the CLI directly with `tsx`, or build first:

```bash
npm run cli -- <tiktok-url>   # dev
npm run build && recipecart <tiktok-url>   # built
```

Other scripts:

```bash
npm test          # vitest
npm run lint       # eslint
npm run format     # prettier
npm run spike:tiktok   # Phase 0 risk spike: yt-dlp + frame/audio extraction
npm run spike:heb      # Phase 0 risk spike: H-E-B login/search/cart via Playwright
```

## Project layout

```
src/
  cli.ts                 CLI entry point
  pipeline/               extraction: caption parsing, OCR/ASR, reconciliation, schema
  heb/                    Playwright adapter for H-E-B (search, cart, session)
  matcher/                deterministic ingredient → product matching
  platform/               config, storage, logging
spikes/                  throwaway Phase 0 risk-spike scripts
files/                   PRDs, technical specs, and phase plan
```

## Status

Draft / Phase 0–1 — barebones local pipeline under active development. See
[`files/phases.md`](files/phases.md) for current phase and exit criteria.
