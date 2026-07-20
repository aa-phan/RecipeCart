// Central config. Per Spec 2/3, tunables like scene-change threshold, frame
// interval, pacing, and chrome-mask regions are config values, not constants
// buried in code, so they can be adjusted without touching pipeline logic.
import "dotenv/config";
import path from "node:path";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  dataDir: process.env.DATA_DIR ?? "./data",

  // Postgres connection (Spec 4 §2.2). Local dev runs Postgres via
  // docker-compose (or a native install); the CLI, web, and worker all point
  // at the same DB. The default matches the docker-compose service; a local
  // native install overrides it via DATABASE_URL in .env.
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/recipecart",
  // Managed Postgres (Railway and most cloud providers) requires TLS on the
  // connection but presents a cert not chained to a public CA, so plain
  // `ssl: true` fails locally-verified connections. `PGSSL=require` (or any
  // non-empty value) opts in; unset/local dev stays plaintext. Explicit env
  // flag rather than sniffing the hostname — sniffing "not localhost" would
  // silently break any future non-Railway managed DB with a real CA cert.
  pgSsl: Boolean(process.env.PGSSL),

  secrets: {
    // Read lazily (via getters) so importing config doesn't throw before
    // .env is needed — e.g. `recipecart --help` shouldn't require keys.
    // Claude (Anthropic) is the ONLY cloud AI dependency by design — OCR
    // (tesseract.js) and ASR (local Whisper via @huggingface/transformers)
    // both run on-device, so there's no OpenAI/Google Vision key here.
    get anthropicApiKey() {
      return requireEnv("ANTHROPIC_API_KEY");
    },
    get krogerClientId() {
      return requireEnv("KROGER_CLIENT_ID");
    },
    get krogerClientSecret() {
      return requireEnv("KROGER_CLIENT_SECRET");
    },
    get krogerTokenKey() {
      return requireEnv("KROGER_TOKEN_KEY");
    },
  },

  krogerRedirectUri: process.env.KROGER_REDIRECT_URI ?? "http://localhost:3000/callback",

  // Where to send the browser after the Kroger OAuth callback finishes
  // (src/api/routes/kroger_auth.ts). A RELATIVE redirect would resolve
  // against the API server's own origin, which is wrong whenever the web
  // app is served from a different origin — true for local dev (Vite on
  // :5173, API on :3001) and worth keeping explicit even once Phase 4
  // deploys both behind one origin, rather than relying on relative-path
  // resolution to happen to be correct.
  webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:5173",

  // API listen port. Railway (and most PaaS) injects PORT and expects the
  // process to bind it; API_PORT is the pre-Phase-4 local-dev name and stays
  // as a fallback so existing .env files keep working. 3001 is the final
  // fallback for a bare `npm run api` with neither set.
  apiPort: Number(process.env.PORT ?? process.env.API_PORT ?? 3001),

  extraction: {
    // Caption-sufficiency gate (Spec 2 §2.3a, A2-7). Minimum distinct
    // ingredient-pattern lines in the caption before we skip frame
    // extraction + OCR entirely and treat the caption as the ingredients
    // source. Starting default, not data-tuned yet — see A2-7.
    captionMinIngredientLines: 3,
    // Escalation selection (Spec 2 §2.4) — hard cap, not a suggestion.
    maxEscalationFrames: 8,
    maxRawFrames: 40,
    sceneThreshold: 0.4,
    frameIntervalS: 2,
    resizeLongEdgePx: 1024,
    // dHash hamming distance below which two frames are considered duplicates.
    dedupHammingThreshold: 8,
    // TikTok UI chrome regions (Spec 2 §2.3b), as fractions of frame width/height.
    // Text blocks whose bounding boxes fall here are tagged `chrome`, not deleted.
    chromeRegions: {
      rightEdgeColumn: { xMin: 0.82, xMax: 1.0, yMin: 0.0, yMax: 1.0 },
      bottomCaptionBand: { xMin: 0.0, xMax: 1.0, yMin: 0.78, yMax: 1.0 },
    },
    claudeModel: "claude-sonnet-5",
    // Live-tested (2026-07-18), thinking disabled (reconcile.ts): a real
    // 20-ingredient caption-sufficient recipe (evidence array per field,
    // steps, dietary_attributes) hit stop_reason "max_tokens" at 4000 output
    // tokens, truncated mid-step, on a request with byte-identical input to
    // one that HAD completed successfully moments earlier — response length
    // varies run to run even with thinking off, so 4000 isn't reliably
    // sufficient even for a recipe this size, not just a rare outlier. 8000
    // gives real headroom rather than riding the edge.
    claudeMaxTokens: 8000,
    // Max SDK-level retries for the reconcile Claude call (Spec 2 §3
    // model_call_failed → ×3 backoff). The @anthropic-ai/sdk already retries
    // transient errors (429 RateLimitError, 5xx InternalServerError,
    // APIConnectionError) with exponential backoff — this just sets how many,
    // rather than hand-rolling a backoff loop. A non-transient error (400/401)
    // is not retried by the SDK regardless, and surfaces immediately.
    claudeMaxRetries: 3,
    // Local Whisper model (Hugging Face Hub id, downloaded once on first use
    // and cached). Deliberately multilingual (not a "*.en" variant) — Spec 2
    // requires ASR/OCR auto-detection with no English special-casing.
    // "base" balances download size (~145MB) against quality/speed for local
    // dev; swap to a bigger variant here (no code change) if quality proves
    // insufficient once real data exists.
    whisperModel: "Xenova/whisper-base",
    schemaVersion: "2026-07-schema-v1",
    downloadStartTimeoutMs: 45_000,
    downloadTotalTimeoutMs: 180_000,
    jobTimeoutMs: 5 * 60_000,
  },

  kroger: {
    // Kroger Public API base URLs (Spec 3 §2.1) — verified live against the
    // real API during P1 setup, not copied blind from the docs summary.
    apiBaseUrl: "https://api.kroger.com/v1",
    authorizeUrl: "https://api.kroger.com/v1/connect/oauth2/authorize",
    tokenUrl: "https://api.kroger.com/v1/connect/oauth2/token",
    // Verified live (2026-07-18): "product.compact" is a valid Client
    // Credentials scope for Products/Locations; "cart.basic:write" is a
    // valid Authorization Code scope that reaches Kroger's real login page
    // (a guessed "profile.compact" scope was rejected with invalid_scope —
    // don't add scopes here without checking the authorize endpoint first).
    appScope: "product.compact",
    userScope: "cart.basic:write",
    // Documented daily rate limits (Spec 3 §2.1) — tracked, not enforced by
    // this config alone; the client should back off well before these.
    productsDailyLimit: 10_000,
    locationsDailyLimitPerEndpoint: 1_600,
    cartDailyLimit: 5_000,
    // Staleness window (A3-6): re-run search if a recipe has sat in
    // awaiting_review longer than this before a cart run uses its prices.
    searchStalenessWindowMs: 24 * 60 * 60_000,
    // Safety margin below the documented daily ceilings (Spec 3 §17): the
    // rate-limit guard refuses to START a run once usage reaches this fraction
    // of a ceiling, leaving headroom rather than tripping the hard limit
    // mid-run. Trivial at single-user volume; a real guard if usage ever grows.
    rateLimitSafetyFraction: 0.95,
  },

  jobs: {
    // Worker poll interval for the Postgres-backed queue (Spec 4 §2.2, ~2s).
    pollIntervalMs: 2_000,
    // A re-submit of the same (user, url) within this window returns the
    // existing job rather than creating a new one — a double-tapped share
    // surfaces the in-flight job (Spec 4 §2.5 job-creation idempotency).
    duplicateWindowMs: 10 * 60_000,
    // Cap on the short-link redirect-resolution HEAD request (jobs.ts's
    // deriveIdempotencyKey, normalize_url.ts's resolveShortLinkVideoId) —
    // only fires for short-link forms (videoId not resolvable from the URL
    // shape alone), never full-form /video/<id> submits, so this doesn't
    // add latency to the common case. Kept tight against Spec 1's ~2s
    // share-to-confirmation target; a timeout falls back to raw-URL dedup
    // rather than failing the submission.
    shortLinkResolveTimeoutMs: 2_500,
    // Heartbeat staleness (Spec 4 A4-6, recommended 10 min): an in-progress
    // job whose lock hasn't been refreshed within this window is considered
    // abandoned (crashed worker) and is requeued (re-runnable stages) or moved
    // to requires_user_intervention (mid-cart-mutation).
    staleLockMs: 10 * 60_000,
    // How often the worker sweeps for stale locks.
    staleSweepIntervalMs: 30_000,
    // Awaiting-review → Expired TTL (Spec 4 A4-6, recommended 14 days).
    reviewExpiryDays: 14,
    // How often the worker sweeps awaiting_review jobs past reviewExpiryDays.
    // Piggybacks on the same cadence as the stale-lock sweep — no need for a
    // tighter interval on a days-scale TTL.
    reviewExpirySweepIntervalMs: 30_000,
  },

  // Disk-level temp-media cleanup (Spec 4 §2.7 worker volume TTL sweep). The
  // per-job pipeline already deletes its own temp dir in a try/finally
  // (pipeline/extract/index.ts) — this is a periodic safety-net sweep for
  // anything a hard crash (kill -9, OOM) left behind before that finally
  // could run, so the worker volume doesn't grow unbounded over many restarts.
  // ttlHours lowered from 6 to 1 (2026-07-20, real incident): a burst of
  // real OOM crashes during production testing filled the 500MB Railway
  // volume to 100% within roughly an hour, well inside the old 6h window,
  // blocking every subsequent job with "No space left on device" (ffmpeg)
  // until manually cleaned up. A dir's mtime keeps updating while a job is
  // genuinely still writing to it, so a short TTL only catches truly
  // abandoned (crashed) directories, not slow-but-live jobs — safe to keep
  // tight given the volume is this small.
  tempMedia: {
    ttlHours: 1,
    sweepIntervalMs: 30 * 60_000,
  },

  matching: {
    // Claude-delegated materiality judgment (Spec 3 §2.2). Same model as
    // reconcile for now; Haiku 4.5 is the natural cost lever here (see the
    // recipecart-sonnet5-pricing-cliff note) since this is a short
    // safe-vs-material classification, not a full extraction. The call is
    // GATED (fires only when a substitution is actually flagged) and BATCHED
    // (one call per recipe covering all flagged cases), so most clean-match
    // recipes pay nothing extra.
    materialityModel: "claude-sonnet-5",
    materialityMaxTokens: 1024,
    claudeMaxRetries: 3,
  },

  get krogerTokenStatePath() {
    return path.join(this.dataDir, "kroger-token.enc.json");
  },
  get tempMediaDir() {
    return path.join(this.dataDir, "tmp");
  },
};
