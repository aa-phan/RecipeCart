# Railway Deployment Runbook (Phase 4)

Manual, human-executed runbook for deploying RecipeCart's `api` and `worker`
services to Railway. This doc mirrors the Deployment Checklist in
[Spec 4 §7](../files/specs/spec-4-backend-platform.md) 1:1 — each checklist
line becomes a numbered deploy step below, plus a matching verification
check in the post-deploy section.

No Railway account access was available while writing this — every step is
written for a human operator to execute by hand, with the exact repo
values/paths filled in. Where a check can't be run ahead of time, the step
says so explicitly.

For the iOS Shortcut side (device-token issuance, Shortcut install/setup),
see `docs/ios-shortcut.md` — this doc stays server/Railway-side only.

---

## ⚠️ Known open issue: worker ASR OOM on Railway (paused, not fixed)

**Found 2026-07-20 via a real production job submission, not a theoretical
concern.** The worker's local Whisper ASR transcription step
(`src/pipeline/extract/asr.ts`) OOM-kills the worker process on Railway's
default 1024MB memory limit — on every real job, including
caption-sufficient ones, since ASR runs unconditionally regardless of the
caption gate outcome (Spec 2 §2.1 — narration is needed for `steps` even
when the caption alone covers ingredients).

**Root cause, isolated with real measurements** (reproduced locally against
real ~59s TikTok audio, not synthetic):
- transformers.js's default dtype in Node.js is full `fp32` (only
  auto-picks a quantized dtype for WASM/browser) — loading `whisper-base`
  at fp32 alone costs **~930MB RSS**. **Fixed** in commit `cebea85`
  (`dtype: "q8"`) — real, verified improvement, kept regardless of the
  rest of this issue.
- However, the memory cost is dominated by **inference** (the actual
  `transcribe()` call), not model loading or precision. Real measurements:
  - `whisper-base`, q8: load ~365-440MB, but **transcribe peaks ~2024MB**.
  - `whisper-tiny`, q8: load ~440MB, but **transcribe still peaks ~1355MB**.
  - Both exceed Railway's 1024MB worker limit. Model-size/precision swaps
    alone do not fix this — the scaling appears tied to chunked-inference
    memory (ONNX Runtime session/arena behavior across `chunk_length_s: 30`
    chunks), not primarily model weight size.

**Status: paused, not resolved** (explicit decision, 2026-07-20) — same
posture as the project's earlier tabled self-hosted-LLM-reconciliation
spike (`spec-2-tiktok-extraction.md` §2.5a): a real, measured constraint,
not abandoned. Options identified but not yet pursued: (a) a larger Railway
memory tier/plan for the worker service, (b) deeper ONNX Runtime session
tuning (memory arena limits, smaller `chunk_length_s`, explicit
inter-chunk cleanup) to try to bound peak memory without more RAM, (c)
revisit whether local Whisper ASR is viable in this deployment's resource
envelope at all.

