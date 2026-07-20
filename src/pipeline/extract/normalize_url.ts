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

/** Resolves a short-link's redirect chain (vm.tiktok.com/xxx,
 * tiktok.com/t/xxx) to extract the real video id, WITHOUT invoking yt-dlp —
 * a lightweight HEAD request following redirects, not a download. Exists
 * because job-creation dedup (platform/jobs.ts's deriveIdempotencyKey) needs
 * a stable key at submission time, and short-link tokens are minted fresh on
 * every share (confirmed live: TikTok's native Share button produces a new
 * `/t/<token>/` each time, even for the identical underlying video) — the
 * raw URL string is therefore useless as a dedup key for the most common
 * real-world share path. Real production gap, found via live iOS Shortcut
 * testing 2026-07-20, not a theoretical concern.
 *
 * Returns null on ANY failure (network error, timeout, non-TikTok redirect
 * target) rather than throwing — callers fall back to raw-URL-based
 * deduping, which is strictly no worse than the pre-existing behavior. This
 * function must never turn a resolvable network hiccup into a failed job
 * submission. */
export async function resolveShortLinkVideoId(
  rawUrl: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const response = await fetch(rawUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return normalizeUrl(response.url).videoId;
  } catch {
    return null;
  }
}
