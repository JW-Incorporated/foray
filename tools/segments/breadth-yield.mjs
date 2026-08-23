/* Breadth yield — is sweeping the other ~19,000 feeds worth the requests?
   (issue #114, epic #102). STATIC, keyless, no dependencies, NO NETWORK.

   WHY THIS EXISTS AS ITS OWN FILE. `sweep-transcripts.mjs` already prints a
   run summary, and that summary cannot answer this question, for two reasons
   that are easy to miss:

   1. IT POOLS THE ARMS. The tranche is deliberately two samples — a ranked
      EXPLOIT head and a uniform-random EXPLORE arm (see `rank-breadth.mjs`) —
      and their yields mean opposite things. Exploit yield is what a *targeted*
      sweep returns; explore yield is what the *population* returns. Averaging
      them produces a number that is true of neither and reads as both. This
      file refuses to print a pooled headline rate without the split.

   2. IT COUNTS EPISODES, AND THE DECISION IS PER REQUEST. The budget that
      binds is polite requests, and a request is a FEED, not an episode. A
      sweep that reports "77% of episodes have transcripts" is reporting the
      property of the twenty shows that happened to be enormous. Transcripts
      per feed swept is the number that multiplies out to a projection.

   THE COMMITTED FILE IS A SUMMARY, AND THAT IS A SIZE DECISION, NOT A STYLE
   ONE. The swept index keeps episode rows at ~951 bytes each; the ranked
   tranche's first 20 shows alone produced 55MB. Committing that shape for the
   full catalogue is a ~700MB file on the low estimate and several GB on the
   measured one, into a `data/` that is already 62MB. So episode rows stay in
   `data-local/` with the transcript bodies (#255's rule), and what lands in
   git is one row per show: the counts, the DAI verdict, the arm, and nothing
   that scales with episodes. Measured on tranche 1: 734 bytes per show, so
   ~13.6MB if every feed in the catalogue is eventually swept — a size `data/` can
   hold, where the episode-row shape (~6.4GB on the same projection) cannot.

   ANCHORABILITY IS REPORTED SEPARATELY FROM SUPPLY, BECAUSE THEY DIVERGE.
   Transcripts cluster on the big networks, and the big networks inject ads
   (ADR-0007): a timed transcript on a DAI show describes a timeline that is
   not the one we receive. So "transcripts found" and "transcripts we can cut a
   segment from" are different numbers with different implications, and a report
   that only prints the first one is the optimistic half of the finding.

   Usage:
     node tools/segments/breadth-yield.mjs \
       --breadth data-local/breadth/availability-breadth.json \
       --baseline data/transcript-availability.json \
       --out data/breadth-transcript-yield.json
*/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { isDaiHost } from "../refresh/dai.mjs";
import { AD_FREE_SHOWS } from "./fetch-transcripts.mjs";
import { hostKeyOf } from "./rank-breadth.mjs";
/* The list of committed measurement ledgers — from `ledgers.mjs`, which holds
   nothing but two frozen arrays of strings, and NOT from `measure-suspects.mjs`,
   which writes them and carries `ad-inflation.mjs`'s whole fetch stack. That
   import would have put a network path one autocomplete away from a module
   whose suite asserts it has none, to save copying three strings. The same
   distinction `MEASURED_AD_FREE` below draws about importing
   `fetch-transcripts.mjs`'s module without importing its fetcher. */
import { MEASURED_REPORT_RELS } from "./ledgers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Either platform's path separator — this module reads paths written on one
    and renders them on the other. */
const SEP = /[\\/]/;

/** Shows flagged DAI whose delivered audio was MEASURED byte-identical, so
    their publisher timestamps still anchor.

    RE-EXPORTED, NOT RESTATED, and the first version of this file got that
    wrong. It carried its own copy — `["Being an Engineer", "Geology Bites",
    "Practical AI"]` — with a comment explaining that a reporting tool should
    not import a fetcher. The list then grew to 14 on main when the ad-inflation
    scan landed (#316), this copy did not, and CI caught the two disagreeing
    about which transcripts are anchorable. That is the same two-copies failure
    `politeness.mjs` was extracted to end, reintroduced in the same directory
    by the same reasoning.

    Importing the fetcher's module is fine; importing its FETCHER is not. The
    named import below is what keeps that distinction, and the suite pins that
    this stays a named import so `fetchBody` cannot drift in beside it — exactly
    the arrangement already used for `isDaiHost` from `dai.mjs`.

    KEYED ON TITLE, which is a known weakness rather than an oversight. Titles
    are unique enough across 220 curated shows; across 19,436 breadth feeds they
    are not, so a breadth show sharing a name with a measured one would be
    silently exempted from both the anchorable test and the suspect check. The
    right fix is to re-key on `show_id` in `fetch-transcripts.mjs`, where the
    list lives, rather than to fork a stricter key here. Measured today: no
    breadth title in tranche 1 collides. */
export { AD_FREE_SHOWS as MEASURED_AD_FREE };

/** Anchorable = the timeline in the transcript describes the audio we receive.
    Non-DAI by construction, or DAI-flagged and measured otherwise.

    `dai_suspected === null` (the DAI probe could not resolve) counts as NOT
    anchorable here. That is the conservative direction and it is the honest
    one: an unresolved show is an unknown, and reporting unknowns as wins is
    how a yield number becomes a promise the corpus cannot keep. They are
    counted separately as `unresolved` so the number is visible rather than
    quietly absorbed.

    THIS IS THE ONE PLACE THIS FILE DELIBERATELY DISAGREES WITH THE FETCHER, and
    saying so precisely matters more than the agreement would. `isAnchorableShow`
    in `fetch-transcripts.mjs` reads `dai_suspected !== true`, so a null is
    anchorable TO IT and not anchorable here. On every other input the two agree,
    and `breadth-yield.test.mjs` drives both predicates over the full
    {null, true, false} x {on-list, off-list} grid so the relationship is pinned
    rather than asserted in prose. The divergence is invisible on tranche 1
    (`shows_dai_unresolved` is 0 in all four arms) and would show up the moment a
    tranche contains a feed whose enclosure will not resolve — as a report that
    is stricter than the fetch, which is the safe direction for a number that
    gets multiplied by 19,000. */
