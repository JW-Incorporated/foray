/* Dynamic-ad-insertion classification (issue #22).

   WHY THIS EXISTS — docs/brief/05_CORNER_CASES.md #2: a DAI host stitches ads
   per request, so the same episode GUID serves different bytes, different total
   duration (±1–4 min), and any timestamp derived from one copy misaligns
   against another. `dai_suspected` is what gates seek precision in #30: exact
   hard-seek and chapter jumps for static files, "roughly minute 70" for
   stitched ones.

   HOST LIST ONLY — the duration-variance probe was tested and dropped.
   #22 originally proposed a second signal: probe the same enclosure twice and
   compare the total length from `content-range`. Measured on six shows, three
   on known-DAI hosts and three on static ones, ~6 s apart:

     megaphone   74799906 / 74799906   delta 0
     art19       44204092 / 44204092   delta 0
     acast       75780704 / 75780704   delta 0
     blubrry    130943841 / 130943841  delta 0
     libsyn      67449904 / 67449904   delta 0
     podtrac     63356859 / 63356859   delta 0

   Zero discrimination. And on reflection the measurement was wrong in
   principle, not just underpowered: DAI is designed to serve a STABLE file to
   a given listener, so that resuming playback works. The bytes vary across
   listeners and across long time gaps, not between two requests from one IP.
   Intra-listener variance is simply the wrong thing to measure, so no amount of
   spacing would have rescued it. Dropped per the amendment on #22; the host
   list is the load-bearing signal.

   (Corollary worth carrying into #30: because a listener's own copy is stable,
   a position or bookmark THEY created is reliable for them. The misalignment
   risk is against timestamps from a different copy — chapter marks authored on
   the un-stitched master, or transcript times from a separate fetch.)

   RESOLUTION MATTERS. ~38% of this catalogue sits behind download-measurement
   prefixes that hide the origin. Measured: pdst.fm -> dcs-cached.megaphone.fm,
   i.e. 108 items that look neutral and are actually Megaphone. Classification
   therefore follows redirects; corner case #1's rule about *playing* the
   publisher's declared URL is untouched — we resolve only to look, never to
   store a substitute.

   AND IT MATCHES ON THE WHOLE CHAIN, NOT ITS END. Following the redirect to
   see through pdst.fm also throws away identifications made mid-chain:
   spreaker.com is on the list and its enclosures land on an anonymous
   CloudFront host that is not, so 2,821 breadth transcripts read as "unknown"
   on the strength of the last hop alone. See `resolveChain` below.          */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, ACCEPT_LANGUAGE, awaitHostSlot } from "../segments/politeness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const list = JSON.parse(readFileSync(join(HERE, "dai-hosts.json"), "utf8"));

export const DAI_HOSTS = list.hosts.map((h) => h.host.toLowerCase());

/** Suffix match so `megaphone.fm` covers `dcs-cached.megaphone.fm`, while
    still refusing a lookalike like `notmegaphone.fm`. */
export function isDaiHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return DAI_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/* `resolveHost` USED TO LIVE HERE and is deleted rather than kept.

   It resolved with `redirect: "follow"` and returned the landing host, which is
   the behaviour `resolveChain` replaces. Once `classifyShow` moved over it had
   no callers at all — only its own test — and leaving it exported would have
   left the module's one UNGATED `fetch` in place for the next caller to find.
   #318's wire-level User-Agent assertion pointed at it specifically, on the
   argument that it "resolves ~38% of the catalogue"; that sentence is now true
   of `resolveChain`, and the assertion moved with it. */

/** How many hops we will follow before calling it a loop. Node's own default
    for `redirect: "follow"` is 20; 10 is generous for an enclosure and bounds
    the request cost of a classification that has gone wrong. */
export const MAX_REDIRECT_HOPS = 10;

