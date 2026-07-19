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

- [ ] **Dockerfile builds with yt-dlp, ffmpeg, OCR deps, cached layers (no
  browser/Chromium dependency).** Already gated in step 1/Prerequisites —
  re-confirm the Railway build logs for both services show a successful
  image build with no Chromium/Puppeteer/Playwright install step.
- [ ] **`api` (serving both the REST API and the built web app) + `worker`
  as two Railway services from one image, distinct start commands.** In the
  Railway dashboard, both services show the same GitHub source; `api`'s
  start command is `npm run start:api`, `worker`'s is `npm run start:worker`.
- [ ] **Managed Postgres provisioned; connection string in env for both
  services.** Check both `api` and `worker` **Variables** tabs — both have
  the identical `DATABASE_URL` pointing at the Railway Postgres service.
- [ ] **All API keys and Kroger `client_id`/`client_secret` as Railway env
  vars; nothing in git.** Confirm via the Variables tabs (section B table)
  and `git log -p -- .env` / `git grep` locally to confirm no secret value
  was ever committed.
- [ ] **Kroger token encryption key set as env var, distinct from DB
  credentials.** `KROGER_TOKEN_KEY` is present on both services, generated
  independently via the `crypto.randomBytes` command in step 5 — not copied
  from `DATABASE_URL` or any Postgres password.
- [ ] **`/health` responding and wired into deploy checks.**
  ```bash
  curl -i https://<api-production-domain>/health
  ```
  Confirm `HTTP/1.1 200` and body `{"ok":true}`. Also confirm in Railway's
  service settings that a health check path is configured (Railway can gate
  rollout on this so a bad deploy doesn't take over traffic — set the health
  check path to `/health` under `api`'s **Settings → Deploy**).
- [ ] **GitHub auto-deploy on main.** Confirmed already in step 6 via the
  trivial-commit test — re-verify the latest commit SHA on `main` matches
  what's currently deployed on both services (Railway shows the deployed
  commit in each service's Deployments tab).
- [ ] **Worker volume attached; TTL sweep scheduled.** Confirm the volume
  shows attached under `worker`'s **Settings → Volumes**. After the worker
  has been running for at least one full `sweepIntervalMs`/`reviewExpiryDays`
  cycle (or after manually seeding an old temp-media dir / stale
  `awaiting_review` job to force it), check the worker's logs for the
  `"worker: temp-media sweep"` and/or `"worker: expired stale reviews"`
  info-level log lines from `src/worker/index.ts`.
- [ ] **Log redaction verified with a real token/key probe.** Trigger a code
  path that logs a field whose key matches the redaction patterns in
  `src/platform/logger.ts` (`/token/i`, `/api[_-]?key/i`, etc — e.g. force a
  failed Kroger token refresh, which logs an error object containing a
  `token` field) and confirm in the live Railway log viewer that the value
  shows as `[REDACTED]` rather than the real secret. Do this against the
  **live deployed log viewer**, not just the local unit tests
  (`src/platform/logger.test.ts` already covers the unit-level behavior —
  this step is specifically about confirming it holds in the actual Railway
  log pipeline, which could theoretically reformat/passthrough fields
  differently).
- [ ] **External uptime monitor on `/health`.** Confirm the monitor
  configured in step 9 has at least one successful check recorded and that
  a manual test alert (most vendors offer a "send test alert" button) reaches
  you.
- [ ] **Postgres manual restore tested once and documented.** See section E
  below — fill in the template after running the drill once.
- [ ] **Device-token issuance tested from a fresh Shortcut install.** Follow
  `docs/ios-shortcut.md` for the Shortcut-side steps; this runbook's role is
  only confirming the server side is reachable and issuing tokens correctly
  from a real device flow, not the Shortcut mechanics.
- [ ] **Kroger OAuth2 authorization flow tested end-to-end against the
  production redirect URI; only the token pair is persisted.** With
  `KROGER_REDIRECT_URI` and the Kroger dashboard both updated (step 8),
  visit `https://<api-production-domain>/api/kroger/auth/start` in a
  browser, complete the Kroger consent screen, and confirm you land back on
  `https://<web-app-domain>/?krogerConnected=true` (the exact redirect
  target from `src/api/routes/kroger_auth.ts`'s callback handler). Then
  inspect what's actually persisted (the encrypted token file on the
  worker's volume, or query however the app exposes connection status) and
  confirm only the access/refresh token pair is stored — no incidental
  Kroger profile data, raw authorization code, or `state` value left behind.

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
| Date run | _fill in_ |
| Backup/snapshot source | _fill in — automatic daily backup timestamp, or manual snapshot ID_ |
| Restored to | _fill in — scratch DB/project name_ |
| `recipes` row count (prod vs restored) | _fill in_ |
| `jobs` row count (prod vs restored) | _fill in_ |
| Known test recipe present? | _fill in — yes/no, which recipe_ |
| Outcome | _fill in — pass/fail, and any issues hit along the way_ |
| Run by | _fill in_ |