export function isAnchorable(show) {
  if ((show.episodes_with_timed_transcript || 0) === 0) return false;
  if (show.dai_suspected === false) return true;
  return show.dai_suspected === true && AD_FREE_SHOWS.includes(show.title);
}

/* ------------------------------------------- when "not DAI" means "unknown"

   THE MOST IMPORTANT THING THIS TRANCHE MEASURED, and it is a caveat rather
   than a win. `classifyShow` resolves an enclosure through its redirects and
   matches the ORIGIN against `tools/refresh/dai.mjs`'s host list. That list was
   assembled from the hosts 220 curated shows use, and breadth immediately
   produced origins it has never seen — at which point the function returns
   `{dai: false, reason: "unknown"}`. Every anchorable show in this tranche
   carries `dai_reason: "unknown"`. Not one was positively verified as static;
   they are all "we did not recognise where this came from", filed as a pass.

   Two failure shapes, both measured here, both of which put UNANCHORABLE
   transcripts into the usable pool — the only direction that actually costs
   something:

     RESOLUTION LOSES THE SIGNAL. `spreaker.com` is on the DAI host list. Its
     enclosures redirect to `d1bxy2pveef3fq.cloudfront.net`, an anonymous
     CloudFront distribution that is not. So following the redirect — the step
     dai.mjs added specifically to SEE THROUGH prefixes like pdst.fm — throws
     away a positive identification the feed URL already had. Five Spreaker
     shows, 2,470 timed transcripts, 62% of this tranche's entire anchorable
     haul, cleared by a redirect.

     THE ORIGIN NAMES AN AD VENDOR AND IS STILL UNLISTED.
     `adswizz.podigee-cdn.net` is AdsWizz, an ad-insertion company, and is not
     on the list. Two shows, 351 transcripts.

   LABELLED, NOT EXCLUDED, per the standing rule — and for a substantive reason
   too. `isAnchorable` above tracks the predicate `fetch-transcripts.mjs`
   selects on (see its header for the one deliberate exception, and the test
   that pins the whole grid); folding this heuristic into it would mean the
   report and the fetcher silently disagreed about what the corpus contains. So
   the rows stay anchorable, stay in every count, and are ALSO reported as a
   named shortlist with the number they represent.

   AND A MEASUREMENT OUTRANKS THE HEURISTIC. `MEASURED_AD_FREE` shows are
   skipped: run against the curated baseline without that exemption, the
   feed-host rule flags Being an Engineer, Geology Bites and Practical AI —
   precisely the three shows somebody measured delivering byte-identical audio
   — and cuts the curated baseline from 587 anchorable transcripts to 67. Every
   breadth-vs-curated comparison in the report would then be against a baseline
   this file had just invented, in the flattering direction. */

/** Substrings that name an ad-tech vendor in a resolved enclosure host. */
export const AD_TECH_HOST_MARKERS = ["adswizz", "adbarker", "adtonos", "adcontext", "targetspot"];

/** The MEASURED disposition of each suspect, keyed on show_id, from
    `data/breadth-suspect-inflation.json` (#319's scan).

    WHY THIS HAS TO BE READ HERE AND WAS NOT. #319 spent 7 feeds and 54 ranged
    GETs settling tranche 1's seven suspects and committed every byte count it
    measured — and then nothing read the file. `suspectAnchorable` below stayed
    a pure hostname heuristic, so the tool went on reporting 1,131 net while the
    measurement beside it said 1,145, and the only place the measured number
    existed was a PR body. A committed measurement that no tool consults is a
    number that decays into folklore, which is the exact failure the stale
    `anchorable_timed_transcripts: 3952` in this file's own output already was.

    `disposition` is the field to read, NOT `verdict`. Four of the seven carry
    `verdict: "ad-free"` — a median ratio over five episodes — while inserting
    into some of those five; `dispositionOf` in `measure-suspects.mjs` is the
    one that looks at whether ANY sample was caught mid-insert, and reading
    `verdict` here would readmit 481 transcripts from shows measured injecting.

    ABSENCE IS NOT A RECOVERY. A show with no entry keeps whatever the heuristic
    said about it. The other default — unmeasured means clean — is the single
    most expensive mistake available in this file, because the unmeasured set is
    the whole rest of the catalogue.

    SEVERAL REPORTS, NOT ONE (#321). There are now two pools and two files:
    #319's `breadth-suspect-inflation.json` settles the shortlist, and #321's
    `breadth-anchorable-inflation.json` settles the shows the shortlist never
    flagged. Reading one of them is how #320 found this function in the first
    place — a committed measurement that no tool consults decays into folklore —
    and reading only the newer one would silently un-drop five shows #319 caught
    injecting. LATER FILES WIN on a show_id present in both, because the only
    reason to measure a show twice is that the first answer is stale. Nothing
    overlaps today: `selectPool` excludes anything already settled. */
export function measuredDispositions(reports) {
  const out = new Map();
  for (const report of Array.isArray(reports) ? reports : [reports]) {
    for (const r of report?.results || []) {
      if (r?.show_id != null && r.disposition) out.set(String(r.show_id), r.disposition);
    }
  }
  return out;
}

