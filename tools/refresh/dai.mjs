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
   store a substitute.                                                        */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA } from "../segments/politeness.mjs";

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

/** Follow the redirect chain and report the origin host.

    Uses `GET` with `Range: bytes=0-0` rather than `HEAD` — corner case #1
    records that some prefix hosts reject HEAD outright. One byte is enough to
    learn where we landed.

    THE DEFAULT USED TO BE THE BARE PRODUCT TOKEN AND VERSION, WITH NO CONTACT
    ADDRESS AT ALL. That is
    the one change in this consolidation that alters what a host receives, and it
    is a repair rather than a rename: same product token, same version, with the
    contact field that had been lopped off put back. This function resolves ~38%
    of the catalogue through download-measurement prefixes, so it is one of the
    tools a publisher is most likely to notice — and it was the one giving them
    no way to reach us. A blocked host is a host that could not ask first. */
export async function resolveHost(url, { userAgent = UA, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0", "User-Agent": userAgent },
      redirect: "follow",
      signal: ctl.signal,
    });
    return { host: new URL(res.url).host.toLowerCase(), status: res.status, error: null };
  } catch (e) {
    return { host: null, status: null, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
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

    Returns `{ dai, reason, resolved_host, checked_at }`.

    On a resolution failure we fall back to the DECLARED host — better a guess
    from the prefix than nothing — and mark the reason so a later run can
    retry. A host we cannot resolve and do not recognise is reported as
    `dai: false` with reason `unknown`: the list is the signal, and treating
    every unrecognised host as stitched would make the flag carry no
    information at all. Correct the list as we learn; #30 additionally treats
    any locally downloaded file as exact regardless of this flag, which is the
    real safety net. */
export async function classifyShow(sampleUrl, opts = {}) {
  const checked_at = new Date().toISOString();
  const declared = (() => { try { return new URL(sampleUrl).host.toLowerCase(); } catch (_) { return null; } })();

  const { host, error } = await resolveHost(sampleUrl, opts);
  const finalHost = host || declared;

  if (!finalHost) return { dai: false, reason: "unparseable url", resolved_host: null, checked_at };

  if (isDaiHost(finalHost)) {
    return {
      dai: true,
      reason: `host:${finalHost}` + (error ? ` (unresolved, declared host used: ${error})` : ""),
      resolved_host: finalHost,
      checked_at,
    };
  }
  return {
    dai: false,
    reason: error ? `unknown (resolve failed: ${error})` : "unknown",
    resolved_host: finalHost,
    checked_at,
  };
}
