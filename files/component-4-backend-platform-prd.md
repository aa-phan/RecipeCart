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
- A `git push` to main results in both `web` and `worker` redeploying consistently from the same commit.
- A `worker` crash mid-job results in that job being requeued or cleanly marked `Failed` — never left silently stuck.
- No API key, device token, or Kroger OAuth token ever appears in application logs (verified by a redaction check, not just code review).
- A duplicate `POST /api/recipes` with the same idempotency key returns the existing job, not a new one.
- A duplicate cart-approval request with the same idempotency key never triggers a second cart-automation run.
- All temp media for a completed job is gone from the volume within seconds of job completion, and nothing survives the 24-hour TTL backstop.
- `DELETE /api/account/data` removes all of a user's recipes, ingredients, matches, and Kroger OAuth token data.

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
- [ ] Dockerfile builds successfully with yt-dlp, ffmpeg, Playwright + Chromium, and OCR dependencies layered and cached.
- [ ] `web` and `worker` both configured as Railway services from the same repo/image, with distinct start commands.
- [ ] Railway-managed Postgres provisioned; connection string injected as an env var to both services.
- [ ] All external API keys (Claude, ASR, OCR) set as Railway environment variables, not committed to git.
- [ ] Encryption key for the Kroger OAuth token pair set as a Railway environment variable, distinct from the database credentials.
- [ ] `/health` endpoint responds on `web` and is wired into Railway's deploy checks.
- [ ] GitHub repo connected with auto-deploy on push to main.
- [ ] Volume attached to `worker` for per-job temp storage, with the TTL sweep job scheduled.
- [ ] Log redaction verified — attempt a request with a real token/key and confirm it doesn't appear in Railway's log viewer.
- [ ] External uptime monitor configured against `/health`.
- [ ] Manual Postgres restore procedure tested at least once and documented.
- [ ] Device-token issuance flow tested end-to-end from a fresh Shortcut install.
- [ ] Kroger OAuth2 authorization flow tested end-to-end against the production redirect URI, confirming only the token pair (not credentials) is persisted.
