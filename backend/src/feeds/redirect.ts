import { DEFAULT_FEED_USER_AGENT } from "./userAgent";

const MAX_REDIRECTS = 8;

export interface ResolvedUrl {
  originalUrl: string;
  resolvedUrl: string;
  hops: string[]; // full redirect chain including original, excluding final (which is resolvedUrl)
  status: number | null;
  ok: boolean;
  error?: string;
}

/**
 * Resolves the tracking-prefix redirect chains enclosure URLs commonly go
 * through (podtrac.com -> chartable.com -> real CDN — corner case 1).
 *
 * Uses GET with `Range: bytes=0-0` instead of HEAD: some prefix hosts
 * reject HEAD or range requests outright, but a single-byte ranged GET is
 * the closest thing to a free probe that plays nice almost everywhere.
 * Follows redirects manually (fetch's `redirect: "manual"`) so we can
 * enforce the hop cap and record the full chain rather than only the
 * final URL.
 *
 * Important: the app downloads the *original* URL, not this resolved one
 * (publishers count downloads there) — this resolver exists for dedup /
 * DAI-host detection / broken-link fallback, not for the actual fetch path.
 *
 * `userAgent` is a parameter (default `DEFAULT_FEED_USER_AGENT`), the same
 * shape as `fetchFeedConditional`: this module must not import `config/env`,
 * which pulls in `dotenv` and crashed `api/` at module load in production
 * (S-02, B1-10). `api/_test/import-closure.test.mjs` guards that boundary.
 */
export async function resolveRedirectChain(
  originalUrl: string,
  opts: { maxRedirects?: number; fetchImpl?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}
): Promise<ResolvedUrl> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const userAgent = opts.userAgent ?? DEFAULT_FEED_USER_AGENT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const hops: string[] = [];
  let currentUrl = originalUrl;
  let lastStatus: number | null = null;

  for (let i = 0; i <= maxRedirects; i++) {
    hops.push(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": userAgent,
          Range: "bytes=0-0"
        },
        signal: controller.signal
      });
      lastStatus = res.status;

      const isRedirect = res.status >= 300 && res.status < 400;
      if (isRedirect) {
        const location = res.headers.get("location");
        if (!location) {
          return {
            originalUrl,
            resolvedUrl: currentUrl,
            hops,
            status: res.status,
            ok: false,
            error: `redirect status ${res.status} with no Location header`
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Not a redirect: this is the resolved endpoint, whatever its status.
      return {
        originalUrl,
        resolvedUrl: currentUrl,
        hops: hops.slice(0, -1),
        status: res.status,
        ok: res.status >= 200 && res.status < 300, // includes 206 partial content from the Range probe
        error: res.status >= 400 ? `final status ${res.status}` : undefined
      };
    } catch (err) {
      return {
        originalUrl,
        resolvedUrl: currentUrl,
        hops: hops.slice(0, -1),
        status: lastStatus,
        ok: false,
        error: `fetch error: ${(err as Error).message}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    originalUrl,
    resolvedUrl: currentUrl,
    hops,
    status: lastStatus,
    ok: false,
    error: `exceeded max redirects (${maxRedirects})`
  };
}
