import { describe, expect, it } from "vitest";
import { InvalidTikTokUrlError, normalizeUrl } from "./normalize_url.js";

describe("normalizeUrl", () => {
  it("extracts a video id from a full-form /video/<id> URL", () => {
    const result = normalizeUrl("https://www.tiktok.com/@jalalsamfit/video/7564134038592605462");
    expect(result.videoId).toBe("7564134038592605462");
    expect(result.url).toBe("https://www.tiktok.com/@jalalsamfit/video/7564134038592605462");
  });

  it("extracts a video id from a /photo/<id> URL", () => {
    const result = normalizeUrl(
      "https://www.tiktok.com/@success.fitness/photo/7547822272153799954",
    );
    expect(result.videoId).toBe("7547822272153799954");
  });

  it("accepts a short-link form with no id available yet", () => {
    const result = normalizeUrl("https://www.tiktok.com/t/ZTSKEBAMy/");
    expect(result.videoId).toBeNull();
  });

  it("accepts a vm.tiktok.com short link", () => {
    const result = normalizeUrl("https://vm.tiktok.com/ZTSKEBAMy/");
    expect(result.videoId).toBeNull();
  });

  it("throws on a non-tiktok host", () => {
    expect(() => normalizeUrl("https://www.youtube.com/watch?v=abc")).toThrow(
      InvalidTikTokUrlError,
    );
  });

  it("throws on an unparseable URL", () => {
    expect(() => normalizeUrl("not a url")).toThrow(InvalidTikTokUrlError);
  });
});
