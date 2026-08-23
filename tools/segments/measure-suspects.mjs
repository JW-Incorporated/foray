#!/usr/bin/env node
/* Measure the breadth shows the yield report calls SUSPECT — do they inject?
   (follow-up to #316/#317.)

   WHY THIS EXISTS. `breadth-yield.mjs` prints two anchorable numbers: the
   optimistic one and the one net of shows whose "not DAI" verdict is
   contradicted by something we already know. On tranche 1 those two numbers are
   3,952 and 1,131 — 2,821 transcripts, 71% of the entire anchorable haul,
   sitting in SEVEN shows, dropped on a hostname heuristic.

   A heuristic decides what to SUSPECT. Only a measurement decides what is TRUE.
   #316 settled 27 curated shows this way — 2-byte ranged GETs, per-episode byte
   samples committed as evidence — and this is the same instrument pointed at the
   breadth suspects, for the same reason: 2,821 transcripts is too much supply to
   drop on a guess and far too much to admit on one.

   THE DENOMINATOR HAD TO BE FETCHED. `ad-inflation.mjs` measures
   `delivered bytes / feed-declared length`, and the swept breadth index kept no
   declared length at all — it read the `<enclosure>` tag and dropped the
   `length` attribute, so not one of the 500 swept shows was measurable. That is
   fixed at the source (`parseFeed` now keeps `enclosure_bytes`), but fixing it
   does not retro-fill an index swept before the fix, so this tool re-reads each
   suspect's feed: one polite request per show, seven in total, and the freshest
   possible declaration to measure against.

   NOTHING HERE REIMPLEMENTS THE MEASUREMENT. `probeEpisode`, `summariseShow`,
   the thresholds and the verdict vocabulary are all imported from
   `tools/transcribe/ad-inflation.mjs`; the feed fetch and its retry ladder come
   from `sweep-transcripts.mjs`; the host gate and every outbound identity come
   from `politeness.mjs`. This repo has paid four separate times for a policy
   that was copied instead of imported (#211/#219/#249, #313, #316, #318), and a
   scan whose threshold quietly disagreed with the scan it claims to reproduce
   would be the most expensive version of that mistake yet.

   Usage:
     node tools/segments/measure-suspects.mjs [--per-show N] [--dry-run]
                                              [--yield FILE] [--out FILE]
*/

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { probeEpisode, summariseShow, AD_FREE_FLOOR, AD_FREE_THRESHOLD } from "../transcribe/ad-inflation.mjs";
import { classifyShow, daiHostIn } from "../refresh/dai.mjs";
import { fetchFeed, parseFeed } from "./sweep-transcripts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Episodes worth spending a probe on: one we could actually anchor.

    A timed transcript is the whole reason this show is in the pool, and a
    declared length is the ratio's denominator. Probing an episode missing
    either spends a request on a row that could not answer the question even if
    it came back clean.

    NEWEST FIRST, which is the axis that matters here and not merely a default.
    Ad insertion is a live campaign setting: a show that switched it on last
    quarter is injected TODAY whatever its back catalogue says, and the back
    catalogue is what a feed's tail is. Measuring the oldest episodes of a
    newly-monetised show is the one sampling error that returns a confident
    "ad-free" for a show that is not. Feeds are already newest-first, so this is
    a `filter`, not a sort — but it is a deliberate one. */
export function probeTargets(episodes, perShow) {
  const out = [];
  for (const ep of episodes || []) {
    if (out.length >= perShow) break;
    if (!ep.enclosure_url) continue;
    if (!ep.has_timestamps) continue;
    if (!Number.isFinite(ep.enclosure_bytes) || ep.enclosure_bytes <= 0) continue;
    out.push(ep);
  }
  return out;
}

/** The byte gap expressed in SECONDS, at the episode's own implied bitrate.

    REPORTED BESIDE THE RATIO, NEVER INSTEAD OF IT, AND IT GATES NOTHING.
    Read ADR-0008 before touching this: it reversed a >1% sourcing gate, and a
    seconds threshold quietly applied here would re-impose that gate by the back
    door under a different unit. Nothing in this file branches on the number
    below; `verdict` comes from `summariseShow` and from nowhere else.

    It is here because ADR-0008 option 2 is right that **a ratio is not the
    quantity that hurts us**: anchor tolerance is absolute, so 1.02 on a
    78-minute episode is ~94 s and the same 1.02 on a 20-minute one is ~24 s.
    That matters concretely for this pool. `AD_FREE_THRESHOLD` justifies its 1%
    as "not even a 30-second pre-roll, which on a 40-minute episode is ~1.2%" —
    and these breadth episodes run 60 to 110 minutes, where 1% is 36 to 66 s.
    The threshold is duration-blind and these shows are where that shows up, so
    the operator gets the seconds and can judge.

    BITRATE-IMPLIED, which ADR-0008 calls a screen and not an instrument: it
    assumes CBR and takes `itunes:duration` as truth, and that ADR records
    Radiolab decoding 244 s away from its declared duration with no ads at all.
    Sizing a pad needs decode-and-compare over repeats of ONE episode. This is
    for reading a ratio, not for sizing anything. */