/** THE DELIVERABLE: how much of the anchorable corpus is MEASURED, not inferred.

    WHY A COUNT WAS NOT ENOUGH. This file has always printed
    `anchorable_net_of_suspects` — 10,933 after #320 — and that number says
    nothing about what it rests on. Every one of those transcripts came from a
    show whose `dai_reason` is `"unknown"`, which is not "verified static" but
    "`classifyShow` walked the redirect chain and recognised no host on it". A
    negative filed as a pass. "10,933, all inferred" and "6,000, all measured"
    are very different assets and the second is worth more, and until this
    function existed the report could not tell them apart.

    FIVE BUCKETS, AND THE SPLIT IS ON WHAT WE KNOW RATHER THAN ON WHAT WE KEEP.
    The two `excluded_*` buckets are the rows netted OUT — one because bytes
    caught the show inserting, one because a hostname made it suspicious and
    nobody has measured it yet — and they are separated because they want
    opposite follow-ups: the first is settled, the second is a queue. The three
    remaining buckets are exactly the rows inside `anchorable_net_of_suspects`,
    so `measured_clean + measured_unresolved + inferred` reconstructs the
    headline number and the suite asserts that identity.

    `measured_unresolved` IS NOT A THIRD KIND OF CLEAN. A show is unresolved
    when the probe ran and could not conclude — no declared length to divide by,
    a sample too thin, delivered bytes short of the declaration. It keeps its
    pre-measurement status, which for a row nobody suspected means it stays in
    the corpus. That is the "label, never exclude" rule and it is deliberately
    NOT a gate: ADR-0008 reversed a sourcing gate and moving these rows out on
    "we could not tell" would re-impose one in a new unit. But it must never be
    counted as measured either, so it gets its own bucket rather than being
    folded into `inferred` (where it would hide the fact that requests were
    already spent on it) or into `measured_clean` (where it would be a lie). */
export function measurementCoverage(rows, suspects = [], measured = new Map()) {
  const suspectIds = new Set(suspects.map((s) => String(s.show_id)));
  const buckets = {
    measured_clean: [],
    measured_unresolved: [],
    inferred: [],
    excluded_measured_injecting: [],
    excluded_by_heuristic: [],
  };
  for (const r of rows) {
    /* `r.anchorable` ALONE, matching `anchorableNetOfSuspects` exactly. An
       earlier version also required `status === "ok"`, which a reviewer showed
       makes the two disagree by construction — the buckets are required to sum
       to the headline number, and the headline number never consults `status`.
       They read the same today only because `isAnchorable` needs at least one
       timed transcript and a failed sweep row has none; the first row that is
       both anchorable and not-ok would put two different values under the same
       `anchorable_net_of_suspects` key in one file. Agreement has to come from
       using the same predicate, not from a property of the current data. */
    if (!r.anchorable) continue;
    const id = String(r.show_id);
    const d = measured.get(id);
    /* SUSPECT MEMBERSHIP DECIDES FIRST, and it has to. A row's disposition says
       what the bytes showed; `suspects` says whether this report counts it. A
       heuristic suspect that was probed and came back `unresolved` is still
       netted out, so filing it under `measured_unresolved` would put a row
       outside the headline number into a bucket that sums to it. */
    if (suspectIds.has(id)) {
      (d === "drop" ? buckets.excluded_measured_injecting : buckets.excluded_by_heuristic).push(r);
    } else if (d === "recover") buckets.measured_clean.push(r);
    else if (d === "unresolved") buckets.measured_unresolved.push(r);
    else buckets.inferred.push(r);
  }
  const tally = (k) => ({
    shows: buckets[k].length,
    timed_transcripts: buckets[k].reduce((n, r) => n + r.episodes_with_timed_transcript, 0),
  });
  const out = Object.fromEntries(Object.keys(buckets).map((k) => [k, tally(k)]));
  const net =
    out.measured_clean.timed_transcripts +
    out.measured_unresolved.timed_transcripts +
    out.inferred.timed_transcripts;
  return {
    ...out,
    anchorable_net_of_suspects: net,
    measured_pct_of_net: pct(out.measured_clean.timed_transcripts, net),
    note:
      "measured_clean is the only bucket a measurement admitted; measured_unresolved was probed and " +
      "could not be settled, inferred was never probed, and both remain in the net count on the " +
      "label-never-exclude rule rather than on evidence",
  };
}

/** Anchorable shows whose "not DAI" verdict is contradicted by something we
    already know. Each entry carries WHY, because the two reasons want different
    follow-ups: `dai-host-lost-in-redirect` is a fix to `dai.mjs` (match the feed
    host too, not only the resolved one), while `ad-tech-origin` is a host to add
    to that list once someone measures it with `tools/transcribe/ad-inflation.mjs`.

    `isDaiHost` is injected rather than imported at the call site so the suite can
    exercise both reasons without depending on the contents of a data file that
    is expected to change. */
