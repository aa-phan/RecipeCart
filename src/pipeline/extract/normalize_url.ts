// URL normalization/validation (Spec 2 §2.1 normalize_url). yt-dlp resolves
// vm.tiktok.com / tiktok.com/t/... short links itself at download time, so
// this stage doesn't need to follow redirects — it just needs to fail fast
// on obviously-not-TikTok input before we spend a download attempt on it,
// and pull a video id out of URL shapes that carry one directly.
const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

// Matches /video/<id> or /photo/<id> anywhere in the path.
const ID_PATTERN = /\/(?:video|photo)\/(\d+)/;

export class InvalidTikTokUrlError extends Error {
  constructor(rawUrl: string, reason: string) {
    super(`Not a valid TikTok URL (${reason}): ${rawUrl}`);
    this.name = "InvalidTikTokUrlError";
  }
}

export interface NormalizedUrl {
  /** The original URL, unmodified — yt-dlp does its own redirect resolution. */
  url: string;
  /** Numeric video id when the URL shape carries one directly (full-form
   * /video/<id> or /photo/<id> links). null for short-link forms
   * (vm.tiktok.com/xxx, tiktok.com/t/xxx) whose id only appears after
   * yt-dlp resolves the redirect at download time. */
  videoId: string | null;
}

/** Validate the URL is a tiktok.com-family host and extract a video id
 * up front where possible. Throws InvalidTikTokUrlError on garbage input
 * (wrong host, unparseable URL) so we fail fast before attempting a
 * download. Does NOT reject short-link forms — those are valid, just
 * without an id available yet. */
export function normalizeUrl(rawUrl: string): NormalizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidTikTokUrlError(rawUrl, "unparseable URL");
  }

  const host = parsed.hostname.toLowerCase();
  if (!TIKTOK_HOSTS.has(host)) {
    throw new InvalidTikTokUrlError(rawUrl, `unrecognized host "${host}"`);
  }

  const match = parsed.pathname.match(ID_PATTERN);
  return { url: rawUrl, videoId: match ? match[1]! : null };
}
