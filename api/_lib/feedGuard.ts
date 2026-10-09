import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * WHERE A FEED FETCH MAY GO (security review 2026-10, SEC-01).
 *
 * The two live endpoints fetch a show's RSS feed server-side, and the feed URL
 * is not ours: a `pi:<n>` show's url is a PodcastIndex row (anyone can submit a
 * feed there; api/shows/[show_id]/episodes.ts resolvePiShow), and every feed,
 * catalogue ones included, is whatever its publisher's server says it is,
 * redirects and all. Before this the only check was "starts with http(s)", and
 * `fetch` followed up to 20 redirects anywhere. So a submitted feed whose url,
 * or whose redirect, named a loopback, link-local or private address had this
 * function make that request from inside the deployment (on Vercel's Lambda
 * hosts, 127.0.0.1 is the runtime API) - blind, but a request we never meant
 * to make on a stranger's behalf.
 *
 * So every hop is checked before it is requested:
 *   - http or https only;
 *   - no `localhost` / `*.localhost` and no single-label host (`metadata`,
 *     `intranet`: resolved through search domains, never a public feed);
 *   - an IP literal must be a public unicast address (the ranges below);
 *   - a name is resolved first (`lookup`, every address it returns) and is
 *     refused when ANY address is non-public;
 *   - redirects are followed by hand (`redirect: "manual"`), at most
 *     MAX_FEED_REDIRECTS of them, each target checked the same way.
 *
 * THE RESIDUAL, stated rather than hidden: the name is resolved here and again
 * by `fetch`, so a hostile DNS server answering a public address to the check
 * and a private one to the connect (rebinding, TTL 0) still gets through.
 * Closing that needs the connect itself pinned to the checked address (an
 * undici dispatcher with a `connect.lookup` hook, i.e. a new dependency) and is
 * recorded as deferred in docs/audit/security-review-2026-10.md. A lookup that
 * FAILS is not a refusal: `fetch` resolves the same name through the same
 * resolver and fails the same way, so refusing would only turn a DNS hiccup
 * into a different error.
 */

export const MAX_FEED_REDIRECTS = 8; // the same ceiling as backend/src/feeds/redirect.ts
export const LOOKUP_TIMEOUT_MS = 2_000;

export class FeedAddressError extends Error {}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

/** The platform resolver: every address the name has, in resolver order. */
export const systemLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

/** Non-public IPv4: this-network, private, CGNAT, loopback, link-local,
 *  IETF/TEST-NET/benchmark ranges, multicast, reserved and broadcast. */
function blockedIpv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a >= 224; // multicast, reserved, broadcast
}

/** An IPv6 address as eight 16-bit groups, or null. Accepts `::` and a
 *  trailing dotted IPv4 (`::ffff:127.0.0.1`). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const o = ipv4Octets(s.slice(lastColon + 1));
    if (!o) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array(fill).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

function blockedIpv6(g: number[]): boolean {
  const embedded = (): number[] => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedIpv4(embedded()); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedIpv4(embedded()); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only 100::/64
  return false;
}

/** True when `ip` (an IPv4 or IPv6 literal) is not a public unicast address.
 *  Anything that does not parse as an address is treated as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ""));
  if (kind === 4) {
    const o = ipv4Octets(ip);
    return !o || blockedIpv4(o);
  }
  if (kind === 6) {
    const g = ipv6Groups(ip);
    return !g || blockedIpv6(g);
  }
  return true;
}

/** Why `url` may not be fetched without asking DNS, or null. */
export function feedUrlProblem(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `scheme ${url.protocol} is not http(s)`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "") return "no host";
  if (isIP(host.replace(/%.*$/, ""))) return isBlockedAddress(host) ? "the host is not a public address" : null;
  if (host === "localhost" || host.endsWith(".localhost")) return "the host is not a public address";
  if (!host.includes(".")) return "the host is a single-label name";
  return null;
}

async function lookupWithin(lookup: LookupAll, host: string, ms: number): Promise<Array<{ address: string }> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null; // see the header: a failed lookup is fetch's to report
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Throws FeedAddressError when `raw` names a destination a feed fetch must
 *  not reach; resolves otherwise. */
export async function assertPublicFeedUrl(raw: string, lookup: LookupAll = systemLookup): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedAddressError("feed URL refused: not a URL");
  }
  const problem = feedUrlProblem(url);
  if (problem) throw new FeedAddressError(`feed URL refused: ${problem}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host.replace(/%.*$/, ""))) return;
  const addresses = await lookupWithin(lookup, host, LOOKUP_TIMEOUT_MS);
  if (addresses && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new FeedAddressError("feed URL refused: the host resolves to a non-public address");
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` for a feed: the destination check above on the URL and on every
 * redirect target, redirects followed by hand. `inner` is read per call so a
 * test that swaps `globalThis.fetch` is honoured. Refusals reject with
 * FeedAddressError; fetchFeedConditional reports any rejection as a fetch
 * error, which both endpoints already answer as a degraded, uncached result.
 */
export function guardFeedFetch(
  inner?: typeof fetch,
  { lookup = systemLookup, maxRedirects = MAX_FEED_REDIRECTS }: { lookup?: LookupAll; maxRedirects?: number } = {}
): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const go = inner ?? globalThis.fetch;
    let current = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (let hop = 0; ; hop++) {
      await assertPublicFeedUrl(current, lookup);
      const res = await go(current, { ...init, redirect: "manual" });
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
      if (!location) return res;
      try { await res.body?.cancel(); } catch { /* nothing to release */ }
      if (hop >= maxRedirects) throw new FeedAddressError(`feed URL refused: more than ${maxRedirects} redirects`);
      current = new URL(location, current).href;
    }
  };
  return guarded as typeof fetch;
}
