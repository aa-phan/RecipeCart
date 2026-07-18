import { describe, it, expect } from "vitest";
import {
  classifyDownloadFailure,
  userFacingReasonFor,
  ExtractionError,
  type FailureClass,
} from "./failures.js";

describe("classifyDownloadFailure", () => {
  it.each([
    ["ERROR: [TikTok] Video is private", "download_failed_permanent"],
    ["ERROR: This post is not available", "download_failed_permanent"],
    ["The video has been deleted by its owner", "download_failed_permanent"],
    ["Content isn't available right now", "download_failed_permanent"],
    ["This video is not available in your country", "download_failed_permanent"],
    ["ERROR: age-restricted content", "download_failed_permanent"],
  ] as [string, FailureClass][])("classifies %j as permanent", (stderr, expected) => {
    expect(classifyDownloadFailure(stderr)).toBe(expected);
  });

  it.each([
    ["ERROR: Unable to download webpage: <urlopen error timed out>"],
    ["HTTP Error 503: Service Unavailable"],
    ["Connection reset by peer"],
    ["yt-dlp exited with code 1"],
    [""],
  ])("classifies %j as transient (retryable)", (stderr) => {
    expect(classifyDownloadFailure(stderr)).toBe("download_failed_transient");
  });
});

describe("userFacingReasonFor", () => {
  it("returns a distinct, non-empty message per class", () => {
    const classes: FailureClass[] = [
      "download_failed_permanent",
      "download_failed_transient",
      "model_call_failed",
      "schema_validation_failed",
    ];
    const messages = classes.map((c) => userFacingReasonFor(c));
    expect(new Set(messages).size).toBe(classes.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
  });

  it("folds an optional detail into the schema-validation message", () => {
    expect(userFacingReasonFor("schema_validation_failed", "missing quantities")).toContain(
      "missing quantities",
    );
  });
});

describe("ExtractionError", () => {
  it("carries the class, reason, and cause", () => {
    const cause = new Error("boom");
    const err = new ExtractionError("model_call_failed", "temporarily unavailable", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.failureClass).toBe("model_call_failed");
    expect(err.userFacingReason).toBe("temporarily unavailable");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("model_call_failed");
  });
});
