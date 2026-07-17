# Spec 4 — Backend Platform, Hosting & Orchestration

**Source PRD:** `component-4-backend-platform-prd.md` (Draft v1, July 16, 2026)
**Siblings:** Spec 1 (Capture & Review) · Spec 2 (Extraction) · Spec 3 (Matching & Cart) · `phases.md`
**Status:** Draft for review — July 16, 2026
**Phase tags:** `[P1]` local-first storage · `[P3]` service shape · `[P4]` cloud deployment · `[P5]` ops polish

## 1. Overview & Scope

The connective tissue: storage, job orchestration, the phone-facing API, secrets, and deployment. **This spec owns**: the job-state machine, the REST endpoint table, the data model, idempotency, and secrets/encryption. Per the MVP-first phasing, it is deliberately sequenced **local-first**: the platform starts as a `.env` file and SQLite under a CLI, becomes a two-service app with Postgres in Phase 3, and only reaches Railway in Phase 4 — the PRD's target architecture is the Phase 4 end state, not the starting point.

## 2. Technical Design

### 2.1 Local-first storage `[P1]`
- SQLite (or flat JSON files) under `./data/`; per-job temp media dir deleted at terminal state.
- Secrets in `.env` (gitignored): `ANTHROPIC_API_KEY`, ASR/OCR keys, `HEB_SESSION_KEY` (symmetric key encrypting the local storage-state file).
- No queue, no auth, no HTTP — Specs 2/3 modules invoked directly by the CLI. The one piece of "platform" built properly even here: **structured logging with field-name redaction** (tokens, keys, session state never logged) — cheap now, painful to retrofit.