export function suspectAnchorable(rows, { isDaiHost = () => false, hostOfFeed = hostKeyOf, measured = new Map() } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.anchorable) continue;
    /* A MEASUREMENT OUTRANKS THE HEURISTIC — the same rule `AD_FREE_SHOWS`
       already gets two lines below, applied to the shows somebody measured
       since. `recover` means the delivered bytes matched the declared ones on
       every episode probed, so the hostname that made this row suspicious has
       been answered and the row is no longer one to net out. `drop` keeps it
       suspect and upgrades the REASON from a guess to a measurement, which
       matters when someone re-reads the shortlist to decide what to probe next:
       a row that has already been settled should not read as an open question. */
    const disposition = measured.get(String(r.show_id));
    if (disposition === "recover") continue;
    /* ORDER MATTERS, AND IT IS MEASURED-DROP FIRST. `AD_FREE_SHOWS` is itself a
       measurement, but an older one and keyed on TITLE; a show that appears in
       both is one that has since been caught injecting, and letting the title
       list `continue` past this would treat it as clean on the strength of the
       measurement that was superseded. No show is in both today — this is the
       precedence the comment above claims, made true in the code rather than in
       prose. */
    if (disposition === "drop") {
      out.push(suspectRow(r, hostOfFeed, "measured-injecting"));
      continue;
    }
    // A MEASUREMENT OUTRANKS THIS HEURISTIC, and skipping that check was a real
    // bug: run against the curated baseline, the feed-host rule flagged Being an
    // Engineer, Geology Bites and Practical AI — which are `AD_FREE_SHOWS`,
    // i.e. the three shows someone actually measured delivering byte-identical
    // audio. It would have cut the curated baseline from 587 anchorable
    // transcripts to 67 and made every breadth-vs-curated comparison in the
    // report meaningless, in the flattering direction.
    if (AD_FREE_SHOWS.includes(r.title)) continue;
    /* THE WHOLE CHAIN, NOT THE LAST HOP — which is the bug #319 fixed one
       level down, left standing in its sibling. `classifyShow` used to judge
       only where a redirect landed, so `api.spreaker.com` in the middle of a
       chain was discarded and five shows worth 2,470 transcripts read as clean;
       this check had the identical shape, matching ad-tech markers against
       `enclosure_host` alone. An insertion vendor is no more obliged to be the
       last hop than a DAI platform is.

       MEASURED ACROSS BOTH TRANCHES: 0 additional rows. That is the honest
       result and it is the reason to land the change now rather than when it
       finally costs something — the markers list is expected to grow (see
       `_adswizz_note` in dai-hosts.json), and a marker added later would
       otherwise only be looked for in one position.

       The chain arrives on a summary row as the joined string `summaryRow`
       writes, so a substring test over it covers every hop including the last;
       `origin` is kept for rows swept before #319, which have no chain at all. */
    const origin = String(r.enclosure_host || "").toLowerCase();
    const chain = String(r.enclosure_chain || "").toLowerCase();
    const adTech = [origin, chain].some((s) => s && AD_TECH_HOST_MARKERS.some((m) => s.includes(m)));
    let reason = null;
    if (isDaiHost(hostOfFeed(r.feed_url))) reason = "dai-host-lost-in-redirect";
    else if (adTech) reason = "ad-tech-origin";
    if (!reason) continue;
    out.push(suspectRow(r, hostOfFeed, reason));
  }
  return out.sort((a, b) => b.timed_transcripts - a.timed_transcripts);
}

/** One shortlist entry. Extracted only so the measured-drop branch above and
    the heuristic branch cannot drift in what they report. */
function suspectRow(r, hostOfFeed, reason) {
  return {
    show_id: r.show_id,
    title: r.title,
    feed_host: hostOfFeed(r.feed_url),
    enclosure_host: r.enclosure_host,
    reason,
    timed_transcripts: r.episodes_with_timed_transcript,
  };
}

/** The anchorable count with every suspect row removed — the conservative read,
    reported next to the optimistic one rather than instead of it. */
export function anchorableNetOfSuspects(rows, suspects) {
  const drop = new Set(suspects.map((x) => String(x.show_id)));
  return rows
    .filter((r) => r.anchorable && !drop.has(String(r.show_id)))
    .reduce((n, r) => n + r.episodes_with_timed_transcript, 0);
}

/** One row per show. Everything here is O(1) in episodes — that is the whole
    point of the file. `episode_rows_available` is carried through so a later
    pass can see which shows were truncated by `--max-episode-rows`. */