/** THE WHOLE CHAIN, not just where it stopped — and this is the fix for a bug
    that cost 2,821 transcripts.

    `resolveHost` above uses `redirect: "follow"`, which means Node walks the
    chain internally and hands back only the final URL. That was written to see
    THROUGH prefixes like pdst.fm, and it does. What nobody noticed is that it
    is equally good at seeing PAST an identification the chain already made:

      dts.podtrac.com  ->  api.spreaker.com  ->  d1bxy2pveef3fq.cloudfront.net

    `spreaker.com` is on the DAI list. It is the middle hop. Following to the
    end lands on an anonymous CloudFront distribution that is on no list, so the
    show classified `{dai: false, reason: "unknown"}` — a positive
    identification thrown away by the very step that was added to find one.
    Measured on breadth tranche 1: five Spreaker shows, 2,470 timed transcripts,
    62% of the whole tranche's anchorable haul, cleared by a redirect.

    So: a known DAI platform ANYWHERE in the chain is evidence, wherever the
    chain lands. Ad stitching happens at the platform, and the CDN it hands the
    assembled bytes to is a delivery detail, not an exoneration.

    THE COST IS ONE REQUEST PER HOP instead of one per chain, which is why
    every hop goes through the shared per-host gate rather than firing at line
    rate — `redirect: "follow"` gets Node's internal chain-walk for free and
    unthrottled, and doing it by hand means doing the politeness by hand too.
    Same `Range: bytes=0-0` as `resolveHost`, same reason (corner case #1: some
    prefix hosts reject HEAD outright), and the same never-download rule: two
    bytes, never a file.

    THE HEADERS ARE NOT THIS FUNCTION'S TO INVENT. `accept-language` is here
    because Node defaults it to `*` and Captivate's
    `episodes.captivate.fm/episode/<guid>.mp3` redirectors answer `*` with
    `404 Missing redirect URL` — measured twice, see `politeness.mjs`. Under
    `redirect: "follow"` that cost us a landing host; walking the chain by hand
    makes it cost the whole walk, because the 302 IS the thing we came for.
    (`AUDIO_PROBE_HEADERS` is deliberately not imported wholesale: it carries
    `AUDIO_UA`, and this is the client asking, not the audio fetcher.)

    Returns `{ chain, host, landed, status, error }`. `chain` is every host
    visited in order, first-seen-wins, INCLUDING the one we started at — a feed
    that declares a DAI host directly is the zero-hop case of the same rule.

    `host` and `landed` DIFFER ON THE ERROR PATH and the distinction is the
    point: `host` is the last host we touched, `landed` is the last one that
    actually answered with something other than a redirect. A walk that dies at
    hop three has a `host` it never got an answer from, and calling that a
    "resolved origin" would put hosts into `classify-dai.mjs`'s origin histogram
    that were never reached. On an error the chain is still returned as far as
    it got, because a partial chain that already names a DAI platform is a
    complete answer to the DAI question. */
export async function resolveChain(url, {
  userAgent = UA,
  timeoutMs = 15000,
  maxHops = MAX_REDIRECT_HOPS,
  gate = awaitHostSlot,
  fetchImpl = fetch,
} = {}) {
  const chain = [];
  let current = String(url);
  let status = null;
  let landed = null;
  const out = (host, error) => ({ chain, host, landed, status, error });

  for (let hop = 0; hop <= maxHops; hop++) {
    let here;
    try {
      here = new URL(current);
    } catch (_) {
      return out(chain.length ? chain[chain.length - 1] : null, "unparseable url");
    }
    const host = here.host.toLowerCase();
    if (!chain.includes(host)) chain.push(host);

    if (hop === maxHops) return out(host, "too many redirects");

    await gate(current);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, {
        headers: { Range: "bytes=0-0", "User-Agent": userAgent, "accept-language": ACCEPT_LANGUAGE },
        redirect: "manual",
        signal: ctl.signal,
      });
    } catch (e) {
      return out(host, e.name === "AbortError" ? "timeout" : e.message);
    } finally {
      clearTimeout(timer);
    }

    status = res.status ?? null;
    /* Two bytes were asked for and the body is not wanted at all; an
       un-cancelled body on a manual redirect keeps the socket open. */
    if (res.body && typeof res.body.cancel === "function") await res.body.cancel().catch(() => {});

    const location = status >= 300 && status < 400 ? res.headers?.get?.("location") : null;
    if (!location) {
      /* A 3xx with no `Location` is where the chain ends, not an error: some
         hosts answer 304 or a bare 302 and there is nothing further to follow.

         A 4xx/5xx IS an error, and saying so is the whole lesson of #316. A
         403 has no `Location` either, so the obvious version of this line
         returns "resolved successfully" for a host that refused us — and the
         record then reads `dai: false, reason: "unknown"`, which is
         indistinguishable from a chain that really landed somewhere static and
         makes the show ANCHORABLE. That is how a blocked User-Agent quietly
         became 423 unmeasurable transcripts in `ad-inflation.mjs`. Here the
         refusal is named, so it is greppable and retriable. */
      if (status != null && status >= 400) return out(host, `HTTP ${status}`);
      landed = host;
      return out(host, null);
    }

    let next;
    try {
      next = new URL(location, current);
    } catch (_) {
      return out(host, `unfollowable redirect: ${String(location).slice(0, 80)}`);
    }
    /* A `Location: mailto:...` or `Location: itms://...` is not something to
       fetch. Without this the loop pushes an empty-string host into the chain
       and spends a request proving a non-HTTP URL is not audio. */
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return out(host, `unfollowable scheme: ${next.protocol}`);
    }
    current = next.href;
  }
  /* Unreachable: the `hop === maxHops` guard returns first. Here so the
     function has no implicit-undefined exit. */
  return out(chain[chain.length - 1] ?? null, "too many redirects");
}

/** The first host in a chain that is a known DAI platform, or null.

    FIRST, not last, deliberately: the chain runs prefix -> platform -> CDN, so
    the earliest match is the most specific thing we can name. It is also the
    one a human can check by hand. */