### 2.2 Service shape `[P3]`
- Two processes from one codebase: `web` (API only — never runs yt-dlp/ffmpeg/Playwright/Claude) and `worker` (polls the queue, runs everything long-running). Local dev via Docker Compose mirroring this shape.
- **Postgres** replaces SQLite (concurrent web+worker access is exactly SQLite's weakness). Migration is mechanical if the P1 schema already mirrors §2.4.
- **Postgres-backed queue:** `jobs` table polled ~2s with `SELECT … FOR UPDATE SKIP LOCKED`; single job at a time (avoids concurrent H-E-B sessions; matches volume). Redis/BullMQ explicitly deferred.
- Worker heartbeat (`locked_at` refresh); stale in-progress jobs past threshold → requeued if the stage is re-runnable, `Failed` if not (mid-cart-mutation). Graceful shutdown: finish-or-checkpoint on SIGTERM.

### 2.3 Job-state machine `[P3]` (owned here; Spec 1 renders it, Specs 2/3 drive it)
```
Received → Validating → Downloading → Processing media → Extracting recipe
   → Matching products → Awaiting review → Approved → Adding to cart
   → Completed | Partially completed
(any) → Failed        (Downloading/Extracting/Adding) → Requires user intervention → resume | Expired
(Awaiting review / Requires intervention, N days idle) → Expired
```
Transition ownership per PRD C4 §10 table. `jobs.stage` is the progress representation — no percentage system.

### 2.4 Data model `[P1 subset: recipes/ingredients/product_matches/cart_runs; P3 full]`
Entities per PRD C4 §14: `users` (device_token_hash), `preferences`, `recipes`, `ingredients` (evidence jsonb), `product_matches` (candidates jsonb, requires_approval), `jobs` (status, stage, locked_by, locked_at, run_after, attempt_count, last_error), `cart_runs` (results jsonb, idempotency_key), `heb_sessions` (encrypted_storage_state, store_location, last_verified_at), `events` (append-only, event contracts from Specs 2/3).

### 2.5 REST API `[P3]` (owned here; Spec 1 is the consumer — full table per PRD C1 §18)
`POST/GET /api/recipes` · `GET/DELETE /api/recipes/:id` · `PATCH …/ingredients/:iid` · `POST …/ingredients` · `PATCH …/matches/:iid` · `POST …/cart:approve` (requires `Idempotency-Key`) · `GET …/cart` · `POST …/reprocess` · `GET/PATCH /api/preferences` · `POST/GET /api/heb/session` · `DELETE /api/account/data` · `GET /health`.

- **Auth:** single device-bound bearer token; stored **hashed** in `users.device_token_hash`; maps to a `user_id` from day one (multi-user later is additive, not a migration). "Log out this device" = token revocation.
- **Idempotency:** job creation — derived key (token + source URL + time window) so a double-tapped share surfaces the existing job; cart approval — client-supplied `Idempotency-Key`, replay returns the original result. Spec 3's fresh cart read is the independent second layer.
- Duplicate source URL detection → "view existing / reprocess" response for Spec 1.

### 2.6 Secrets & encryption `[P1 basics, P3/P4 full]`
- HTTPS everywhere (Railway default) `[P4]`.
- H-E-B storage-state encrypted at rest with an app-level symmetric key held **only** in an env var — key never co-located with data; DB compromise alone yields nothing usable.
- Device token hashed like a password. No other field-level encryption at this scale.
- Log redaction by field name at the logging layer, not per call site.

### 2.7 Deployment `[P4]`
- **One Dockerfile** layering yt-dlp, ffmpeg, Playwright + Chromium, OCR deps, app code — image will be big; order layers for caching (system deps → browser → language deps → app code) from the first build.
- **Railway:** one project, two services from the same image with distinct start commands; managed Postgres; volume attached to `worker` for temp media (TTL sweep scheduled); GitHub auto-deploy on push to main; `/health` wired to deploy checks; brief rolling-restart gap accepted.
- Environments: local Docker Compose = development; **no staging** for MVP; production = the Railway pair. Distinct env-var values per environment.
- Ops `[P4/P5]`: Railway log viewer + free-tier external uptime ping on `/health`; Postgres backup retention verified and a manual restore performed once and documented; periodic manual secret rotation.

## 3. Setup & Environment

| Phase | Needs |
|---|---|
| P1 | Runtime toolchain (A4-1), `.env`, SQLite, local ffmpeg/yt-dlp/Playwright |
| P3 | Docker Compose, Postgres (local container), migration tool |
| P4 | Railway account + plan (A4-3), GitHub repo connected, domain/URL (A4-4), uptime monitor (A4-5) |

**Cost target `[P4]`:** Railway Hobby plan ($5/mo base incl. $5 usage) — low single digits to ~$15–20/mo. A forced Pro upgrade is a right-sizing signal (worker likely over-provisioned), not a cost to absorb. Worker sizing needs Chromium headroom (heaviest process); web stays small. Confirm current rates at railway.com/pricing before committing. Claude cost is a non-factor (<$0.05/recipe, Spec 2 §2.5).

## 4. Open Action Items

- [ ] **A4-1 — Runtime language/framework.** ⚠️ **Gates all four specs — decide before Phase 1.** Recommendation: **TypeScript/Node** — Playwright is first-class there (Spec 3 is the riskiest component), one language across web/worker/frontend, solid Postgres tooling (e.g., Fastify/Express + a query builder or Prisma). Python is the alternative if the OCR/media ecosystem ends up mattering more than Playwright ergonomics.
- [ ] **A4-2 — P1 storage: SQLite vs flat files.** Recommendation: SQLite with the §2.4 subset schema — makes the P3 Postgres migration near-mechanical.
- [ ] **A4-3 — Railway account + plan confirmation** (Hobby to start). Before P4.
- [ ] **A4-4 — Web app URL/domain** (Railway subdomain is fine for a private beta; custom domain optional). Before P4.
- [ ] **A4-5 — Uptime monitor choice** (any free-tier pinger). Before P4/P5.
- [ ] **A4-6 — Expiry TTLs:** N days for `Awaiting review → Expired` (recommendation: 14) and the stale-lock threshold (recommendation: 10 min heartbeat staleness).

## 5. Blockers

None hard — this spec has no unknown external dependencies. It is, however, the **critical path from Phase 3 on**: Specs 1–3 all run inside its shapes, so schedule its P3 work before the Spec 1 UI can start. The only external risk is Railway pricing/feature drift; verify at signup.

## 6. Considerations

- **Setup:** Even in P1, keep Spec 2/3 code shaped as worker-stage functions with a job-context argument — the P3 wrap then adds orchestration around unchanged pipeline code instead of a refactor. Build the log-redaction layer in P1 (§2.1) and verify it in P5 with a real-token probe against the live log viewer, per the PRD's acceptance criterion.
- **Functionality:** Retry policy is failure-class-aware (Spec 2 §3 table is authoritative — "video private" never retries); cart mutation relies on idempotency + read-after-write, never blind retries. Recipe history persists indefinitely until user-deleted; `DELETE /api/recipes/:id` and the full wipe are first-class and immediate; H-E-B session deletion is independent of recipe history. Redeploy-safe jobs: stage state persisted in the `jobs` row so restarts skip completed stages where the volume survived — best-effort, not a guarantee across volume-wiping redeploys.
- **Scale posture:** Right-sized for 1–low-tens of users on purpose. The pre-identified growth changes (Redis queue, bounded worker concurrency, object storage, multi-tenant sessions, staging env) are documented and deliberately unbuilt.

## 7. Deployment Checklist `[P4/P5]` (from PRD appendix — the P4/P5 exit gate)

- [ ] Dockerfile builds with yt-dlp, ffmpeg, Playwright + Chromium, OCR deps, cached layers
- [ ] `web` + `worker` as two Railway services from one image, distinct start commands
- [ ] Managed Postgres provisioned; connection string in env for both services
- [ ] All API keys as Railway env vars; nothing in git
- [ ] H-E-B session encryption key set as env var, distinct from DB credentials
- [ ] `/health` responding and wired into deploy checks
- [ ] GitHub auto-deploy on main
- [ ] Worker volume attached; TTL sweep scheduled
- [ ] Log redaction verified with a real token/key probe
- [ ] External uptime monitor on `/health`
- [ ] Postgres manual restore tested once and documented
- [ ] Device-token issuance tested from a fresh Shortcut install
- [ ] H-E-B guided login tested end-to-end; only session state persisted
