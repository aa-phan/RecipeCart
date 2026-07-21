# Backend Platform, Hosting, and Orchestration — Product Requirements Document

**Product:** RecipeCart — TikTok Recipe → Kroger Cart Automation (working name)
**Component:** 4 of 4 — Backend Platform, Hosting, and Orchestration
**Sibling documents:** Component 1 (Mobile Capture & Review) · Component 2 (TikTok Media & Recipe Extraction) · Component 3 (Kroger Product Matching & Cart Automation)
**Scope:** Single user / small private beta
**Status:** Draft v2 — July 17, 2026 (retailer pivot from H-E-B to Kroger; see `spike-notes.md` and Component 3 for rationale)

### Shared assumptions this document owns and defines
This is the document the other three inherit their infrastructure assumptions from. If a sibling PRD references "the job system," "the device token," or "encrypted session storage," this is where it's specified.

---

## 1. Executive Summary
This component is the connective tissue: one Railway-hosted backend that accepts requests from the phone, runs long media/browser-automation jobs in the background, persists everything, and stays operable by a single developer without becoming a part-time job in itself. The core design principle is **earn complexity, don't front-load it** — start with the smallest architecture that's honest about the real constraints (a worker needs to run Chromium and ffmpeg; jobs need durable state), and have a clear, non-rewrite path to more capacity if the private beta grows.

## 2. Problem Statement
Connecting a phone-triggered capture flow to a multi-stage pipeline (download → extract → match → automate a browser → report back) requires durable job state, background processing outside the request/response cycle, secret and session management, and a deployment story that doesn't require AWS-grade expertise to operate. Getting this wrong either means an over-engineered personal project that's a burden to run, or an under-engineered one that loses jobs on every redeploy.

## 3. Platform Goals
- One `git push` deploys the whole system.
- A crashed worker or a redeploy never silently loses an in-flight job.
- Nothing sensitive (API keys, the Kroger OAuth token pair, the device token) is ever logged or committed.
- Hosting cost stays in personal-hobby-project territory, not needing a budget conversation.
- The architecture can absorb "a few more trusted users" without a rewrite, even though it's not designed for that today.

## 4. Non-Goals
- Not building for horizontal scale, multi-tenant isolation, or high availability in v1 — this is a personal/private-beta tool.
- Not standing up a full observability stack (Prometheus/Grafana/etc.) at this scale.
- Not maintaining a dedicated staging environment in v1 (see §22).
- Not solving AWS-equivalent problems this platform doesn't have — no VPC design, no IAM policy trees, no multi-region failover.

## 5. Architecture Recommendation
**MVP:** one Railway project, one Docker image (containing yt-dlp, ffmpeg, Playwright + Chromium, an OCR dependency, and the application code), deployed as **two Railway services from that same image** — `web` (API, request/response only) and `worker` (polls the job queue, does everything long-running: download, media processing, Claude calls, browser automation) — sharing one Railway-managed Postgres database.

This is deliberately **not** a single combined process. Splitting `web`/`worker` from day one keeps the phone-facing API responsive regardless of what the worker is doing (a stuck Chromium session should never make `GET /api/recipes` slow), while still deploying as one coherent unit from one repo — a `git push` redeploys both consistently, and there's no separate release coordination to manage.

| Option considered | Verdict |
|---|---|
| Single all-in-one Railway service (API + worker in one process) | Rejected — a long-running Playwright/ffmpeg task could starve the API's responsiveness for no real savings, since Railway bills `web`/`worker` from the same repo about as simply as one service. |
| Separate API and worker services (recommended) | Adopted for MVP — clean isolation, same deploy pipeline, independent scaling later if needed. |
| Railway-managed PostgreSQL | Adopted — see §13. |
| SQLite on a persistent volume | Rejected — concurrent `web` + `worker` write access and volume durability across redeploys are exactly the failure modes SQLite is weakest at; Postgres is barely more setup effort on Railway. |
| Postgres-backed job queue | Adopted for MVP — see §16. |
| Redis-backed job queue (e.g., BullMQ) | Deferred — an extra always-on service to run/pay for/operate, not justified by single-user job volume (a handful of jobs per day, not per second). Revisit if scheduling/priority needs grow. |
| Temporary filesystem storage | Adopted for MVP — see §15. |
| Object storage (S3-compatible) | Deferred until evidence-image retention becomes a real opted-in feature. |
| Polling vs. push notifications | Polling for MVP (Component 1); push is a native-app, post-MVP capability. |