export function daiHostIn(hosts) {
  for (const h of hosts || []) if (isDaiHost(h)) return h;
  return null;
}

/** The `reason` string for a verdict, written ONCE.

    `classify-dai.mjs --reclassify` recomputes verdicts from cached hosts with
    no network, so it has to be able to produce the same sentence this module
    produces online. It used to spell its own — `dai ? \`host:${h}\` : "unknown"`
    — which was harmless only for as long as the two stayed one line. The moment
    a verdict could name a host that is not the resolved one, two spellings of
    the same sentence became two answers, and `--reclassify` is the one that
    silently overwrites the other. Same rule as the host list itself: one
    definition, imported.

    "DECLARED HOST USED" IS GONE FROM THIS STRING, because it stopped being
    true. `resolveHost` returned `host: null` on any failure, so the fallback
    genuinely was the declared host and the clause was accurate. `resolveChain`
    returns the hop it died on, which is usually neither the landing host nor
    the declared one — so a chain that failed at `dcs-cached.megaphone.fm` after
    starting at `pdst.fm` used to be recorded as "declared host used", naming a
    host that was not the declared one, in a file we treat as evidence. It now
    says where it stopped, which is what it knows. */
export function daiReason(via, finalHost, error) {
  if (via) {
    const detour = via !== finalHost ? ` (in redirect chain; landed on ${finalHost})` : "";
    return `host:${via}${detour}` + (error ? ` (chain incomplete at ${finalHost}: ${error})` : "");
  }
  return error ? `unknown (resolve failed: ${error})` : "unknown";
}

/** Fold a fresh host verdict into whatever the cache already holds for a show.

    THE OBVIOUS VERSION SILENTLY DESTROYS EVIDENCE. `--recheck` used to do
    `cache.shows[cid] = { show, ...verdict }`, which is correct for the four
    fields this file owns and quietly deletes every field it does not — as of
    2026-08-23 that is `ad_inflation`, the measured ad-load verdict and the
    per-episode byte samples behind it (`tools/transcribe/ad-inflation.mjs`).
    A re-resolve costs one HEAD-free ranged GET; re-earning the measurement it
    threw away costs another 112, and nothing would have reported the loss.

    The host verdict still WINS for its own four fields — a recheck that could
    not overwrite a stale `dai` would be pointless. It just does not get to
    speak for fields it knows nothing about. */
export function mergeShowEntry(existing, show, verdict) {
  return { ...(existing || {}), show, ...verdict };
}

/** Classify one show from a sample episode URL.

    Returns `{ dai, reason, resolved_host, resolved_chain, checked_at }`.

    `resolved_chain` is ADDED, not substituted. `data/dai-classification.json`
    is read by `tools/transcribe/ad-inflation.mjs`, `classify-dai.mjs` and the
    breadth report, and it carries `ad_inflation` blocks that cost 112 requests
    to earn (#316); `resolved_host` keeps meaning exactly what it meant — where
    the chain landed — so every existing reader is unaffected and the new field
    is the only thing they have to learn.

    ON A FAILURE `resolved_host` IS THE HOST THAT ANSWERED LAST, falling back to
    the declared one when nothing answered at all. It is deliberately NOT the
    hop the walk died at: `classify-dai.mjs` prints a "resolved origins"
    histogram from this field, and a host we never got a reply from is not an
    origin. The failing hop is still named — in `reason`, where it reads as the
    incident it is rather than as a result.

    A host we cannot resolve and do not recognise is reported as `dai: false`
    with reason `unknown`: the list is the signal, and treating every
    unrecognised host as stitched would make the flag carry no information at
    all. Correct the list as we learn; #30 additionally treats any locally
    downloaded file as exact regardless of this flag, which is the real safety
    net. */
export async function classifyShow(sampleUrl, opts = {}) {
  const checked_at = new Date().toISOString();
  const declared = (() => { try { return new URL(sampleUrl).host.toLowerCase(); } catch (_) { return null; } })();

  /* `resolveChain` records each host BEFORE it tries to fetch from it, so a
     chain that dies on its first hop still returns `[declaredHost]` and there
     is nothing here to fall back to. An earlier draft carried a
     `chain.length ? chain : [declared]` guard with a test to match; the mutant
     that deleted it passed, which is how the guard was found to be guarding
     unreachable code. The reachable version of that concern lives in
     `resolveChain` itself and is tested there. */
  const { chain, host, landed, error } = await resolveChain(sampleUrl, opts);
  const finalHost = landed || declared || host;
  /* Named separately because the two want different things: the RECORD wants
     the origin, the reason wants the incident. */
  const stoppedAt = host || declared;

  if (!finalHost) return { dai: false, reason: "unparseable url", resolved_host: null, resolved_chain: [], checked_at };

  const via = daiHostIn(chain);
  return {
    dai: !!via,
    reason: daiReason(via, error ? stoppedAt : finalHost, error),
    resolved_host: finalHost,
    resolved_chain: chain,
    checked_at,
  };
}