export function summaryRow(show) {
  return {
    show_id: show.show_id,
    apple_collection_id: show.apple_collection_id ?? null,
    title: show.title ?? null,
    feed_url: show.feed_url,
    host_key: hostKeyOf(show.feed_url),
    arm: show.arm ?? null,
    /* Both flat scalars, both O(1) in episodes, so the file's one size rule
       holds. `tranche` is what makes a multi-tranche report readable at all;
       `rank_position` is the depth axis `byRankBucket` reads. */
    tranche: show.tranche ?? null,
    rank_position: show.rank_position ?? null,
    status: show.status,
    error_code: show.error_code ?? null,
    dai_suspected: show.dai_suspected ?? null,
    /* CARRIED because the headline caveat is about this field and nothing else
       can express it: every anchorable row in both tranches reads "unknown",
       i.e. "no host anywhere in this chain is on the list", not "verified
       static". Without it that claim is only checkable against a gitignored
       index, which for a caveat attached to five figures of supply is the wrong
       place for the evidence to live. A short scalar; `enclosure_chain` beside
       it is the longer half of the same evidence. */
    dai_reason: show.dai_reason ?? null,
    enclosure_host: show.enclosure_host ?? null,
    /* CARRIED, and it is the one field here that grows the committed file for a
       reason other than counting: it is the EVIDENCE for `dai_suspected`. A row
       holding only the last hop cannot be re-judged when the host list changes
       — which is how five Spreaker shows sat at `dai_reason: "unknown"` while
       `api.spreaker.com` was the middle hop of their own redirect.

       JOINED INTO ONE STRING RATHER THAN LEFT AS AN ARRAY, because the row
       below every other field of which is a flat scalar, and the suite asserts
       exactly that ("a summary row carries nothing that scales with episode
       count"). An array here passes that assertion today ONLY because the test
       fixture omits the field — the guard would have gone on being green while
       every real sweep wrote arrays past it. A chain is two to four hosts and
       does not scale with episodes, so it belongs in the file; it just has to
       arrive in the shape the file already promises. `split(" > ")` recovers
       the hops. */
    enclosure_chain: (show.enclosure_chain || []).join(" > ") || null,
    episodes_total: show.episodes_total || 0,
    episodes_with_transcript: show.episodes_with_transcript || 0,
    episodes_with_timed_transcript: show.episodes_with_timed_transcript || 0,
    episodes_with_chapters: show.episodes_with_chapters || 0,
    episode_rows_available: show.episode_rows_available ?? null,
    anchorable: isAnchorable(show),
    swept_at: show.swept_at ?? null,
  };
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const per = (n, d) => (d ? Math.round((n / d) * 10) / 10 : 0);

/** The per-request yield of one set of shows. Denominated in FEEDS SWEPT,
    including the ones that failed: a dead feed still cost a request (three, in
    fact — the retry ladder), so excluding failures from the denominator would
    quietly inflate every projection built on this number. `shows_ok` is
    reported alongside so the failure rate is visible rather than buried. */
export function yieldOf(rows, suspects = []) {
  const ok = rows.filter((r) => r.status === "ok");
  const timed = ok.reduce((n, r) => n + r.episodes_with_timed_transcript, 0);
  const anchorableRows = ok.filter((r) => r.anchorable);
  const anchorableTimed = anchorableRows.reduce((n, r) => n + r.episodes_with_timed_transcript, 0);
  const net = anchorableNetOfSuspects(ok, suspects);
  return {
    shows_swept: rows.length,
    shows_ok: ok.length,
    shows_failed: rows.length - ok.length,
    shows_with_timed: ok.filter((r) => r.episodes_with_timed_transcript > 0).length,
    shows_with_timed_pct: pct(ok.filter((r) => r.episodes_with_timed_transcript > 0).length, ok.length),
    shows_anchorable: anchorableRows.length,
    shows_dai_unresolved: ok.filter((r) => r.dai_suspected == null).length,
    episodes_total: ok.reduce((n, r) => n + r.episodes_total, 0),
    transcripts: ok.reduce((n, r) => n + r.episodes_with_transcript, 0),
    timed_transcripts: timed,
    anchorable_timed_transcripts: anchorableTimed,
    anchorable_net_of_suspects: net,
    /* The decision numbers. Per FEED SWEPT, not per feed that worked.

       `net_anchorable_per_show_swept` IS THE ONE TO QUOTE, and computing it per
       arm rather than once over the pool is the entire reason `suspects` is a
       parameter here. Pooled, tranche 1's suspects are 71% of the anchorable
       haul and the explore arm reads as 7.8/feed against a curated 2.7 — 2.9x
       better. Per arm, the explore arm's suspects are 91% of ITS haul, it lands
       at 0.68/feed, and the true comparison is 3.9x WORSE. Same rows, same
       arithmetic, opposite conclusion, and the second one is the one that
       generalises to the unswept catalogue. */
    timed_per_show_swept: per(timed, rows.length),
    anchorable_per_show_swept: per(anchorableTimed, rows.length),
    net_anchorable_per_show_swept: per(net, rows.length),
  };
}

/** Per-platform yield, sorted by feeds swept. This is the output that makes the
    NEXT tranche better than this one: `rank-breadth.mjs` reads its priors from
    the swept index, so every host measured here is a host that stops being
    guessed at. */
export function byHost(rows, suspects = []) {
  const hosts = new Map();
  for (const r of rows) {
    const h = hosts.get(r.host_key) || { host: r.host_key, rows: [] };
    h.rows.push(r);
    hosts.set(r.host_key, h);
  }
  return [...hosts.values()]
    .map((h) => ({ host: h.host, ...yieldOf(h.rows, suspects) }))
    .sort((a, b) => b.shows_swept - a.shows_swept || b.timed_transcripts - a.timed_transcripts);
}

/** Yield by DEPTH DOWN THE RANKING — does the ordering keep paying?

    THE QUESTION THIS ANSWERS IS WHERE TO STOP, and nothing else in this file
    can answer it. `byHost` says which platform paid; the arm split says whether
    ranking beat random. Neither says whether rank 600 was still worth a request
    when rank 1 clearly was, and that is the number that decides how much of the
    remaining catalogue to sweep. A ranked head whose yield is flat says sweep
    on; one that decays to the explore arm's rate says the ordering has been
    exhausted and the rest of the catalogue is a uniform sample wearing a rank.

    EQUAL COUNTS OF FEEDS, NOT OF TRANSCRIPTS. The budget is denominated in
    requests, so a bucket is a fixed number of requests and the transcripts are
    what varies. Bucketing on equal transcript counts would put the first three
    shows in bucket one and hide the entire decay inside it.

    ROWS MUST ALREADY CARRY `rank_position`, i.e. they must come from ONE
    tranche's exploit arm. Explore rows are dropped rather than ranked, and
    mixing two tranches is the caller's error to avoid — see `attachArms`.

    `suspects` is threaded through for the same reason `yieldOf` takes it: the
    suspect rows are concentrated, so a bucket containing one of them reports a
    gross number several times its net one, and a decay curve drawn on gross
    figures measures where the suspects happened to land. */
export function byRankBucket(rows, suspects = [], { buckets = 6 } = {}) {
  const ranked = rows
    .filter((r) => Number.isFinite(r.rank_position))
    .sort((a, b) => a.rank_position - b.rank_position);
  if (!ranked.length || !Number.isInteger(buckets) || buckets < 1) return [];

  /* THE REMAINDER IS SPREAD, NOT DUMPED IN A TAIL. `ceil(n/buckets)` then
     slicing does not produce `buckets` buckets: 10 rows into 6 gives FIVE
     buckets of 2, and 7 into 3 gives 3+3+1 — a one-feed bucket plotted on the
     same axis as two three-feed ones, which is a rate computed from a single
     feed presented as a comparable point. Invisible on this tranche only
     because 300 and 600 divide by 6 evenly. Sizes now differ by at most one. */
  const n = Math.min(buckets, ranked.length);
  const base = Math.floor(ranked.length / n);
  const extra = ranked.length % n;
  const out = [];
  let i = 0;
  for (let b = 0; b < n; b++) {
    const slice = ranked.slice(i, i + base + (b < extra ? 1 : 0));
    i += slice.length;
    out.push({
      rank_from: slice[0].rank_position,
      rank_to: slice[slice.length - 1].rank_position,
      ...yieldOf(slice, suspects),
    });
  }
  return out;
}

/** What the committed file would cost at full catalogue scale, measured rather
    than guessed: bytes per swept show from this run, times the pool. Reported
    so nobody has to discover the number by committing it. */
export function projectFootprint(bytes, showsMeasured, poolSize) {
  if (!showsMeasured) return null;
  const perShow = bytes / showsMeasured;
  return {
    bytes_per_show: Math.round(perShow),
    shows_remaining: poolSize,
    projected_bytes: Math.round(perShow * poolSize),
    projected_mb: Math.round((perShow * poolSize) / 1024 / 1024 * 10) / 10,
  };
}

/** The committed file describes its own size, from its own bytes. `footprint`
    is null on the first pass, because the number cannot exist until the object
    has been serialised once. */
export function policyString(footprint) {
  const perShow = footprint ? `${footprint.bytes_per_show} bytes/show (measured)` : "a few hundred bytes/show";
  return (
    "summary rows only — one row per SHOW, never per episode. Episode rows and transcript bodies " +
    "live in data-local/ (#255). At ~951 bytes/episode-row a full-catalogue episode index is GBs; " +
    `this shape is ${perShow}` +
    (footprint ? `, ~${footprint.projected_mb}MB across ${footprint.shows_remaining} feeds` : "") +
    ", and stays committable."
  );
}

/* -------------------------------------------------------------------- main */

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A path as this repository would name it: relative to the repo root, forward
    slashes on every platform. Falls back to what was passed when the file lives
    outside the tree, which is legitimate — `data-local/` is often a sibling
    checkout — but says so rather than emitting a drive letter. */
export function repoRelative(p) {
  const raw = String(p);
  const rel = relative(ROOT, resolvePath(process.cwd(), raw)).split(SEP).join("/");
  /* A DRIVE LETTER SURVIVING `relative()` MEANS "OUTSIDE", and testing for it is
     what makes this behave the same on both platforms. On POSIX a Windows
     absolute path is not absolute at all — `resolve()` reads `C:/x` as a
     directory literally named `C:` under the cwd, so `relative()` hands it back
     nearly unchanged, it does not begin with `../`, and the drive letter sails
     into the committed file. That is only reachable when a path recorded on
     Windows is re-rendered somewhere else, which is precisely the case this
     function exists for — and it is how the first version of it passed on the
     machine that wrote it and failed in CI. */
  const inside = rel && !rel.startsWith("../") && !/^[A-Za-z]:/.test(rel);
  if (inside) return rel;
  return raw
    .split(SEP)
    .filter((seg) => seg && !/^[A-Za-z]:$/.test(seg))
    .slice(-3)
    .join("/");
}

/** The tranche file carries `arm`; the swept index does not, because the sweep
    is generic and knows nothing about arms. Joined here on show_id rather than
    threaded through the sweep, so the sweep stays a tool that reads any
    catalogue.

    IT ALSO CARRIES RANK, AND RANK IS THE FILE'S ORDER RATHER THAN A FIELD IN IT.
    `rank-breadth.mjs` writes the exploit arm in descending expected yield and
    documents `rankShows` as a TOTAL order, so position N of the exploit rows is
    exactly "the Nth show we would have swept". Deriving it here rather than
    adding a column to the tranche file is what lets tranche 1 — already written,
    before anyone wanted this number — be bucketed by depth on the same rule as
    tranche 2. `rank_position` is null on the explore arm, which is not a
    ranking and must never be bucketed as one.

    `name` labels which tranche a row came from. Two tranches ranked on
    different priors are two different orderings, so depth may only be compared
    WITHIN a tranche; the label is what keeps `byRankBucket` from silently
    concatenating them into one axis that does not exist. */
export function attachArms(showRecords, tranche, { name = null } = {}) {
  const meta = new Map();
  let rank = 0;
  for (const s of tranche?.shows || []) {
    const exploit = s.arm === "exploit";
    if (exploit) rank++;
    meta.set(String(s.show_id), { arm: s.arm ?? null, rank_position: exploit ? rank : null });
  }
  return showRecords.map((s) => ({
    ...s,
    ...(meta.get(String(s.show_id)) || { arm: null, rank_position: null }),
    tranche: name,
  }));
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  /* COMMA-SEPARATED AND POSITIONALLY PAIRED, matching `rank-breadth.mjs`'s
     `--availability`. The committed yield file describes everything we have
     swept, and after tranche 2 that is two indexes; reporting one of them would
     either overwrite the other tranche's numbers or fork the file people quote
     into two files that disagree. The Nth `--breadth` index is joined to the
     Nth `--tranche` file, so the pairing is explicit rather than inferred from
     a filename. */
  const list = (flag, fallback) => String(get(flag, fallback)).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    breadth: list("--breadth", "data-local/breadth/availability-breadth.json"),
    tranche: list("--tranche", "data-local/breadth/tranche-01.json"),
    baseline: get("--baseline", "data/transcript-availability.json"),
    /* COMMA-SEPARATED, like `--breadth` above and for a sharper reason: there
       are several measurement files (see `measuredDispositions`) and quoting a
       subset of them would report a corpus number contradicted by evidence
       sitting in the repository beside it. The default is not a list written
       out here — it IS `MEASURED_REPORT_RELS`, so this file cannot fall behind
       the ledgers the way it did when the pair was typed in three places.
       Unlike the tranche pairing, a path that does not resolve is skipped
       rather than fatal — a checkout that has run no scan must still be able
       to produce a report. */
    measured: list("--measured", MEASURED_REPORT_RELS.join(",")),
    out: get("--out", null),
    poolSize: Number(get("--pool-size", "19436")),
  };
}