**Practical effect until resolved:** any real job submitted to production
will OOM-crash the worker during ASR. The job fails cleanly (worker
restarts via `restartPolicyType = "ON_FAILURE"`, doesn't corrupt state),
but no job can currently reach `awaiting_review` in production. Local dev
is unaffected (ample RAM). Don't re-attempt a full production
end-to-end test until this is deliberately picked back up.

---

## 0. Prerequisites

- [ ] **Dockerfile build gate.** This repo's root `Dockerfile` layers
  yt-dlp, ffmpeg, OCR deps, and now the built web app, with no
  browser/Chromium dependency (Spec 4 §7, item 1). Ideally, confirm it
  builds locally before touching Railway:
  ```bash
  docker build -t recipecart:local .
  ```
  **If Docker isn't available locally** (true of the environment this doc
  was written in), it's acceptable to skip this and let Railway's first
  deploy (step 3) be the real build test instead — Railway builds the same
  Dockerfile server-side. The tradeoff: a broken Dockerfile is discovered
  from Railway's build logs after pushing, rather than caught locally first.
  Either way, treat a failed first build as diagnostic, not alarming — read
  the build log (locally or in Railway's dashboard), fix, and let auto-deploy
  (step 6) retry once GitHub integration is live.
- A Railway account (see step A below if you don't have one yet).
- The repo pushed to a GitHub remote you can grant Railway access to.
- Your real secret values ready to paste (Anthropic key, Kroger client
  id/secret, a freshly generated `KROGER_TOKEN_KEY`) — see the env var table
  below for exactly which ones and where they come from.

**Cost expectation going in** (Spec 4 §3): Railway Hobby plan, $5/mo base
including $5 of usage — expect low single digits up to roughly $15-20/mo in
practice. A forced upgrade to Pro is a signal the worker is over-provisioned,
not a cost to just absorb — investigate sizing first. Confirm current rates
at railway.com/pricing before committing, since this is a live external
price point this doc can't guarantee.

---

## A. Create the Railway account + project (A4-3)

This is a plain external signup — nothing repo-specific here.

1. Go to railway.app and sign up (GitHub login is the easiest path since
   you'll be connecting a GitHub repo in step 6 anyway).
2. Create a new empty Project. Name it `recipecart` or similar.
3. Pick the **Hobby** plan (see cost note above).

Everything from here on happens inside this one project.

---

## B. Env var reference — which var goes on which service

Source of truth: `.env.example` at repo root. `TEST_DATABASE_URL` is
dev/CI-only and must **not** be set on either production service.

The split below follows the project's stated architecture: the `api`
process never runs yt-dlp/ffmpeg/Claude directly (`src/api/index.ts`'s top
comment: *"the web/API process never runs yt-dlp/ffmpeg/Claude directly
(Spec 4 §2.2)"*), and `docker-compose.yml` confirms the same split for local
dev — `web` only needs `DATABASE_URL`/`API_PORT`, while `worker` is the one
that gets the full `.env` (`env_file: .env`) for yt-dlp/OCR/ASR/Claude/Kroger.
The Kroger OAuth **routes**, however, live in the API process
(`src/api/routes/kroger_auth.ts`), so `api` does need the Kroger
client id/secret/token-key/redirect-URI even though it never talks to
Kroger's product-search API directly for matching — it owns the OAuth
handshake.

| Env var | `api` service | `worker` service | Notes |
|---|:---:|:---:|---|
| `DATABASE_URL` | Yes | Yes | Railway's managed Postgres connection string (step 1 below produces this). Both processes point at the same DB. |
| `PGSSL` | Yes | Yes | Set to `require` (any non-empty value) — Railway Postgres requires TLS. Unset locally, must be set in prod. See `src/platform/database.ts`. |
| `ANTHROPIC_API_KEY` | No | Yes | Only the worker calls Claude (Spec 2 §2.5 reconciliation call). The API process never touches it. |
| `KROGER_CLIENT_ID` | Yes | Yes | `api` needs it for the OAuth start/callback routes (`src/api/routes/kroger_auth.ts`). `worker` needs it for Kroger product-search/cart calls during the matching pipeline. |
| `KROGER_CLIENT_SECRET` | Yes | Yes | Same reasoning as `KROGER_CLIENT_ID`. |
| `KROGER_REDIRECT_URI` | Yes | No | Only the API process builds the Kroger auth URL and handles the callback. Must exactly match what's registered in the Kroger developer dashboard — see step 8. |
| `KROGER_TOKEN_KEY` | Yes | Yes | Symmetric key encrypting the stored Kroger token pair at rest. Both processes read/write the encrypted token file, so both need it. **Must be a distinct value from any DB credential** (Spec 4 §7 item 5) — it is a separate secret generated independently, never reused from `DATABASE_URL` or Postgres creds. |
| `DATA_DIR` | Yes (if used) | Yes | Local data dir for the encrypted Kroger token file and temp media. On Railway, this should point inside the attached volume (see step 3) for `worker` at minimum, since that's where temp media and the token file live persistently. |
| `SETUP_SECRET` | Yes | No | Shared household passphrase required by `POST /api/setup/device-token` (`src/api/routes/setup.ts`, 2026-07-21 security fix) before it will mint a new device token — only the `api` service serves that route. **Must be set before going live** — an unset value fails closed (rejects every mint attempt) rather than falling back to the old open-mint behavior, so this isn't optional-and-safe-to-skip like some other vars. Generate the same way as `KROGER_TOKEN_KEY` below, and share the value with your household out-of-band (never commit it, never post it anywhere public-facing). |
| `WEB_APP_URL` | Yes | No | Only the API's OAuth callback route redirects here after token exchange (`src/api/routes/kroger_auth.ts`, `config.webAppUrl`). **Resolved (this session): the `api` service serves the built web app itself** via `@fastify/static` (`src/api/server.ts`) — the Dockerfile's builder stage now runs `cd web && npm ci && npm run build` and the runtime stage copies `web/dist` in alongside `dist/`. So `WEB_APP_URL` is simply the `api` service's own production URL, not a separate domain — set it once `api`'s domain is known (step 7). |
| `PORT` | Yes | No | Railway injects this automatically for the `api` service and expects the process to bind it (`src/api/index.ts` reads `config.apiPort`, which falls back through `API_PORT` then `3001`). The worker doesn't listen on a port, so leave this unset for `worker`. |
| `TEST_DATABASE_URL` | **No** | **No** | Dev/CI-only. Do not set in either production service. |

---

## C. Deploy steps (dependency order)

### 1. Confirm the Dockerfile builds

Already covered in Prerequisites above — do not proceed past this point
until `docker build -t recipecart:local .` succeeds locally.

### 2. Provision managed Postgres (Spec 4 §7 item 3)

1. In the Railway project, click **New → Database → PostgreSQL**.
2. Once provisioned, open the Postgres service's **Variables** tab and copy
   the `DATABASE_URL` (Railway generates this automatically — it will look
   like `postgresql://postgres:<password>@<host>.railway.internal:5432/railway`
   or similar).
3. You'll paste this same value into both the `api` and `worker` services'
   env vars in step 5 below — one Postgres instance, one connection string,
   shared by both services (Spec 4 §7 item 3: "connection string in env for
   both services").
4. Run the schema migration once against this database before traffic hits
   it:
   ```bash
   DATABASE_URL="<the-railway-connection-string>" PGSSL=require npm run start:migrate
   ```
   (mirrors `npm run migrate` locally; `start:migrate` runs the compiled
   `dist/platform/migrate.js` — use whichever matches how you're invoking it,
   e.g. via a one-off Railway shell/run against the built image, or from
   your local machine pointed at the Railway DB with `PGSSL=require` set.)

### 3. Create the `api` and `worker` services from the same image (Spec 4 §7 item 2)

1. In the Railway project, click **New → GitHub Repo** and select this
   repo. Railway will build the root `Dockerfile` once.
2. Rename this first service `api`. Set its **Start Command** to:
   ```
   npm run start:api
   ```
   (runs the compiled `dist/api/index.js`, which also serves the built
   `web/dist` — both are produced by the Dockerfile's builder stage.)
3. Click **New → GitHub Repo** again, select the **same repo**, and rename
   this second service `worker`. Set its **Start Command** to:
   ```
   npm run start:worker
   ```
   (compiled `dist/worker/index.js`.)
4. Confirm in the Railway dashboard that both services show the same source
   repo/image but distinct start commands — this is the literal check for
   Spec 4 §7 item 2.

### 4. Attach a volume to `worker` (Spec 4 §7 item 8)

1. Open the `worker` service → **Settings → Volumes** → **New Volume**.
2. Mount it at a path such as `/data` and set `DATA_DIR=/data` in the
   worker's env vars (step 5) so temp media and the encrypted Kroger token
   file persist across restarts/redeploys instead of living in the
   ephemeral container filesystem.
3. The TTL sweep that keeps this volume bounded is already built into the
   worker (`src/worker/sweeps.ts`, wired into the main loop in
   `src/worker/index.ts`) — nothing further to configure here. It runs on
   two independent timers already present in code:
   - `sweepTempMedia()` — removes per-job temp-media subdirectories older
     than `config.tempMedia.ttlHours` (currently 6h), on an interval of
     `config.tempMedia.sweepIntervalMs`. Logs `"worker: temp-media sweep"`
     at info level (with `removed`/`scannedCount` fields) whenever it
     actually removes something.
   - `expireStaleReviews()` — transitions `jobs` rows stuck in
     `awaiting_review` past `config.jobs.reviewExpiryDays` (currently 14) to
     `expired`. Logs `"worker: expired stale reviews"` at info level.
   This step is just attaching the volume; verification that the sweeps are
   actually firing in production is in the post-deploy checklist below.

### 5. Set env vars on both services (Spec 4 §7 items 4 and 5)

Using the table in section B above, go to each service's **Variables** tab
and add exactly the vars marked for that service. Concretely:

**`api` service:**
```
DATABASE_URL=<from step 2>
PGSSL=require
KROGER_CLIENT_ID=<from developer.kroger.com>
KROGER_CLIENT_SECRET=<from developer.kroger.com>
KROGER_REDIRECT_URI=https://<api-production-domain>/api/kroger/auth/callback
KROGER_TOKEN_KEY=<generate independently, see below>
WEB_APP_URL=https://<web-production-domain>
DATA_DIR=/data
```
(`PORT` is injected automatically by Railway — do not set it manually.)

**`worker` service:**
```
DATABASE_URL=<same value as api, from step 2>
PGSSL=require
ANTHROPIC_API_KEY=<from console.anthropic.com>
KROGER_CLIENT_ID=<same value as api>
KROGER_CLIENT_SECRET=<same value as api>
KROGER_TOKEN_KEY=<same value as api — both processes decrypt the same token file>
DATA_DIR=/data
```

Generate `KROGER_TOKEN_KEY` the same way `.env.example` documents for local
dev, once, and reuse the same value across both services (they share the
encrypted token file on the volume):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Confirm this value is **not** copy-pasted from, or related to, any Postgres
credential — Spec 4 §7 item 5 calls this out explicitly as a distinct
secret. It should also never appear in git; `.env` is already gitignored
and this doc contains no real values, only placeholders.

Double check nothing above got typed into the repo (Spec 4 §7 item 4:
"nothing in git") — `git grep -i "sk-ant\|client_secret" -- . ':!docs/deploy-railway.md'`
locally as a sanity check if unsure.

### 6. Connect GitHub for auto-deploy (Spec 4 §7 item 6)

1. Each service (`api` and `worker`) should already be linked to the GitHub
   repo from step 3. Confirm under each service's **Settings → Source** that
   the branch is set to `main` and **Auto Deploy** is enabled.
2. Push a trivial commit to `main` and confirm both services rebuild and
   redeploy automatically without manual intervention.

### 7. Set up a domain (A4-4)

Only one domain to set up: `api` serves both the REST API and the built web
app (same origin, `@fastify/static` — no separate web/static service).

1. Under `api`'s **Settings → Networking**, generate a Railway-provided
   subdomain (fine for a private beta per Spec 4 §3/A4-4) or attach a custom
   domain if you have one.
2. Set `WEB_APP_URL` (step 5) to this same domain — e.g.
   `https://recipecart-api.up.railway.app`.
3. Once the domain is final, go back and confirm `KROGER_REDIRECT_URI`
   (step 5) matches it exactly — this is finalized in step 8 next since it
   also requires the Kroger dashboard side to be updated in lockstep.

### 8. Update the Kroger OAuth redirect URI in both places (Spec 4 §7 item 13, Spec 4 §3)

The API's Kroger OAuth routes live at `src/api/routes/kroger_auth.ts`:
`GET /api/kroger/auth/start` and `GET /api/kroger/auth/callback` (registered
under the `/api` prefix in `src/api/server.ts`). Two places must hold the
**exact same** callback URL, or the OAuth exchange fails at the redirect
step (this exact class of mismatch has bitten this project once already at
the local-dev layer — see the comment in `.env.example` about the retired
P1 CLI callback server on `:3000/callback`):

1. **Railway `api` service env var** (set in step 5):
   ```
   KROGER_REDIRECT_URI=https://<api-production-domain>/api/kroger/auth/callback
   ```
2. **Kroger developer dashboard** (developer.kroger.com): open the
   registered app for this `client_id` and set its redirect URI field to
   the **identical** URL, character-for-character, including scheme
   (`https://`), no trailing slash difference, and the exact path
   `/api/kroger/auth/callback`.

Update both in the same sitting — don't leave one stale while changing the
other.

### 9. Set up an external uptime monitor on `/health` (A4-5, Spec 4 §7 item 9)

The health route already exists at `src/api/routes/health.ts` — `GET
/health`, exempt from device-token auth, checks DB reachability and returns
`{ ok: true }` (200) or `{ ok: false, error: "db unreachable" }` (503).

1. Pick any free-tier uptime pinger — Spec 4 doesn't mandate a specific
   vendor ("any free-tier pinger," A4-5). Reasonable options: UptimeRobot,
   Better Uptime, Freshping. Pick whichever you're comfortable with; none of
   this runbook depends on the choice.
2. Point it at `https://<api-production-domain>/health` on a short interval
   (1-5 min is typical for free tiers).
3. Configure it to alert (email/SMS/whatever the vendor offers on free
   tier) on non-200 responses.

---

## D. Post-deploy verification (mirrors Spec 4 §7 1:1)

Go through this list after the above steps are complete. Each line states
concretely how to confirm it passed.

**Real deployment status (updated after actually running this runbook):**
Postgres provisioned + migrated + verified (12 tables incl. seeded default
user). `api` service (Railway-named `RecipeCart`) online at
`https://recipecart-production.up.railway.app` — `/health` returns real
`{"ok":true}` against the live managed Postgres, static SPA serving and
`/api/*` auth-gating both confirmed in production. `worker` service online,
volume attached at `/data`, correct start command via
`railway.worker.toml` (Config-as-code path had to be set explicitly per
service — Railway's root `railway.toml` auto-applies to every service on
the same repo otherwise, which is why `worker` initially inherited `api`'s
start command). Both services share one `KROGER_TOKEN_KEY`, freshly
generated for production (distinct from local dev's). Kroger OAuth redirect
URI updated in both places (Railway env var + Kroger dashboard).

- [x] **Dockerfile builds with yt-dlp, ffmpeg, OCR deps, cached layers (no
  browser/Chromium dependency).** Confirmed — Railway's own build succeeded
  (no local Docker was available, so this doubled as the real build test).
- [x] **`api` (serving both the REST API and the built web app) + `worker`
  as two Railway services from one image, distinct start commands.** Both
  online, same GitHub source, `api` → `npm run start:api` (via root
  `railway.toml`), `worker` → `npm run start:worker` (via
  `railway.worker.toml`, service-level Config-as-code path).
- [x] **Managed Postgres provisioned; connection string in env for both
  services.** Confirmed — same `DATABASE_URL` on both, `/health` proves it's
  actually reachable, not just set.
- [x] **All API keys and Kroger `client_id`/`client_secret` as Railway env
  vars; nothing in git.** Set via `railway variable set --stdin` from local
  `.env`, never committed.
- [x] **Kroger token encryption key set as env var, distinct from DB
  credentials.** Freshly generated for production via
  `crypto.randomBytes(32)`, shared identically across `api`/`worker`.
- [x] **`/health` responding and wired into deploy checks.**
  ```bash
  curl -i https://recipecart-production.up.railway.app/health
  ```
  Confirmed `HTTP/2 200` and `{"ok":true}` against the real production DB.
- [x] **GitHub auto-deploy on main.** Confirmed via a real push: this exact
  checklist update was pushed to `main` and both services picked it up and
  redeployed automatically without any manual trigger.
- [x] **Worker volume attached; TTL sweep scheduled.** Volume attached and
  confirmed (`RAILWAY_VOLUME_MOUNT_PATH=/data`). A real incident forced a
  real test of the mechanism: a burst of OOM crashes during testing filled
  the 500MB volume to 100% (orphaned per-job temp dirs from `SIGKILL`
  bypassing the normal cleanup), which the sweep's original 6h TTL was too
  conservative to catch in time — lowered to 1h (commit `c456760`) after
  manually cleaning up the same incident. `sweepTempMedia`/
  `expireStaleReviews` are unit-tested (`src/worker/sweeps.test.ts`) against
  the real 1h value, but **not yet directly observed firing on its own in
  production logs** — every cleanup this session was a manual intervention
  via SSH, not a live-caught automatic sweep. Worth watching the worker logs
  for `"worker: temp-media sweep"` the next time debris accumulates and is
  left alone long enough to sweep itself.
- [x] **Log redaction verified with a real token/key probe.** Re-confirmed
  against live production logs on 2026-07-20 (previously only verified at
  the unit-test level, `src/api/server.test.ts`). Minted a real device token
  via `POST /api/setup/device-token`, then drove it through several
  authenticated requests (`GET /api/recipes`, `GET /api/preferences`) plus a
  deliberate auth failure (garbage bearer token and a no-token request, both
  401) to exercise the unhappy path. Pulled `railway logs --service
  RecipeCart` and `railway logs --service worker` and grepped both for the
  raw token substring: zero matches in either service. (The request logger
  only serializes `method`/`url`/`hostname`/`remoteAddress`/`remotePort` for
  incoming requests and `statusCode` for responses — it never puts headers
  or the token into the log line in the first place, so there's no redaction
  gap to exploit on this path.) Also checked `src/api/lib/auth.ts`
  end-to-end: it extracts, hashes, and compares the token but never logs it,
  including on the `unauthorized()` failure path.
- [x] **External uptime monitor on `/health`.** UptimeRobot monitor created
  and confirmed live via its API: status `2` (up), type HTTP(s), 300s
  interval, pointed at the production `/health` URL.
- [x] **Postgres manual restore tested once and documented.** Verified
  2026-07-20 via a local restore (not Railway's dashboard backup UI — no
  CLI support, and a second billed Postgres service wasn't worth the
  ongoing cost just to prove restorability): `pg_dump` of production
  restored into a local scratch database, `recipes`/`jobs` row counts and
  a known recipe confirmed matching, scratch DB dropped after — see the
  full record in section E below.
- [x] **Device-token issuance tested from a fresh Shortcut install.**
  Genuinely done: a real Shortcut was built on a real iPhone per
  `docs/ios-shortcut.md`, a device token was minted via `/setup` (which
  also surfaced and fixed two real bugs along the way — an `apiPost`
  Content-Type bug and a redundant dual-auth-flow UX issue), and real
  TikTok URLs were submitted end-to-end through the share sheet.
- [x] **Kroger OAuth2 authorization flow tested end-to-end against the
  production redirect URI; only the token pair is persisted.** Genuinely
  done: the real consent flow was completed against production
  (`kroger_auth` has a real row with real encrypted access/refresh
  tokens), and — beyond just connecting — that connection was actually
  used for a real, successful `cart:approve` run (real `cart_runs` row,
  `status: "completed"`), which also caught and fixed a real bug (the
  parent job's status was never updated after a successful cart run,
  commit `b3f8f89`).

---

## E. Postgres manual restore drill (fill in after running once)

This section is itself the "documented" artifact the checklist item wants
— run the drill once, then fill in the blanks below with the real date and
outcome.

**Drill steps:**

1. In the Railway dashboard, open the Postgres service → **Backups** (or
   **Data → Backups**, naming may vary) and trigger a manual snapshot (or
   confirm an automatic daily backup exists and note its timestamp).
2. Provision a second, throwaway Postgres service in the same Railway
   project (or a separate scratch project) named something like
   `recipecart-restore-drill`.
3. Restore the snapshot from step 1 into this scratch database, following
   whatever restore flow Railway's UI offers for the backup (a "restore to
   new database" action, or a manual `pg_restore`/`pg_dump` pull-and-push if
   Railway only offers raw dump download).
4. **Prove the restore actually worked** — don't just confirm the restore
   command exited 0. Run against the scratch DB:
   ```sql
   SELECT count(*) FROM recipes;
   SELECT count(*) FROM jobs;
   ```
   and compare against the same query run against production at
   (approximately) the same point in time. They should match (modulo any
   writes that landed between the snapshot and the comparison query). If a
   specific known test recipe was created earlier in testing, confirm it's
   present by name/id in the restored `recipes` table as an additional
   sanity check.
5. Tear down the scratch database once the check passes, to avoid leaving
   an extra billed Postgres instance running.

**Drill record (fill in after running):**

| Field | Value |
|---|---|
| Date run | 2026-07-20 |
| Backup/snapshot source | Not Railway's dashboard "Backups" UI — Railway CLI has no `backup`/`restore` subcommand, and provisioning a second billed Postgres service just to prove restorability wasn't worth the ongoing cost. Instead: fresh `pg_dump` of production taken directly at drill time via `DATABASE_PUBLIC_URL` (public proxy, `tokaido.proxy.rlwy.net:15434/railway`), custom format (`-F c`), using `postgresql@18` client tools (`brew install postgresql@18`) since prod runs Postgres 18.4 and the local default client (Homebrew postgresql@16) refused with a server-version mismatch. |
| Restored to | Local scratch DB `recipecart_restore_drill` on the machine's existing local Postgres 16 server (not a new Railway service — deliberately avoids creating new billed cloud infrastructure while still proving a real dump artifact restores cleanly) |
| `recipes` row count (prod vs restored) | 1 vs 1 — match |
| `jobs` row count (prod vs restored) | 1 vs 1 — match |
| Known test recipe present? | Yes — `16b2bb9d-fe5f-418f-8819-3fa52f7a8764` / "Sheet Pan Cheesy Chicken Fajita Burritos", confirmed present in restored DB by exact id and title match against production |
| Outcome | Pass. Only issues were expected/benign: (1) local pg16 client tools couldn't dump an 18.4 server, resolved by installing `postgresql@18` via Homebrew and using its `pg_dump`/`pg_restore` binaries directly; (2) `pg_restore` emitted non-fatal errors for `SET transaction_timeout` (pg18-only param, unrecognized by local pg16 server) and `ALTER TABLE ... OWNER TO postgres` (local role `postgres` doesn't exist, local user is `aphan`) — both are ownership/permission noise, not data-loading failures, and all rows loaded correctly. Scratch DB dropped and dump file deleted after verification. |
| Run by | Automated agent (Claude Code), as part of this session's operational drill work |