export function impliedDeltaSec(declaredBytes, deliveredBytes, durationSec) {
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) return null;
  if (!Number.isFinite(deliveredBytes) || deliveredBytes <= 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  return Math.round(((deliveredBytes - declaredBytes) * durationSec) / declaredBytes);
}

/** The WORST delta across the sampled episodes, not the median.

    Deliberately a different statistic from the verdict's. `summariseShow` takes
    a median because one odd episode should not reclassify a show; a displacement
    figure wants the opposite, because the episode that hurts is the worst one.

    THIS IS ADR-0008'S SCREEN, NOT ITS `delta_max`, and the difference is not
    pedantry. That ADR requires `N >= 2 probes of the SAME episode` to bound a
    pad, and says in as many words that a statistic taken across DIFFERENT
    episodes is "the wrong axis" — two probes of one Gastropod episode hours
    apart disagreed by 33.4 s, which is variance no cross-episode sample can
    see. What this returns is one probe each of five episodes: enough to sort a
    show into a tier, never enough to size a pad. Nothing may be admitted on it
    without the same-episode repeats. */
export function maxDeltaSec(samples) {
  const deltas = (samples || []).map((s) => s.delta_sec_implied).filter((d) => Number.isFinite(d));
  return deltas.length ? deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null;
}

/** ADR-0008's admission ceiling: a pad longer than this is not a pad.

    Imported in spirit from `ANCHOR_TIME_TOLERANCE_SEC` in `merge-segments.mjs`,
    which is where the ADR takes it from — quoted here rather than re-derived,
    and used for REPORTING only. */
export const PADDABLE_CEILING_SEC = 120;

/** Which ADR-0008 tier a show screens into — reported, never gated on.

    WHY THIS EXISTS AT ALL: without it the report says `dropped 2,807
    transcripts` and a founder reads 2,807 as gone. ADR-0008 says something much
    more specific. A show whose worst sampled delta is 30 s is PADDABLE — usable
    today with an extended stop — and one at 522 s is LOCATE-REQUIRED, which the
    ADR is explicit means "author now, play once the locate step exists", NOT
    discarded. Both are outside `isAnchorable`, which asks the narrower question
    of whether publisher timestamps anchor AS PUBLISHED with no pad; neither is
    outside the corpus.

    SCREENS, not decides. The tier below is computed from one probe each of five
    episodes; ADR-0008 requires N >= 2 probes of the same episode plus a margin
    at least as wide as the observed spread before anything is admitted on it.
    So a `paddable` row here means "worth spending the repeat probes on", and
    the ADR's arithmetic is what admits it. Re-imposing the sourcing gate this
    ADR reversed would look like gating on this value; do not. */
export function adrTier(maxDelta) {
  if (!Number.isFinite(maxDelta)) return null;
  return Math.abs(maxDelta) <= PADDABLE_CEILING_SEC ? "paddable-screened" : "locate-required";
}

/** Why a suspect can end with no verdict for a reason that is not the network.

    Named rather than left as a bare `unknown`, for the reason `ad-inflation.mjs`
    names its own: an unexplained "unknown" is indistinguishable from a failed
    fetch, and the two want opposite follow-ups. This one wants ADR-0008's
    decode-and-compare, because no number of retries will conjure a denominator
    a feed does not publish. */
export const NO_DECLARED_LENGTH_REASON =
  "no recent episode with a timed transcript declares an enclosure length, so the " +
  "ratio has no denominator; this show needs ADR-0008 decode-and-compare, not a retry";

/** A positive gap this large is an INSERT, not container noise.

    Measured, not chosen: across 35 probes the container/tag differences all
    landed between -3 s and 0 s, while the smallest positive gap was 24 s and
    the Spreaker gaps clustered on ~30 s multiples — 481,071 bytes turned up
    byte-for-byte identical on three DIFFERENT shows (The WWE Podcast, Baseball
    Prospectus, PWTorch VIP), on episodes of 30, 105 and 113 minutes. That is
    the same ad creative, not a rounding artefact. 10 s sits an order of
    magnitude above the noise and well under the smallest slot observed, so it
    separates the two populations with room on both sides.

    THIS IS NOT AN AD-VOLUME THRESHOLD AND MUST NOT BECOME ONE. ADR-0008
    reversed a >1% sourcing gate and says so in its status line. Nothing here
    rejects a show as a SOURCE: a 30-90 s delta is ADR-0008 PADDABLE and those
    shows stay authorable. What this decides is the narrower question the yield
    report actually asks — whether a publisher's timestamps anchor AS PUBLISHED,
    with no pad and no locate step. Catching a file mid-insert answers that
    question `no` at any volume. */