function line(label, y) {
  console.log(
    `  ${label.padEnd(10)} ${String(y.shows_swept).padStart(4)} swept  ` +
      `${String(y.shows_with_timed).padStart(4)} with timed (${String(y.shows_with_timed_pct).padStart(5)}%)  ` +
      `${String(y.timed_transcripts).padStart(7)} timed  ${String(y.timed_per_show_swept).padStart(7)}/feed  ` +
      `${String(y.anchorable_timed_transcripts).padStart(6)} anch  ${String(y.anchorable_per_show_swept).padStart(5)}/feed  ` +
      `${String(y.anchorable_net_of_suspects).padStart(6)} net  ${String(y.net_anchorable_per_show_swept).padStart(5)}/feed`,
  );
}

/** The label a row's `tranche` field carries: the tranche file's basename
    without its extension, so `data-local/breadth/tranche-02.json` reads as
    `tranche-02` wherever the file is kept. Falls back to the index's own name
    when a tranche file was not supplied, because an unlabelled row in a
    two-tranche report is worse than a slightly ugly label. */
export function trancheLabel(tranchePath, breadthPath) {
  const base = (p) => String(p).split(/[\\/]/).pop().replace(/\.json$/i, "");
  return tranchePath ? base(tranchePath) : base(breadthPath);
}

