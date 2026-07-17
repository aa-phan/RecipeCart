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
    get hebSessionKey() {
      return requireEnv("HEB_SESSION_KEY");
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

  heb: {
    // Pacing (A3-4): jittered delay between actions so automation paces
    // itself like one careful user, never a hard item cap at this scale.
    minActionDelayMs: 1500,
    maxActionDelayMs: 3000,
    searchStalenessWindowMs: 24 * 60 * 60_000,
  },

  get hebSessionStatePath() {
    return path.join(this.dataDir, "heb-session.enc.json");
  },
  get sqliteDbPath() {
    return path.join(this.dataDir, "recipecart.db");
  },
  get tempMediaDir() {
    return path.join(this.dataDir, "tmp");
  },
};