## 6. MVP Architecture
```
iOS Shortcut (share sheet)
        │  POST /api/recipes  (device-token auth)
        ▼
Railway "web" service  ── reads/writes ──►  Railway PostgreSQL
        │  (creates job row, returns job_id immediately)
        ▼
jobs table (Postgres-backed queue: status, locked_by, locked_at, run_after)
        ▲  polls every ~2s, SELECT … FOR UPDATE SKIP LOCKED
        │
Railway "worker" service
        │
        ├─► yt-dlp + FFmpeg (download, extract audio/frames)      — Component 2
        ├─► OCR + Speech-to-text APIs                              — Component 2
        ├─► Claude API (reconciliation, vision escalation, ambiguity judgment) — Components 2 & 3
        ├─► Kroger Public API (product search, cart-add via OAuth2) — Component 3
        └─► Railway volume (per-job temp dir, deleted at terminal state)

Mobile web app  ── polls ──►  Railway "web" service (status, review, approval)
```

## 7. Production-Like Personal Architecture
Same shape, matured for a slightly larger trusted group without becoming enterprise infrastructure: `web`/`worker` scaled independently based on observed load; structured logs shipped to Railway's built-in log viewer with a lightweight external uptime check; scheduled Postgres backup verification (not just trusting the default); secrets rotated on a periodic schedule; object storage (e.g., an S3-compatible provider) added if evidence-image retention is turned on. Redis-backed queueing, multi-tenant Kroger token storage, and a Kroger Partner-tier application (removes daily rate limits, adds cart-read access) are the next real architectural changes, deliberately deferred until there's evidence they're needed.

## 8. Component Diagram (Service Boundaries)
| Service | Runs | Talks to | Does NOT do |
|---|---|---|---|
| `web` | Railway service, always-on, lightweight | Postgres (read/write job + recipe state), receives phone requests | Never runs yt-dlp, ffmpeg, or Claude calls directly — those are worker-only |
| `worker` | Railway service, polls Postgres for queued jobs | Postgres, external APIs (Claude, ASR, OCR), TikTok (via yt-dlp), Kroger Public API (product search, cart-add), Railway volume | Never accepts direct inbound requests from the phone — only pulls work from the queue |
| Postgres | Railway-managed | `web` and `worker` | — |
| Railway volume | Attached to `worker` | Temp job files only | Never holds anything long-lived; nothing here survives a job's terminal state |

## 9. Request and Job Lifecycle
1. Phone → `web`: `POST /api/recipes` with source URL + device token + idempotency key.
2. `web` creates a `jobs` row (`status = received`), returns `job_id` synchronously.
3. `worker` picks up the row on its next poll, advances it through extraction and matching automatically.
4. Job reaches `awaiting_review`; phone polls `web` and renders it (Component 1).
5. Phone → `web`: `POST /api/recipes/:id/cart:approve` on user approval, with its own idempotency key.
6. `worker` picks up the cart-add task, runs Playwright, reports itemized results.
7. `web` serves the final state to the phone on the next poll.

## 10. Job-State Model
```
Received → Validating → Downloading → Processing media → Extracting recipe
   → Matching products → Awaiting review → Approved → Adding to cart
   → Completed | Partially completed
(any state) → Failed
(Downloading/Extracting/Adding to cart) → Requires user intervention → (resumes forward) | Expired
(Awaiting review / Requires user intervention, no action for N days) → Expired
```

**Ownership per transition:**
| Transition | Owned by |
|---|---|
| → `Received` | `web` (Component 4), on behalf of Component 1's request |
| `Validating` → `Downloading` → `Processing media` → `Extracting recipe` | `worker`, running Component 2's pipeline |
| `Extracting recipe` → `Matching products` | `worker`, automatic hand-off into Component 3's ranking (no user action) |
| `Matching products` → `Awaiting review` | `worker`/`web`, once ranking completes |
| `Awaiting review` → `Approved` | `web`, on receipt of the user's cart-approval request (Component 1) |
| `Approved` → `Adding to cart` → `Completed`/`Partially completed` | `worker`, running Component 3's automation |
| → `Failed` | Whichever component's stage failed emits the failure class (Component 2 or 3 logic); `web`/`worker` records it and applies the shared retry policy (§16) |
| → `Requires user intervention` | Component 3 (session expired/CAPTCHA/MFA) or Component 2 (an access issue needing a different link) — `web` owns routing the resulting notification to Component 1 |
| → `Expired` | `worker`'s scheduled sweep, TTL-based, no user component involved |

## 11. API Requirements
The `web` service exposes the REST surface Component 1 consumes in full (see Component 1 §18 for the endpoint table) plus internal health/readiness endpoints for Railway's deploy checks. All mutating endpoints validate the device token; job-creation and cart-approval endpoints require an `Idempotency-Key` header and reject/replay-safe a duplicate key rather than creating a second job or cart run.

