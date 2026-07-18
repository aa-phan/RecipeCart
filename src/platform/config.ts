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
    get anthropicApiKey() {
      return requireEnv("ANTHROPIC_API_KEY");
    },
    get openaiApiKey() {
      return requireEnv("OPENAI_API_KEY");
    },
    get googleApplicationCredentials() {
      return requireEnv("GOOGLE_APPLICATION_CREDENTIALS");
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
    claudeMaxTokens: 4000,
    schemaVersion: "2026-07-schema-v1",
    downloadStartTimeoutMs: 45_000,
    downloadTotalTimeoutMs: 180_000,
    jobTimeoutMs: 5 * 60_000,
  },

  kroger: {
    // Kroger Public API base URLs (Spec 3 §2.1).
    apiBaseUrl: "https://api.kroger.com/v1",
    authorizeUrl: "https://api.kroger.com/v1/connect/oauth2/authorize",
    tokenUrl: "https://api.kroger.com/v1/connect/oauth2/token",
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