export const INSERT_EVIDENCE_SEC = 10;

/** Samples caught carrying an insert.

    THE SECONDS TEST IS STRICTER THAN THE RATIO ON A LONG EPISODE, deliberately.
    PWTorch VIP's 6,753-second episode took a byte-exact 481,071-byte insert —
    the same creative two other shows received — at ratio 1.004, comfortably
    inside `AD_FREE_THRESHOLD`'s 1% band. That is the duration-blindness
    ADR-0008 option 2 describes, and it is the whole reason this function counts
    seconds.

    THE RATIO IS STILL CONSULTED WHEN SECONDS ARE UNAVAILABLE, and that fallback
    is not decoration. `impliedDeltaSec` returns null without an
    `itunes:duration`, and a feed omitting that tag is common — so a
    seconds-only test would return 0 for a show whose every episode was
    inflated, and `dispositionOf` would call it recoverable. Verified against the
    real Baseball Prospectus numbers with the duration nulled: 339 transcripts
    from a show caught mid-insert flipped from `drop` to `recover`, with nothing
    on the row showing the evidence had been discarded. A missing metadata tag
    must not be able to disarm the check.

    What the fallback CANNOT see is the sub-1% insert that seconds would have
    caught — 30 s on a 113-minute episode. That gap is not papered over here; it
    is reported as `unmeasuredSamples` and it makes the show `unresolved`
    rather than clean. */
export function insertedSamples(samples) {
  return (samples || []).filter((s) => {
    if (Number.isFinite(s.delta_sec_implied)) return s.delta_sec_implied >= INSERT_EVIDENCE_SEC;
    return typeof s.ratio === "number" && s.ratio >= AD_FREE_THRESHOLD;
  }).length;
}

/** Samples whose ratio looked clean but which could not be checked in seconds.

    An episode with no declared duration and a ratio inside the band is the one
    case this scan genuinely cannot settle: the ratio is duration-blind, and the
    instrument that sees past it needs a duration this feed did not publish. It
    is not evidence of an insert and it is not evidence of the absence of one,
    so it is counted separately and it makes the show `unresolved`. Refusing to
    answer is free; admitting a show nobody could check is what costs. */
export function unmeasuredSamples(samples) {
  return (samples || []).filter(
    (s) => typeof s.ratio === "number" && !Number.isFinite(s.delta_sec_implied),
  ).length;
}

/** What a verdict means for the 2,821 transcripts behind it.

    Deliberately THREE outcomes and not two. `injected` and `ad-free` both
    settle a show; `unknown` settles nothing and must not be allowed to read as
    either. The whole failure this scan exists to prevent is a show admitted
    because nobody could tell.

    A MEDIAN RATIO ALONE WOULD HAVE ADMITTED 481 TRANSCRIPTS FROM SHOWS CAUGHT
    INSERTING, and that is measured rather than feared. All five Spreaker shows
    in this pool insert in discrete ~30 s slots on SOME episodes and not others,
    so `summariseShow`'s median is measuring how many of our five samples
    happened to draw a filled slot. Baseball Prospectus and PWTorch VIP each
    came back `ad-free` while each had an episode carrying the same
    481,071-byte creative that got The WWE Podcast classified `injected`;
    Sasquatch Experience came back `ad-free` with THREE episodes carrying a
    different creative of the same duration (420,937 / 422,034 bytes at its
    lower 112 kbps — 30 s either way). Same platform, same mechanism, opposite
    verdicts, decided by sampling luck.

    So a single episode caught carrying an insert condemns the show, whatever
    the median says. One positive observation of the mechanism running outranks
    an average over draws that mostly missed it.

    UNDER-SIZE CONDEMNS TOO, and it lands in `unresolved` rather than `drop`.
    `ad-inflation.mjs`'s `AD_FREE_FLOOR` docstring is explicit that delivered
    bytes falling short of the declared length "disqualifies a transcript for
    exactly the reason injection does: the publisher's timeline was authored
    against a copy we are not receiving" — but it is not evidence of ads, so
    calling it `drop` would overstate what was seen. `UNDERSIZED_REASON` calls
    the honest verdict "a refusal to answer", and that is `unresolved`. Nothing
    in the committed evidence trips this (all 35 samples are >= 0.99); it is
    here because the number was already being computed and thrown away.

    THE REDIRECT CHAIN IS RECORDED BESIDE THIS AND DELIBERATELY DOES NOT BRANCH.
    It is tempting to drop every show on a DAI platform outright, and it would
    give the same answer for all seven shows here — but it would contradict
    `AD_FREE_SHOWS`, every one of which is a DAI-platform show admitted on
    exactly this evidence (#316: Being an Engineer is on Buzzsprout, which is on
    the host list, and earned its place with 41 of 41 episodes at ratio 1.0000).
    Being able to inject is not injecting; that distinction is the whole reason
    `ad_inflation` sits beside `dai` rather than replacing it. The chain says
    where to look. The bytes say what is happening. */
