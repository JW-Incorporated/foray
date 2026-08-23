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
import { dirname, join, resolve as resolvePath } from "node:path";
import { isDaiHost } from "../refresh/dai.mjs";
import { hostKeyOf } from "./rank-breadth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shows flagged DAI whose delivered audio was MEASURED byte-identical, so
    their publisher timestamps still anchor. Mirrors `AD_FREE_SHOWS` in
    `fetch-transcripts.mjs`, which is the file that acts on it; restated here
    because this file only reads and must not import a fetcher to do arithmetic.
    If one moves, move both — `breadth-yield.test.mjs` pins that they agree. */
export const MEASURED_AD_FREE = ["Being an Engineer", "Geology Bites", "Practical AI"];

/* KEYED ON TITLE, which is a known weakness rather than an oversight. Titles are
   unique enough across 220 curated shows; across 19,436 breadth feeds they are
   not, so a breadth show that happens to share a name with one of these three
   would be silently exempted from both the anchorable test and the suspect
   check. The fetcher's `AD_FREE_SHOWS` has the same shape and the same exposure,
   which is why this mirrors it rather than quietly diverging — a stricter key
   here would make the two files disagree about the corpus, which is the failure
   they are written to avoid. The fix is to re-key BOTH on `show_id` when
   `tools/transcribe/ad-inflation.mjs` next writes to that list, not to fork it
   here. Measured today: no breadth title in tranche 1 collides. */

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
  return show.dai_suspected === true && MEASURED_AD_FREE.includes(show.title);
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

/** Anchorable shows whose "not DAI" verdict is contradicted by something we
    already know. Each entry carries WHY, because the two reasons want different
    follow-ups: `dai-host-lost-in-redirect` is a fix to `dai.mjs` (match the feed
    host too, not only the resolved one), while `ad-tech-origin` is a host to add
    to that list once someone measures it with `tools/transcribe/ad-inflation.mjs`.

    `isDaiHost` is injected rather than imported at the call site so the suite can
    exercise both reasons without depending on the contents of a data file that
    is expected to change. */
export function suspectAnchorable(rows, { isDaiHost = () => false, hostOfFeed = hostKeyOf } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r.anchorable) continue;
    // A MEASUREMENT OUTRANKS THIS HEURISTIC, and skipping that check was a real
    // bug: run against the curated baseline, the feed-host rule flagged Being an
    // Engineer, Geology Bites and Practical AI — which are `AD_FREE_SHOWS`,
    // i.e. the three shows someone actually measured delivering byte-identical
    // audio. It would have cut the curated baseline from 587 anchorable
    // transcripts to 67 and made every breadth-vs-curated comparison in the
    // report meaningless, in the flattering direction.
    if (MEASURED_AD_FREE.includes(r.title)) continue;
    const origin = String(r.enclosure_host || "").toLowerCase();
    let reason = null;
    if (isDaiHost(hostOfFeed(r.feed_url))) reason = "dai-host-lost-in-redirect";
    else if (origin && AD_TECH_HOST_MARKERS.some((m) => origin.includes(m))) reason = "ad-tech-origin";
    if (!reason) continue;
    out.push({
      show_id: r.show_id,
      title: r.title,
      feed_host: hostOfFeed(r.feed_url),
      enclosure_host: r.enclosure_host,
      reason,
      timed_transcripts: r.episodes_with_timed_transcript,
    });
  }
  return out.sort((a, b) => b.timed_transcripts - a.timed_transcripts);
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
    status: show.status,
    error_code: show.error_code ?? null,
    dai_suspected: show.dai_suspected ?? null,
    enclosure_host: show.enclosure_host ?? null,
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

/** The tranche file carries `arm`; the swept index does not, because the sweep
    is generic and knows nothing about arms. Joined here on show_id rather than
    threaded through the sweep, so the sweep stays a tool that reads any
    catalogue. */
export function attachArms(showRecords, tranche) {
  const arms = new Map((tranche?.shows || []).map((s) => [String(s.show_id), s.arm]));
  return showRecords.map((s) => ({ ...s, arm: arms.get(String(s.show_id)) ?? null }));
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    breadth: get("--breadth", "data-local/breadth/availability-breadth.json"),
    tranche: get("--tranche", "data-local/breadth/tranche-01.json"),
    baseline: get("--baseline", "data/transcript-availability.json"),
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const breadthPath = resolvePath(process.cwd(), args.breadth);
  const baselinePath = resolvePath(process.cwd(), args.baseline);
  const tranchePath = resolvePath(process.cwd(), args.tranche);

  const breadth = readJson(breadthPath);
  const tranche = existsSync(tranchePath) ? readJson(tranchePath) : null;
  const rows = attachArms(breadth.shows || [], tranche).map(summaryRow);
  const baselineRows = (readJson(baselinePath).shows || []).map(summaryRow);

  const exploit = rows.filter((r) => r.arm === "exploit");
  const explore = rows.filter((r) => r.arm === "explore");

  // The same contradiction check is applied to the BASELINE as well as to the
  // tranche. Comparing a net breadth number against a gross curated one would
  // manufacture the finding rather than measure it.
  const suspects = suspectAnchorable(rows, { isDaiHost });
  const baselineSuspects = suspectAnchorable(baselineRows, { isDaiHost });

  console.log("yield per feed swept — the number the budget is denominated in\n");
  line("baseline", yieldOf(baselineRows, baselineSuspects));
  line("exploit", yieldOf(exploit, suspects));
  line("explore", yieldOf(explore, suspects));
  line("breadth", yieldOf(rows, suspects));

  console.log("\nplatforms measured this tranche (top 15 by feeds swept):");
  for (const h of byHost(rows, suspects).slice(0, 15)) {
    console.log(
      `  ${h.host.padEnd(22)} ${String(h.shows_swept).padStart(3)} swept  ${String(h.shows_with_timed).padStart(3)} hit  ` +
        `${String(h.shows_with_timed_pct).padStart(5)}%  ${String(h.timed_transcripts).padStart(7)} timed  ${String(h.anchorable_timed_transcripts).padStart(5)} anchorable`,
    );
  }

  const net = anchorableNetOfSuspects(rows, suspects);
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
      breadth_index: args.breadth,
      tranche: args.tranche,
      baseline: args.baseline,
      swept_at: breadth.generated_at ?? null,
      max_episode_rows: breadth.max_episode_rows ?? null,
    },
    yield: {
      baseline_curated: yieldOf(baselineRows, baselineSuspects),
      breadth_exploit: yieldOf(exploit, suspects),
      breadth_explore: yieldOf(explore, suspects),
      breadth_all: yieldOf(rows, suspects),
    },
    by_host: byHost(rows, suspects),
    suspect_anchorable: suspects,
    anchorable_net_of_suspects: net,
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
