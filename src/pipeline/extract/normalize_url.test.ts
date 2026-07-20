import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidTikTokUrlError, normalizeUrl, resolveShortLinkVideoId } from "./normalize_url.js";

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

describe("resolveShortLinkVideoId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts the video id from where the redirect chain lands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      url: "https://www.tiktok.com/@jalalsamfit/video/7564134038592605462",
    });
    vi.stubGlobal("fetch", fetchMock);

    const videoId = await resolveShortLinkVideoId("https://www.tiktok.com/t/ZTSKEBAMy/", 2500);

    expect(videoId).toBe("7564134038592605462");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.tiktok.com/t/ZTSKEBAMy/",
      expect.objectContaining({ method: "HEAD", redirect: "follow" }),
    );
  });

  it("resolves two DIFFERENT short-link tokens to the SAME video id", async () => {
    // The exact real-world scenario this exists for: TikTok mints a fresh
    // /t/<token>/ every time the Share button is tapped, even for the
    // identical video — confirmed live 2026-07-20.
    const fetchMock = vi.fn().mockResolvedValue({
      url: "https://www.tiktok.com/@jalalsamfit/video/7564134038592605462",
    });
    vi.stubGlobal("fetch", fetchMock);

    const a = await resolveShortLinkVideoId("https://www.tiktok.com/t/AAAA111/", 2500);
    const b = await resolveShortLinkVideoId("https://www.tiktok.com/t/BBBB222/", 2500);

    expect(a).toBe("7564134038592605462");
    expect(b).toBe("7564134038592605462");
    expect(a).toBe(b);
  });

  it("returns null on a network failure rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const videoId = await resolveShortLinkVideoId("https://www.tiktok.com/t/ZTSKEBAMy/", 2500);
    expect(videoId).toBeNull();
  });

  it("returns null when the redirect lands somewhere non-TikTok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ url: "https://example.com/dead-link" }));

    const videoId = await resolveShortLinkVideoId("https://www.tiktok.com/t/ZTSKEBAMy/", 2500);
    expect(videoId).toBeNull();
  });
});