export function dispositionOf(verdict, { inserted = 0, undersized = 0, unmeasured = 0 } = {}) {
  if (verdict === "unknown") return "unresolved";
  if (verdict === "injected") return "drop";
  if (inserted > 0) return "drop";
  if (undersized > 0 || unmeasured > 0) return "unresolved";
  return "recover";
}

/** The report's headline arithmetic, computed rather than narrated.

    `gross` is what the tranche called anchorable before any suspicion; `net` is
    what survived the heuristic. This returns where the measurement lands
    between them, and it refuses to count an `unknown` as a recovery — an
    unresolved show stays out, which is the same conservative direction
    `isAnchorable` already takes for `dai_suspected === null`. */
export function recount(results, { gross, net }) {
  const sum = (d) => results.filter((r) => r.disposition === d)
    .reduce((n, r) => n + (r.timed_transcripts || 0), 0);
  const recovered = sum("recover");
  const tier = (t) => results.filter((r) => r.tier === t).reduce((n, r) => n + (r.timed_transcripts || 0), 0);
  return {
    anchorable_before: net,
    anchorable_gross_before: gross,
    recovered,
    not_anchorable_as_published: sum("drop"),
    still_unresolved: sum("unresolved"),
    anchorable_after: net + recovered,
    /* Reported beside the headline so "not anchorable as published" is never
       read as "gone". ADR-0008 keeps both tiers in the corpus: paddable plays
       today with an extended stop, locate-required is authored now and plays
       once the locate step exists. These overlap the counts above by design —
       they slice the same shows a different way. */
    adr0008: {
      paddable_screened: tier("paddable-screened"),
      locate_required: tier("locate-required"),
      note:
        "screened from one probe each of five episodes; ADR-0008 needs N>=2 probes of the " +
        "SAME episode plus a margin before a pad may be sized or a show admitted on one",
    },
  };
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    /* Same guard as `ad-inflation.mjs`: NaN would select zero targets and
       rewrite every verdict as "could not tell" without a single request. */
    perShow: (() => {
      const raw = get("--per-show", 5);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--per-show must be a positive integer, got ${raw}`);
      return n;
    })(),
    yieldPath: get("--yield", "data/breadth-transcript-yield.json"),
    out: get("--out", "data/breadth-suspect-inflation.json"),
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(resolvePath(process.cwd(), args.yieldPath), "utf8"));
  const suspects = report.suspect_anchorable || [];
  const feedById = new Map((report.shows || []).map((s) => [String(s.show_id), s.feed_url]));

  const gross = report.yield?.breadth_all?.anchorable_timed_transcripts ?? null;
  const net = report.anchorable_net_of_suspects ?? null;

  console.log(
    `${suspects.length} suspect show(s), ${suspects.reduce((n, s) => n + s.timed_transcripts, 0)} timed transcripts ` +
      `(${gross} anchorable as classified, ${net} net)\n`,
  );

  const started = Date.now();
  let requests = 0;
  let feedRequests = 0;
  const results = [];

  for (const s of suspects) {
    const feedUrl = feedById.get(String(s.show_id));
    const samples = [];
    let note = null;

    let episodes = [];
    if (!feedUrl) {
      note = "no feed_url in the yield report for this show_id";
    } else {
      try {
        feedRequests++;
        episodes = parseFeed(await fetchFeed(feedUrl)).episodes;
      } catch (e) {
        note = `feed unreadable: ${e.message}`;
      }
    }

    const probed = probeTargets(episodes, args.perShow);
    for (const ep of probed) {
      const p = await probeEpisode(ep.enclosure_url, ep.enclosure_bytes);
      requests += p.attempts;
      samples.push({
        guid: ep.guid ?? null,
        episode: String(ep.title || "").slice(0, 90),
        declared_bytes: p.declared_bytes,
        delivered_bytes: p.delivered_bytes,
        duration_sec: Number.isFinite(ep.duration_sec) ? ep.duration_sec : null,
        ratio: p.ratio == null ? null : Math.round(p.ratio * 1000) / 1000,
        delta_sec_implied: impliedDeltaSec(p.declared_bytes, p.delivered_bytes, ep.duration_sec),
        ...(p.error ? { error: p.error, status: p.status } : {}),
      });
    }

    /* The chain, once per show, on an episode we actually probed. Corroboration
       rather than a second verdict — see `dispositionOf`. It costs one hop per
       redirect and it is the evidence that makes a `dai_suspected` row
       re-judgeable later without another sweep. */
    let chain = null;
    if (samples.length) {
      const c = await classifyShow(probed[0].enclosure_url);
      requests += (c.resolved_chain || []).length;
      chain = { dai: c.dai, via: daiHostIn(c.resolved_chain || []), hosts: c.resolved_chain || [] };
    }

    const summary = summariseShow(samples.map((x) => x.ratio));
    if (!note && samples.length === 0) note = NO_DECLARED_LENGTH_REASON;
    const undersized = samples.filter((x) => typeof x.ratio === "number" && x.ratio < AD_FREE_FLOOR).length;
    const inserted = insertedSamples(samples);
    const unmeasured = unmeasuredSamples(samples);
    const disposition = dispositionOf(summary.verdict, { inserted, undersized, unmeasured });
    const worst = maxDeltaSec(samples);

    results.push({
      show_id: s.show_id,
      title: s.title,
      feed_host: s.feed_host,
      enclosure_host: s.enclosure_host,
      suspect_reason: s.reason,
      timed_transcripts: s.timed_transcripts,
      verdict: summary.verdict,
      disposition,
      median: summary.median,
      n: summary.n,
      inserted_samples: inserted,
      ...(unmeasured > 0 ? { unmeasured_samples: unmeasured } : {}),
      max_delta_sec_implied: worst,
      tier: adrTier(worst),
      dai_by_chain: chain ? chain.dai : null,
      dai_via: chain ? chain.via : null,
      resolved_chain: chain ? chain.hosts : [],
      ...(undersized > 0 ? { undersized_samples: undersized } : {}),
      ...(note ? { note } : summary.reason ? { note: summary.reason } : {}),
      samples,
    });

    const med = summary.median == null ? "  -  " : summary.median.toFixed(3);
    console.log(
      `  ${disposition.padEnd(10)} ${summary.verdict.padEnd(8)} ${med}  ` +
        `${inserted}/${samples.length} ins  worst ${String(worst == null ? "-" : `${worst}s`).padStart(5)}  ` +
        `${String(adrTier(worst) || "-").padEnd(17)} ` +
        `${chain && chain.dai ? `DAI:${chain.via}` : "chain clean"}`.padEnd(24) +
        `  ${String(s.timed_transcripts).padStart(4)} timed  ${s.title.slice(0, 30)}`,
    );
  }

  const counts = recount(results, { gross, net });
  const elapsedMin = (Date.now() - started) / 60000;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`requests: ${feedRequests} feed + ${requests} ranged GET over ${elapsedMin.toFixed(1)} min`);
  console.log(`  recovered   ${String(counts.recovered).padStart(5)} timed transcripts (measured byte-stable)`);
  console.log(`  not as pub. ${String(counts.not_anchorable_as_published).padStart(5)} timed transcripts (caught injecting)`);
  console.log(`  unresolved  ${String(counts.still_unresolved).padStart(5)} timed transcripts (could not tell)`);
  console.log(`anchorable as published: ${counts.anchorable_before} -> ${counts.anchorable_after}`);
  /* Said out loud, because "not anchorable as published" is not "gone" and the
     difference is 818 transcripts. */
  console.log(
    `ADR-0008 screen: ${counts.adr0008.paddable_screened} paddable, ` +
      `${counts.adr0008.locate_required} locate-required (authored now, played after the locate step)`,
  );

  const out = {
    version: 1,
    measured_at: new Date().toISOString(),
    method: "2-byte ranged GET; tools/transcribe/ad-inflation.mjs via tools/segments/measure-suspects.mjs",
    source: { yield_report: args.yieldPath, per_show: args.perShow },
    requests: { feeds: feedRequests, ranged_gets: requests },
    counts,
    results,
  };

  if (args.dryRun) {
    console.log("\n--dry-run: no files written.");
    return;
  }
  const outPath = resolvePath(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`SUSPECTS_MEASURED: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