## 12. Background-Worker Requirements
- Polls the `jobs` table on a short interval (~2s) using `SELECT … FOR UPDATE SKIP LOCKED` so a single worker instance never double-processes a row (and this pattern stays correct if a second worker instance is ever added).
- **Single job at a time for MVP** is an explicit, accepted simplification that matches single-user job volume; not a scalability decision to revisit until there's real concurrent demand. (The original H-E-B design also needed this to avoid concurrent browser sessions — Component 3's Kroger API client is stateless per-call, so that specific constraint no longer applies, but the simplification is kept anyway.)
- Graceful shutdown: on a Railway redeploy/stop signal, the worker finishes or safely checkpoints the current job rather than abandoning it mid-cart-mutation.
- Crash recovery: a job stuck "in progress" past a staleness threshold with no heartbeat update is requeued (if the stage is safely re-runnable) or marked `Failed` (if it isn't, e.g., mid-cart-mutation) — never left stuck indefinitely.

## 13. Database Requirements
Railway-managed PostgreSQL from day one. Rationale: `web` and `worker` need genuinely concurrent read/write access to job state; managed backups and connection handling remove an entire category of operational risk that a volume-mounted SQLite file would carry across redeploys; the setup cost difference on Railway is minimal enough not to justify the tradeoff.

## 14. Data Model Overview (Proposed Entities)
| Entity | Purpose | Key fields |
|---|---|---|
| `users` | One row per device/household in MVP; shaped for future multi-user growth | `id`, `device_token_hash`, `created_at` |
| `preferences` | Store-brand/organic/dietary/pantry defaults | `user_id`, `store_brand_preferred`, `organic_preferred`, `dietary_tags[]`, `pantry_always_owned[]` |
| `recipes` | One per submitted TikTok URL | `id`, `user_id`, `source_url`, `title`, `creator_handle`, `overall_confidence`, `created_at` |
| `ingredients` | Extracted line items | `id`, `recipe_id`, `raw_text`, `canonical_name`, `quantity`, `unit`, `pantry_staple`, `confidence`, `evidence` (jsonb) |
| `product_matches` | Ranked candidates per ingredient | `id`, `ingredient_id`, `candidates` (jsonb), `selected_product_id`, `requires_approval`, `approval_reason` |
| `jobs` | Generic job/queue table driving §10's state machine | `id`, `recipe_id`, `status`, `stage`, `locked_by`, `locked_at`, `run_after`, `attempt_count`, `last_error` |
| `cart_runs` | One per cart-add attempt (a recipe may have more than one over time) | `id`, `recipe_id`, `status`, `results` (jsonb), `approved_at`, `idempotency_key` |
| `kroger_auth` | Encrypted Kroger OAuth2 token pair (replaces the original `heb_sessions` table) | `id`, `user_id`, `encrypted_access_token`, `encrypted_refresh_token`, `expires_at`, `store_location_id`, `last_refreshed_at` |
| `events` | Append-only audit/event log for the event contracts in Components 2 & 3 | `id`, `job_id`, `event_type`, `payload` (jsonb), `created_at` |

## 15. Temporary-Storage Requirements
Video/audio/frames live under a per-job directory on a Railway volume attached to `worker`; deleted immediately when a job reaches any terminal state; a scheduled sweep deletes anything past a 24-hour TTL as a backstop for orphaned files from crashed jobs. No evidence media is written to Postgres or object storage by default in MVP (Component 2 §19/§21).

## 16. Queue and Retry Requirements
Postgres-backed queue as described in §12; shared retry policy: transient failures retry with exponential backoff up to a capped attempt count (3, matching Component 2's model-call policy), after which the job moves to `Failed` with the specific `failure_class` from whichever component's stage failed. Retries are always safe to re-run for stages before `Adding to cart`; the cart-mutation stage itself relies on idempotency (§17) rather than blind retries, since a retried browser action against a real cart is a different risk profile than a retried API call.

## 17. Idempotency Requirements
- `POST /api/recipes`: idempotency key derived from (device token, source URL, short time window) prevents a double-tapped share from creating two jobs — surfaces the existing job instead.
- `POST /api/recipes/:id/cart:approve`: requires an explicit client-supplied `Idempotency-Key`; a retried request with the same key returns the original result rather than re-running cart automation.
- Worker-side: the actual Playwright add-to-cart action re-reads the cart before adding (Component 3 §17) as a second, independent layer of protection against duplicate adds even if the API-level idempotency were somehow bypassed.

## 18. Authentication and Authorization Requirements
Single device-bound bearer token per Component 1 §12; stored hashed (never plaintext) in `users.device_token_hash`, compared on each request the way a password hash would be — even though it isn't a password, treating it with the same care costs nothing and avoids a plaintext-secret-in-the-database mistake. Token maps to a `user_id` from day one, not a global singleton assumption, so multi-user support later is additive rather than a migration.

## 19. Secret-Management Requirements
API credentials (Claude, ASR provider, OCR provider, Kroger `client_id`/`client_secret`) live in Railway environment variables, never in git, never in logs. Distinct values per environment (§22). The Kroger OAuth token pair (`kroger_auth`) is dynamic per-deployment data, not a static secret — it's stored in Postgres, encrypted with a key that itself lives only in a Railway env var (§20), so compromising the database alone doesn't expose a usable token.

## 20. Encryption Requirements
- HTTPS everywhere (Railway default).
- The Kroger OAuth token pair encrypted at rest using an app-level symmetric key held only as a Railway environment variable — envelope-style, so the encryption key is never co-located with the encrypted data.
- Device token stored as a hash, not plaintext (§18).
- No other field currently warrants field-level encryption at this scale; revisit if multi-user household data materially raises the sensitivity bar.

## 21. Deployment and Continuous-Delivery Requirements
GitHub-connected Railway auto-deploy on push to the main branch; single Dockerfile layering yt-dlp, ffmpeg, Playwright + Chromium, and OCR dependencies alongside the application code — this image will be sizable, so build caching is worth setting up early rather than tolerating slow deploys indefinitely; a `/health` endpoint on `web` for Railway's deploy verification; a brief rolling-restart gap during deploys is an accepted tradeoff at this usage scale rather than something worth engineering blue/green deployment around.

## 22. Environment Strategy
**Development:** local Docker Compose (or a local Railway environment) mirroring the two-service shape. **Staging:** skipped for MVP — the cost/complexity isn't justified for a true single-user personal project; a Railway preview/PR environment (if available) or careful feature-branch review substitutes for now. A real staging environment is added if the beta group grows enough that untested changes reaching "production" carries real risk to other people's data. **Production:** the always-on `web`/`worker` pair described above.

## 23. Logging, Metrics, and Alerting Requirements
Structured JSON logs from both services; **device tokens, Kroger OAuth tokens, and full API keys are never logged**, full stop — this is enforced as a logging-layer rule (redact-by-field-name), not left to each call site to remember. Railway's built-in log viewer is sufficient at this scale. Basic alerting: a scheduled external ping against `/health` (a free-tier uptime monitor is enough) triggering an email/notification on failure. A full metrics/alerting stack (Prometheus/Grafana) is explicitly not built for MVP — noted in §4 as a deliberate non-goal, not an oversight.

## 24. Failure Recovery and Disaster-Recovery Requirements
Railway-managed Postgres automated backups, with retention settings verified (not assumed) and a documented manual-restore procedure written down at least once. Worker crash recovery per §12. Redeploy-safe job handling: intermediate stage outputs' state is persisted in the `jobs` row so a job resumed after a process restart can skip stages already completed within that deploy where practical (e.g., doesn't necessarily need to re-download a video it already has locally, if the volume survived the restart) — not a strict requirement to survive a full redeploy that wipes the volume, just to avoid needless repeated work where the environment allows it.

## 25. Privacy and Data-Retention Requirements
Recipe, ingredient, and match data persists indefinitely until the user deletes it (their data, low volume, genuinely useful as history) — but a `DELETE /api/recipes/:id` and a `DELETE /api/account/data` (full wipe) are both first-class, immediately-effective endpoints (Component 1 §18). Raw source media never persists beyond job completion (§15). Kroger token data is deletable independently (disconnecting Kroger doesn't require deleting recipe history, and vice versa).

## 26. Performance and Scalability Requirements
Explicitly right-sized for 1 to low-tens of users, not viral scale — and that's a stated design choice, not an unexamined limitation. The concrete list of what changes if usage grows past that: swap the Postgres-backed queue for Redis/BullMQ (§5); move `worker` from single-job-at-a-time to bounded concurrency; add object storage if evidence-media retention is wanted at volume; build real multi-tenant Kroger token management (Component 3 §25); apply for Kroger's Partner API tier to remove daily rate limits. None of these are built preemptively.

## 27. Hosting-Cost Targets
Based on current published Railway pricing: the Hobby plan has a **$5/month base that includes $5 of usage**, with the Pro plan at **$20/month base including $20 of usage** for higher resource ceilings; both bill additional vCPU/RAM/egress/volume usage above the included credit at per-second rates. A single-user deployment's actual cost depends heavily on how much the `worker` service sits idle versus actively running Chromium/ffmpeg — an always-on, generously-provisioned worker could push costs toward the Pro tier, while a worker that's mostly idle between infrequent jobs should stay much closer to the Hobby minimum. **Target: stay on the Hobby plan (low single-digit dollars to roughly $15–20/month) for the private-beta phase**, and treat needing to upgrade to Pro as a signal worth noticing, not just paying through — it likely means the worker is provisioned larger than actual job volume requires. Exact current rates should be confirmed at railway.com/pricing before committing, since usage-based pricing is subject to change. Claude API cost is not a meaningful driver of this budget (Component 2 §18 estimates a few cents per recipe).

## 28. Dependencies on the Other Three Components
This document is the dependency target for the other three (§10's ownership table, §14's data model, and the API/event contracts each sibling PRD references). In the other direction, this component depends on: Component 1 for the API contract shape it must serve; Component 2 for the worker-stage interface and event payloads it must persist and route; Component 3 for the encrypted-session and cart-mutation safety requirements it must enforce infrastructurally.

## 29. API and Event Contracts
See Component 1 §18 for the phone-facing REST surface and Components 2 §23 / 3 §23 for the internal event contracts this platform routes between worker stages. This document's addition is the `jobs`/`events` table schema (§14) that makes those contracts durable and replayable.

## 30. MVP Scope
Two-service Railway deployment (`web`/`worker`) from one Docker image (no browser/Chromium dependency); Railway-managed Postgres; Postgres-backed queue; local-volume temp storage with immediate deletion; device-token auth with hashed storage; encrypted Kroger OAuth token storage; GitHub auto-deploy; structured logging with credential redaction; basic external health-check alerting; no staging environment; no object storage.

## 31. Post-MVP Roadmap
Redis-backed queue if job volume/scheduling needs grow; independently-scaled `web`/`worker` with bounded worker concurrency; object storage for opted-in evidence retention; a real staging environment if the beta group grows; multi-tenant Kroger token support; a Kroger Partner-tier application (removes daily rate limits, adds cart-read access); periodic secret rotation automation; a genuine metrics/alerting stack if operational complexity outgrows Railway's built-in tooling.

## 32. Acceptance Criteria
- [x] A `git push` to main results in both `web` and `worker` redeploying consistently from the same commit. Verified repeatedly this session, not just once: `git log` shows commits through `672834f` on `main`, each pushed live; `docs/deploy-railway.md` §C.6/§D records the auto-deploy config (both services' **Settings → Source** on `main` with Auto Deploy on, `worker` via a service-scoped `railway.worker.toml` so it doesn't inherit `api`'s root `railway.toml` start command). `railway status` this session shows both `worker` and `RecipeCart` (the Railway-named `api` service) **● Online** off the same repo (`aa-phan/RecipeCart`), same environment, with a current `worker` deployment ID (`7fdfadba-2aa5-4a2b-90f6-036e3c7287df`) — consistent with the repeated live push-and-redeploy already done today rather than re-triggering another push just to re-confirm.
- [x] A `worker` crash mid-job results in that job being requeued or cleanly marked `Failed` — never left silently stuck. Split verification, being explicit about which half is machine-proven vs. which needed a human this session: the **automatic** mechanism is `requeueStaleJobs()` (`src/platform/jobs.ts:283-323`), wired into the worker's main loop on a 30s interval (`config.jobs.staleSweepIntervalMs`, `src/worker/index.ts:44-54`) — it requeues stale-locked jobs in re-runnable stages back to `received`, and stale-locked `adding_to_cart` jobs to `requires_user_intervention` (never blind-retried, since that stage mutates a real cart). This is unit-tested end-to-end in `src/platform/jobs.test.ts:106-146` ("requeues a stale re-runnable job and pauses a stale cart mutation") against real backdated `locked_at` timestamps, plus a regression test (`jobs.test.ts:154-182`) for a live-caught bug where a stale `last_error` message survived into a later successful finish. Separately, this session's real ASR-OOM crash-loop incident (`docs/deploy-railway.md` lines 19-60) needed **manual** intervention — two jobs were hand-marked `failed` in production Postgres with explicit user authorization, because they were stuck mid-ASR (a re-runnable stage) but past the point where letting the automatic requeue keep re-crashing them was useful; that manual step doesn't itself prove the automatic path works — the `jobs.test.ts` coverage above is what proves that.
- [x] No API key, device token, or Kroger OAuth token ever appears in application logs (verified by a redaction check, not just code review). Confirmed at two levels: (1) `src/platform/logger.ts` redacts by field-name pattern (`token`, `api[_-]?key`, `secret`, `password`, `session[_-]?state`, `storage[_-]?state`, `authorization`, `cookie` — case-insensitive substring match, recursive through nested objects/arrays, lines 11-46) at the single shared `logger` used by both the `api` and `worker` processes — not a per-call-site convention, so nothing can leak by a call site forgetting to redact. (2) `docs/deploy-railway.md` §D (lines 375-389) records this session's real redaction drill: a real device token minted via `POST /api/setup/device-token`, driven through several authenticated requests plus a deliberate 401 unhappy path, then `railway logs --service RecipeCart` and `railway logs --service worker` both grepped for the raw token substring — zero matches in either service. That drill also confirms the request logger only ever serializes `method`/`url`/`hostname`/`remoteAddress`/`remotePort`/`statusCode`, never headers or the token itself, and that `src/api/lib/auth.ts` never logs the token on any path including the failure path — so the redaction check genuinely covers both services' logs, not one narrow path.
- [x] A duplicate `POST /api/recipes` with the same idempotency key returns the existing job, not a new one. `src/api/routes/recipes.ts`'s `POST /` handler calls `enqueueJob(sourceUrl, request.userId)` (`recipes.ts:57`) with no bypass flag, so it goes through `src/platform/jobs.ts`'s dedup path: `deriveIdempotencyKey` hashes `(userId, resolved video id, time-bucket)` and `enqueueJob` looks up an existing row on that key before inserting (`jobs.ts:102-109`), returning `{ job: existing, created: false }` on a hit, with a race-safe fallback if a concurrent insert wins first (`jobs.ts:127-137`). Directly unit-tested: `jobs.test.ts:21-33` ("enqueues a new job and de-dupes an identical re-submit") plus two short-link-specific cases (`jobs.test.ts:40-70`) covering a real production gap found via live iOS Shortcut testing this session — two different TikTok share short-links resolving to the same video now correctly dedupe instead of creating two jobs.
- [x] A duplicate cart-approval request with the same idempotency key never triggers a second cart-automation run. `src/kroger/cart_runner.ts`'s `runCartApproval` checks `loadExistingRun(idempotencyKey)` against the `cart_runs.idempotency_key` UNIQUE column **before** any network call (`cart_runner.ts:511-529`) — a terminal-status existing run replays its stored result without re-adding; a `requires_user_intervention` run resumes, re-attempting only items not already `added` (matched by ingredientId/upc/fallback-upc, `isAlreadyAdded`, `cart_runner.ts:205-212`), never re-sending an already-succeeded item. Tested directly at both layers: `cart_runner.test.ts:267-289` ("idempotent replay: same key returns stored result without calling addToCart again") and route-level `cart.test.ts:188-209` ("replays the same result for a repeated idempotency key without re-adding," asserting the mock Kroger client is not called a second time). The route (`src/api/routes/cart.ts:16-20`) also rejects a missing/empty `Idempotency-Key` header outright (tested in `cart.test.ts:122-132`).
- [x] All temp media for a completed job is gone from the volume within seconds of job completion, and nothing survives the 24-hour TTL backstop. Immediate deletion: `src/pipeline/extract/index.ts`'s whole extraction chain runs in `try/finally` with `cleanupTempDir(jobId)` unconditionally in the `finally` (`index.ts:175-179`, `db.ts:16-19`, `fs.rmSync`) — fires on success or any classified/unclassified failure. TTL backstop: `sweepTempMedia()` (`src/worker/sweeps.ts:19-53`) scans `config.tempMediaDir` and removes per-job subdirectories older than `config.tempMedia.ttlHours`, wired into the worker loop on `config.tempMedia.sweepIntervalMs` (`src/worker/index.ts:73-84`); unit-tested against the real config value in `src/worker/sweeps.test.ts:70-99`. One correction to this criterion's own wording: the TTL is **not actually 24 hours** — it was lowered to **1 hour** (`config.ts:191`, commit `c456760`) after a real incident this session where the volume filled to 100% because the original 6h TTL was too slow to catch orphaned dirs from `SIGKILL`'d (OOM) jobs bypassing the normal `finally` cleanup (`docs/deploy-railway.md` lines 362-374). A 1h backstop still satisfies "nothing survives the 24-hour TTL backstop" (it's strictly tighter), so this passes, but the PRD's own §15/§32 text describing "24-hour TTL" is stale and should be updated to match the real, incident-driven value. Also worth noting live: `railway status` this session shows the worker volume at 415MB/500MB — not overflowing, but not far from the same ceiling that caused the original incident: worth continued watching, not a hard fail here.
- [x] `DELETE /api/account/data` removes all of a user's recipes, ingredients, matches, and Kroger OAuth token data. Re-verified against current code (schema/route has evolved since the prior session's verification): `src/api/routes/account.ts`'s handler runs one transaction deleting from `recipes` (cascading to `ingredients` → `product_matches`, and to `cart_runs`, per FK definitions in `migrations/001_initial.ts`), `jobs` (scoped `where user_id = request.userId`), `kroger_auth` (same scoping), and `preferences` (same scoping) — `users` intentionally kept (device stays registered, data wiped). One genuine, explicitly-documented gap carried over from the code's own header comment (`account.ts:7-11`): `recipes` has no `user_id` column, so the `recipes` delete is **not** scoped per-user — it deletes ALL recipes regardless of which user issued the request. This is a correct no-op today only because the app is single-user (everything maps to `DEFAULT_USER_ID`); it is a real latent gap for the stated "additive, not a migration" multi-user path (§18), not yet exercised because there's only ever been one user in production. There's no standalone `account.test.ts`, but the route is directly covered by a `describe("account routes", ...)` block inside `src/api/routes/preferences.test.ts:102-189` — it seeds real `recipes`/`jobs`/`kroger_auth`/`preferences` rows, calls `DELETE /api/account/data`, and asserts all four are empty afterward while `users` still has its row (lines 111-183), plus a 401-without-token case (lines 185-188). That test only seeds one user's data, so it doesn't itself exercise the multi-user gap above — it confirms the cascade is correct, not that it's correctly scoped, which matches the code's own header comment.

## 33. Open Questions and Recommended Decisions
| Question | Recommendation |
|---|---|
| Is a dedicated queue needed for MVP? | A Postgres-backed queue table, not a separate Redis/queue service — sufficient for single-user job volume. |
| Should the worker run continuously? | Yes — a short polling interval on an always-on service is simpler to reason about than scale-to-zero cold starts for a job system, and Railway's usage-based billing means idle polling is cheap. |
| Should jobs run in separate containers? | Not for MVP — one `worker` service processing one job at a time is simpler and matches volume; revisit only if concurrency becomes a real need. |
| How should retries work? | Exponential backoff, capped at 3 attempts, failure-class-aware (some failures, like "video private," should never retry — Component 2 §16). |
| How should idempotency be implemented? | Client-supplied idempotency keys on job-creation and cart-approval endpoints, checked server-side before creating new state. |
| How should progress be represented? | The `jobs.stage` field, polled by the phone and mapped to plain-language copy in Component 1 — no separate progress-percentage system needed at this granularity. |
| How should source files be deleted? | Immediately at job terminal state, plus a 24-hour TTL sweep as a backstop. |
| How should logs avoid exposing credentials? | Field-name-based redaction enforced at the logging layer, not left to individual call sites. |
| How should the Kroger OAuth token pair be encrypted? | App-level symmetric encryption with the key held only in a Railway env var, data stored separately in Postgres. |
| How should secrets be rotated? | Manual rotation via Railway env vars for MVP; a periodic rotation habit (not automation) is sufficient at this scale, automation is a reasonable post-MVP addition. |
| How should updates avoid interrupting jobs? | Graceful shutdown on the worker (finish-or-checkpoint current job) rather than engineering zero-downtime deploys for a single-user tool. |
| How much persistence is needed for recipe history? | Indefinite, user-deletable — it's genuinely useful and low-volume, not a retention burden. |
| How should the platform recover after crashes/redeploys? | Stuck-job staleness detection + requeue-or-fail (§12), plus stage-state persistence to avoid redundant work where the environment allows it. |
| How should yt-dlp failures / Kroger API failures be monitored? | Failure-class breakdown in observability (Component 2 §20, Component 3 §20) doubles as the early-warning signal for upstream TikTok changes or Kroger API rate-limiting/outages. |
| What hosting limits could interfere with FFmpeg/OCR? | Worker memory/CPU sizing no longer needs Chromium headroom (removed by the Kroger pivot — Component 3 §7); FFmpeg/OCR are comparatively light, so `worker` and `web` can be sized similarly. |
| How should hosting costs be controlled? | Stay on Railway's Hobby tier as the explicit target; treat a forced upgrade to Pro as a signal to right-size the worker rather than a cost to just absorb. |

---

## Appendix: Deployment Checklist
- [x] Dockerfile builds successfully with yt-dlp, ffmpeg, Playwright + Chromium, and OCR dependencies layered and cached. Note: per this component's own §5 pivot table (H-E-B → Kroger removed the browser-automation need), the real Dockerfile has **no Chromium/Playwright dependency** — this line is stale against the actual architecture, not a gap. `docs/deploy-railway.md` §D line 337-339 confirms the real build passed via Railway's own build (no local Docker available, so Railway's first build doubled as the build test) — yt-dlp/ffmpeg/OCR deps layered as described in §0/§C.1.
- [x] `web` and `worker` both configured as Railway services from the same repo/image, with distinct start commands. `docs/deploy-railway.md` §D line 340-344: both online, same GitHub source (`aa-phan/RecipeCart`), `api` → `npm run start:api` (root `railway.toml`), `worker` → `npm run start:worker` (service-scoped `railway.worker.toml`, needed because Railway's root config otherwise applies to every service on the repo). Live-reconfirmed this session: `railway status` shows both `worker` and `RecipeCart` (`api`) **● Online** under the same project/environment.
- [x] Railway-managed Postgres provisioned; connection string injected as an env var to both services. `docs/deploy-railway.md` §D line 345-347: same `DATABASE_URL` on both services, `/health` proves live reachability, not just that the var is set. `railway status` this session shows the `Postgres` database service online alongside both `worker`/`RecipeCart`.
- [x] All external API keys (Claude, ASR, OCR) set as Railway environment variables, not committed to git. `docs/deploy-railway.md` §D line 348-350: set via `railway variable set --stdin` from local `.env`, never committed; §C.5 documents the exact per-service split (`ANTHROPIC_API_KEY` worker-only, etc.) and a `git grep -i "sk-ant\|client_secret"` sanity check against the repo (excluding this doc's own placeholders).
- [x] Encryption key for the Kroger OAuth token pair set as a Railway environment variable, distinct from the database credentials. `docs/deploy-railway.md` §D line 351-353: `KROGER_TOKEN_KEY` freshly generated for production via `crypto.randomBytes(32)`, identical across `api`/`worker` (both decrypt the same token file), explicitly confirmed not copy-pasted from any Postgres credential (§C.5).
- [x] `/health` endpoint responds on `web` and is wired into Railway's deploy checks. `docs/deploy-railway.md` §D line 354-358: `curl -i https://recipecart-production.up.railway.app/health` returned `HTTP/2 200` / `{"ok":true}` against the real production DB. Route itself at `src/api/routes/health.ts` — exempt from device-token auth, checks DB reachability, returns 503 on failure.
- [x] GitHub repo connected with auto-deploy on push to main. `docs/deploy-railway.md` §D line 359-361: confirmed via a real push (this exact checklist update), both services rebuilt/redeployed automatically with no manual trigger. Cross-checked this session via `git log` (commits through `672834f`, all on `main`) and `railway status` showing a current `worker` deployment ID — consistent with repeated real redeploys today rather than re-triggering another push solely to re-verify.
- [x] Volume attached to `worker` for per-job temp storage, with the TTL sweep job scheduled. `docs/deploy-railway.md` §D line 362-374: volume attached and confirmed (`RAILWAY_VOLUME_MOUNT_PATH=/data`); a real incident (volume filled to 100% from OOM-orphaned temp dirs) forced a real test of the mechanism and led to lowering the TTL from 6h to 1h (commit `c456760`). `sweepTempMedia`/`expireStaleReviews` are unit-tested against the real 1h value (`src/worker/sweeps.test.ts`), wired into the worker loop (`src/worker/index.ts:73-84`), but as that doc itself notes, the sweep has **not yet been directly observed firing on its own in production logs** — every cleanup this session was manual SSH intervention, not a live-caught automatic sweep. `railway status` this session shows the worker volume at 415MB/500MB, i.e. not overflowing right now but not far from the ceiling that caused the original incident — worth continued watching. Marked pass on the strength of the unit tests + real incident-driven fix, but the "observed firing live in prod" half remains open, exactly as `docs/deploy-railway.md` already flags.
- [x] Log redaction verified — attempt a request with a real token/key and confirm it doesn't appear in Railway's log viewer. `docs/deploy-railway.md` §D line 375-389: real device token minted via `POST /api/setup/device-token`, driven through several authenticated requests plus a deliberate auth-failure path, `railway logs --service RecipeCart` and `railway logs --service worker` both grepped for the raw token — zero matches in either. Confirmed this covers both services broadly (not one narrow path) by reading `src/platform/logger.ts` (shared field-name redaction used by both processes) and `src/api/lib/auth.ts` (never logs the token, including on the `unauthorized()` path).
- [x] External uptime monitor configured against `/health`. `docs/deploy-railway.md` §D line 390-392: UptimeRobot monitor created and confirmed live via its API — status `2` (up), HTTP(s) type, 300s interval, pointed at the production `/health` URL.
- [x] Manual Postgres restore procedure tested at least once and documented. `docs/deploy-railway.md` §D line 393-399 and full drill record in §E (lines 418-462): real `pg_dump`/`pg_restore` against a local scratch DB (`postgresql@18` client tools, since prod runs Postgres 18.4), `recipes`/`jobs` row counts (1 vs 1 for both) and a known recipe by exact id/title confirmed matching production, scratch DB dropped after. Run 2026-07-20, this session.
- [x] Device-token issuance flow tested end-to-end from a fresh Shortcut install. `docs/deploy-railway.md` §D line 400-405: a real Shortcut built on a real iPhone per `docs/ios-shortcut.md`, a device token minted via `/setup`, real TikTok URLs submitted end-to-end through the share sheet — also surfaced and fixed two real bugs along the way (an `apiPost` Content-Type bug and a redundant dual-auth-flow UX issue).
- [x] Kroger OAuth2 authorization flow tested end-to-end against the production redirect URI, confirming only the token pair (not credentials) is persisted. `docs/deploy-railway.md` §D line 406-414: real consent flow completed against production (`kroger_auth` has a real row with real encrypted access/refresh tokens, not raw credentials), and that connection was actually exercised by a real successful `cart:approve` run (real `cart_runs` row, `status: "completed"`) — which also caught and fixed a real bug (parent job status never updated after a successful cart run, commit `b3f8f89`).