/** The `--breadth` / `--tranche` pairing, checked before a single file is read.

    THE SAME SILENT FAILURE THIS BRANCH MADE FATAL IN `rank-breadth.mjs`, and it
    was left standing here — in the tool that writes the number people quote.
    The arms are joined out of the tranche file, so a list that is short by one,
    or one entry of which does not resolve, gives 500 rows `arm: null`: they
    drop out of BOTH arm yields, stay in `breadth_all`, and vanish from the
    depth report, while every printed rate still looks like a rate. The trigger
    is not hypothetical — a shell mangling a comma-separated path list is
    exactly how the ranker was mis-fed on this branch.

    Passing NO `--tranche` at all stays legal: an index with no tranche file
    reports with a null arm on purpose, and that is separately tested. What is
    refused is a pairing that is present and wrong. */
export function checkTranchePairing(breadth, tranche, { exists = existsSync, resolve = (p) => p } = {}) {
  if (tranche.length && tranche.length !== breadth.length) {
    throw new Error(
      `--tranche has ${tranche.length} path(s) and --breadth has ${breadth.length}; they are paired positionally, ` +
        `and an unpaired index silently reports every one of its shows under a null arm`,
    );
  }
  const missing = tranche.filter((p) => !exists(resolve(p)));
  if (missing.length) {
    throw new Error(`tranche file not found: ${missing.join(", ")} — its shows would report under a null arm rather than in an arm`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = resolvePath(process.cwd(), args.baseline);
  checkTranchePairing(args.breadth, args.tranche, { resolve: (p) => resolvePath(process.cwd(), p) });

  const indexes = args.breadth.map((b, i) => {
    const breadthPath = resolvePath(process.cwd(), b);
    const tranchePath = args.tranche[i] ? resolvePath(process.cwd(), args.tranche[i]) : null;
    const breadth = readJson(breadthPath);
    const tranche = tranchePath ? readJson(tranchePath) : null;
    const name = trancheLabel(args.tranche[i] || null, b);
    return { name, breadth, rows: attachArms(breadth.shows || [], tranche, { name }).map(summaryRow) };
  });
  const rows = indexes.flatMap((x) => x.rows);
  const baselineRows = (readJson(baselinePath).shows || []).map(summaryRow);

  const exploit = rows.filter((r) => r.arm === "exploit");
  const explore = rows.filter((r) => r.arm === "explore");

  // The same contradiction check is applied to the BASELINE as well as to the
  // tranche. Comparing a net breadth number against a gross curated one would
  // manufacture the finding rather than measure it.
  /* Missing is tolerated here, unlike `rank-breadth.mjs`'s indexes: a repo that
     has not run the scan yet must still be able to produce a report, and the
     fallback is the strictly more conservative heuristic rather than a silently
     different denominator. Which side each row landed on is visible in its
     `reason`. */
  const measuredPaths = args.measured.filter((p) => existsSync(resolvePath(process.cwd(), p)));
  const measured = measuredDispositions(measuredPaths.map((p) => readJson(resolvePath(process.cwd(), p))));

  const suspects = suspectAnchorable(rows, { isDaiHost, measured });
  const baselineSuspects = suspectAnchorable(baselineRows, { isDaiHost, measured });

  console.log("yield per feed swept — the number the budget is denominated in\n");
  line("baseline", yieldOf(baselineRows, baselineSuspects));
  line("exploit", yieldOf(exploit, suspects));
  line("explore", yieldOf(explore, suspects));
  line("breadth", yieldOf(rows, suspects));

  console.log("\nyield by depth down the ranking — where the ordering stops paying:");
  for (const x of indexes) {
    const bucketsFor = byRankBucket(x.rows, suspects);
    if (!bucketsFor.length) continue;
    for (const b of bucketsFor) {
      console.log(
        `  ${x.name.padEnd(11)} ranks ${String(b.rank_from).padStart(4)}-${String(b.rank_to).padStart(4)}  ` +
          `${String(b.shows_with_timed).padStart(3)}/${String(b.shows_swept).padStart(3)} with timed  ` +
          `${String(b.timed_transcripts).padStart(7)} timed ${String(b.timed_per_show_swept).padStart(7)}/feed  ` +
          `${String(b.anchorable_net_of_suspects).padStart(5)} net ${String(b.net_anchorable_per_show_swept).padStart(5)}/feed`,
      );
    }
  }

  console.log("\nplatforms measured this tranche (top 15 by feeds swept):");
  for (const h of byHost(rows, suspects).slice(0, 15)) {
    console.log(
      `  ${h.host.padEnd(22)} ${String(h.shows_swept).padStart(3)} swept  ${String(h.shows_with_timed).padStart(3)} hit  ` +
        `${String(h.shows_with_timed_pct).padStart(5)}%  ${String(h.timed_transcripts).padStart(7)} timed  ${String(h.anchorable_timed_transcripts).padStart(5)} anchorable`,
    );
  }

  const net = anchorableNetOfSuspects(rows, suspects);
  const coverage = measurementCoverage(rows, suspects, measured);

  console.log(`\nwhat the ${net} anchorable transcripts REST ON — measured, or merely not recognised:`);
  for (const [k, label] of [
    ["measured_clean", "measured byte-stable"],
    ["measured_unresolved", "probed, could not settle"],
    ["inferred", "never probed (dai_reason unknown)"],
  ]) {
    console.log(
      `  ${String(coverage[k].timed_transcripts).padStart(6)} timed  ${String(coverage[k].shows).padStart(3)} show(s)  ${label}`,
    );
  }
  console.log(
    `  ${String(coverage.measured_pct_of_net).padStart(5)}% of the net corpus is measured; ` +
      `${coverage.excluded_measured_injecting.timed_transcripts} more were measured and dropped, ` +
      `${coverage.excluded_by_heuristic.timed_transcripts} dropped on a hostname nobody has measured`,
  );

  if (suspects.length) {
    console.log(`\ncounted anchorable, but the "not DAI" verdict is contradicted — measure before trusting:`);
    for (const f of suspects.slice(0, 12)) {
      console.log(`  ${String(f.timed_transcripts).padStart(5)}  ${f.reason.padEnd(27)} ${String(f.feed_host).padEnd(16)} -> ${String(f.enclosure_host).slice(0, 34)}`);
    }
    console.log(
      `  ${yieldOf(rows).anchorable_timed_transcripts} anchorable as classified; ` +
        `${net} survive both checks (${suspects.reduce((n, f) => n + f.timed_transcripts, 0)} suspect)`,
    );
  }

  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    policy: policyString(null),
    source: {
      /* RELATIVE, because these are committed. Absolute paths would put one
         machine's directory layout into a file everyone reads — the same
         objection `trancheLabel` is built around one screen up — and they
         would be wrong for every other checkout besides. */
      breadth_index: args.breadth.map(repoRelative),
      tranche: args.tranche.map(repoRelative),
      baseline: repoRelative(args.baseline),
      measured: measuredPaths.map(repoRelative),
      /* `swept_at` and `max_episode_rows` are NOT here, and their absence is
         the fix: they used to be scalars taken from the first index, sitting
         beside a `breadth_index` that is now a list of two swept on different
         days. A single date labelled "swept_at" next to two inputs reads as a
         property of the file. Per index, below, where it is true. */
      tranches: indexes.map((x) => ({
        name: x.name,
        shows: x.rows.length,
        swept_at: x.breadth.generated_at ?? null,
        max_episode_rows: x.breadth.max_episode_rows ?? null,
      })),
    },
    yield: {
      baseline_curated: yieldOf(baselineRows, baselineSuspects),
      breadth_exploit: yieldOf(exploit, suspects),
      breadth_explore: yieldOf(explore, suspects),
      breadth_all: yieldOf(rows, suspects),
    },
    by_host: byHost(rows, suspects),
    /* Per tranche, never pooled: see `attachArms`. Two tranches are two
       orderings, and a concatenated depth axis would read as one. */
    by_rank_bucket: indexes.map((x) => ({ tranche: x.name, buckets: byRankBucket(x.rows, suspects) })),
    suspect_anchorable: suspects,
    anchorable_net_of_suspects: net,
    /* WHAT THE HEADLINE NUMBER RESTS ON. See `measurementCoverage`: without it
       this file reports a five-figure corpus and cannot say whether one
       transcript of it was ever measured. */
    measurement_coverage: coverage,
    shows: rows.sort((a, b) => String(a.show_id).localeCompare(String(b.show_id))),
  };

  if (args.out) {
    const outPath = resolvePath(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    // Two passes: the policy string quotes the file's OWN measured
    // bytes-per-show, and that is only knowable once it has been serialised.
    // Serialising twice is cheaper than shipping a hardcoded number that drifts
    // from the file it describes — which is exactly how a "~200 bytes/show"
    // claim ended up in a file measuring 721.
    const footprint = projectFootprint(Buffer.byteLength(JSON.stringify(out, null, 2), "utf8"), rows.length, args.poolSize);
    out.policy = policyString(footprint);
    out.footprint = footprint;
    const body = JSON.stringify(out, null, 2) + "\n";
    writeFileSync(outPath, body);
    console.log(`\ncommitted summary: ${Math.round(Buffer.byteLength(body, "utf8") / 1024)} KB for ${rows.length} show(s)`);
    console.log(`  projected at full scale (${footprint.shows_remaining} feeds): ${footprint.projected_mb} MB in this shape`);
    console.log(`YIELD_COMPLETE: ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error("FATAL:", e.message);
    process.exit(1);
  }
}
