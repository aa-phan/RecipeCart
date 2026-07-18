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
  },

  get krogerTokenStatePath() {
    return path.join(this.dataDir, "kroger-token.enc.json");
  },
  get sqliteDbPath() {
    return path.join(this.dataDir, "recipecart.db");
  },
  get tempMediaDir() {
    return path.join(this.dataDir, "tmp");
  },
};
