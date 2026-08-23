/* Breadth prioritisation — which of the 19,436 uncurated feeds to sweep first
   (issue #114, epic #102). STATIC, keyless, no LLM, no dependencies, no network.

   WHY THIS EXISTS. `sweep-transcripts.mjs` will read any catalogue you hand it,
   and #313 handed it the 220 curated shows. The breadth catalogue is 89x that,
   and an alphabetical or as-harvested pass through it is the worst possible use
   of a request budget that is capped by politeness rather than by time. This
   file decides the order, and it does it from measurements already paid for
   rather than from taste.

   THE SIGNAL THAT ACTUALLY PREDICTS, AND IT IS NOT GENRE. A
   `<podcast:transcript>` tag is emitted by the hosting PLATFORM, not written by
   the host of the show. Buzzsprout and Omny generate transcripts as a product
   feature; Megaphone, Simplecast, Art19 and Acast, as of the 219 feeds we have
   actually read, do not put them in the RSS at all. Measured on that baseline:

     omnycontent.com   10 of 12 shows carry timed transcripts   82.3% of episodes
     captivate.fm       1 of 2                                  27.2%
     buzzsprout.com     3 of 8                                  19.9%
     transistor.fm      3 of 4                                   8.9%
     anchor.fm          1 of 7                                   9.6%
     libsyn.com         3 of 29                                  0.3%
     megaphone.fm       0 of 32                                  0.0%
     simplecast.com     0 of 31                                  0.0%
     art19.com          0 of 13                                  0.0%
     acast.com          0 of 11                                  0.0%

   Those four zero hosts are 87 swept shows with not one timed transcript
   between them, and they are 26% of the breadth catalogue. Genre, by contrast,
   is close to noise here: `data/breadth-classification.json` files Odd Lots
   under `sports/soccer` and 5-4 under `engineering/ai-robotics`, so a
   topic-weighted ranking would be ranking on a classifier's mistakes. Genre is
   used only as a tiebreak, and `TOPIC_WEIGHT` defaults to 0 for that reason.

   THE PRIORS ARE LEARNED, NOT LISTED. The table above is illustrative; nothing
   in this file hardcodes it. `hostPriors()` recomputes it from whatever
   availability indexes it is given, so the second breadth tranche is ranked on
   what the first one measured. A hardcoded table would be a third copy of a
   fact that already lives in `data/transcript-availability.json`.

   And it worked, which is the point of writing it down. Tranche 1 read 500
   breadth feeds and the priors moved a long way on every platform it touched:

     platform          prior (curated)      measured (tranche 1)
     omnycontent.com   10 of 12  (83%)      38 of 42   (90.5%)
     redcircle.com      1 of 1              31 of 43   (72.1%)
     buzzsprout.com     3 of 8   (38%)      32 of 56   (57.1%)
     transistor.fm      3 of 4   (75%)      10 of 23   (43.5%)
     captivate.fm       1 of 2               8 of 24   (33.3%)
     anchor.fm          1 of 7   (14%)       7 of 87    (8.2%)
     megaphone/simplecast/art19/acast        0 of 50    (0.0%)

   redcircle is the entry that justifies the shrinkage: the prior was a single
   lucky show, the ranking correctly refused to lead with it, and 43 swept feeds
   later it is a genuine 72% platform. The four zero hosts stayed at zero across
   50 more feeds — 137 swept shows now, not one timed transcript.

   SHRINKAGE IS LOAD-BEARING, NOT STATISTICAL DECORATION. `redcircle.com`
   scores 1 hit from 1 swept show. Unsmoothed that is a 100% host, ranked above
   omny's 10-from-12, and the whole tranche would then chase a sample of one.
   Every rate here is shrunk toward the global rate by a pseudo-count in SHOWS
   (`SHOW_PRIOR_STRENGTH`), so a host earns its rank by sample size as well as
   by rate. `rankShows` is a pure function of its inputs so this is testable
   without a network.

   WHY THE TRANCHE IS TWO ARMS AND NOT ONE. The question this sweep has to
   answer is "are the remaining ~19,000 shows worth the requests?", and a purely
   greedy tranche cannot answer it: it measures the shows we predicted would
   win, so its yield is an upper bound on breadth and a biased estimate of the
   population. `stratifiedTranche()` therefore emits an EXPLOIT arm (the ranked
   head, which is what #114 asks for) and an EXPLORE arm (a uniform random
   sample of everything the head did NOT take, which is the estimator). Both are
   labelled in the output with `arm`, so `breadth-yield.mjs` can report them
   separately and neither number can be quoted as the other. The sampling is
   seeded, so a killed run resumes onto the same tranche rather than a fresh one.

   Stated honestly, the explore arm is uniform over the pool MINUS the exploit
   head, not over the pool: it is the top-scoring 300 of 19,373 that are removed,
   so the estimate is biased slightly DOWNWARD, by about 1.5% of the pool. That
   is the right direction for a number used to justify spending requests, and it
   is the price of keeping the arms disjoint — an overlapping explore arm would
   be contaminated with the shows we hand-picked as winners, which is a much
   larger error in the flattering direction.

   NEVER FETCHES ANYTHING. This file reads JSON and writes JSON. The politeness
   budget belongs to `sweep-transcripts.mjs`; a ranker that made requests would
   be a second, unthrottled network path into the same hosts.

   Usage:
     node tools/segments/rank-breadth.mjs --exploit 300 --explore 200 \
       --out data-local/breadth/tranche-01.json
     node tools/segments/rank-breadth.mjs --report        # priors, no output file
*/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Pseudo-observations, denominated in SHOWS, pulling a host's hit-rate toward
    the global rate. 5 means a host needs roughly five swept shows before its
    own rate outweighs the population's — which is what stops a 1-of-1 host from
    leading the tranche. */
export const SHOW_PRIOR_STRENGTH = 5;
/** The same idea for "given this host transcribes at all, what fraction of an
    average show's episodes are timed?". Weaker, because that quantity varies
    less between hosts than the yes/no does. */
export const RATE_PRIOR_STRENGTH = 2;
/** Genre contributes nothing by default — see the header. Kept as a parameter
    rather than deleted so that a later tranche, with enough swept shows to
    measure genre honestly, can turn it on without a code change. */
export const TOPIC_WEIGHT = 0;

/* ------------------------------------------------------------------- hosts */

/** The registrable-ish host: `feeds.buzzsprout.com` and `rss.buzzsprout.com`
    are one platform and must share one prior, or every platform's evidence is
    split across its subdomains and every host looks like a sample of one.

    Deliberately naive (last two labels) rather than a public-suffix list: PSL
    is a dependency, `tools/` has none, and the two-label rule is wrong only for
    multi-part suffixes like `.co.uk`, where it over-merges into one bucket.
    Over-merging is the safe direction — it pools evidence rather than
    inventing it — and `co.uk` is 0.5% of the catalogue. */
export function hostKeyOf(feedUrl) {
  let host;
  try {
    host = new URL(String(feedUrl)).host.toLowerCase();
  } catch {
    return "unknown";
  }
  if (!host) return "unknown";
  const labels = host.replace(/^www\./, "").split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : labels.join(".");
}

/* ------------------------------------------------------------------ priors */

/** Rolls one or more availability indexes into per-host evidence.

    `shows` counts every show we successfully read a feed for; a show whose feed
    404'd is evidence about that URL, not about the platform, so failures are
    excluded rather than counted as misses. Counting them as misses would make
    every host with dead feeds look like it does not transcribe. */
export function hostPriors(availabilities) {
  const list = Array.isArray(availabilities) ? availabilities : [availabilities];
  const hosts = new Map();
  let shows = 0, hits = 0, hitRateSum = 0;

  for (const av of list) {
    for (const s of av?.shows || []) {
      if (s.status !== "ok") continue;
      const key = hostKeyOf(s.feed_url);
      const h = hosts.get(key) || { host: key, shows: 0, shows_with_timed: 0, episodes: 0, timed: 0, rate_sum: 0 };
      h.shows++;
      h.episodes += s.episodes_total || 0;
      h.timed += s.episodes_with_timed_transcript || 0;
      shows++;
      if ((s.episodes_with_timed_transcript || 0) > 0) {
        h.shows_with_timed++;
        hits++;
        // Within-show timed fraction, averaged over HITTING shows only. A show
        // with 3 transcribed episodes out of 900 and one with 900 out of 900
        // are both hits, and only this separates them.
        const r = s.episodes_total ? s.episodes_with_timed_transcript / s.episodes_total : 0;
        h.rate_sum += r;
        hitRateSum += r;
      }
      hosts.set(key, h);
    }
  }

  const global_hit_rate = shows ? hits / shows : 0;
  const global_timed_fraction = hits ? hitRateSum / hits : 0;
  return { shows, hits, global_hit_rate, global_timed_fraction, hosts };
}

/** A host's shrunk probability that a show on it publishes ANY timed
    transcript. Unknown hosts return the global rate exactly, which is the
    honest answer for a platform we have never read. */
export function hostHitRate(priors, hostKey, { strength = SHOW_PRIOR_STRENGTH } = {}) {
  const h = priors.hosts.get(hostKey);
  const n = h ? h.shows : 0;
  const k = h ? h.shows_with_timed : 0;
  return (k + strength * priors.global_hit_rate) / (n + strength);
}

/** Given that a show on this host transcribes, the shrunk expected fraction of
    its episodes that carry a TIMED transcript. Shrunk over hitting shows, so a
    host with one lucky hit does not carry that hit's fraction at full weight. */
export function hostTimedFraction(priors, hostKey, { strength = RATE_PRIOR_STRENGTH } = {}) {
  const h = priors.hosts.get(hostKey);
  const n = h ? h.shows_with_timed : 0;
  const sum = h ? h.rate_sum : 0;
  return (sum + strength * priors.global_timed_fraction) / (n + strength);
}

/* ------------------------------------------------------------------ scoring */

/** Apple's advertised `episode_count` is a claim, not a measurement, and a
    handful of rows carry absurd values. Clamped rather than trusted: the score
    only needs a magnitude, and the feed is the truth once we read it. */
export function usableEpisodeCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(v, 5000);
}

/** Expected TIMED transcripts from spending one feed request on this show.
    That is the unit the budget is actually denominated in, which is why the
    score is an expected count and not a 0-1 "quality".

    `expected_anchorable` is the same number after the DAI haircut, and it is
    reported rather than ranked on. Ranking on it would be a bet that the
    ad-inflation scan never reclassifies anything, and `AD_FREE_SHOWS` is three
    counterexamples to that bet already: DAI-flagged shows measured delivering
    byte-identical audio. Timed transcripts on a DAI show are unmeasured, not
    worthless. */
export function scoreShow(show, priors, { topicWeight = TOPIC_WEIGHT, topicRates = null, daiRates = null } = {}) {
  const hostKey = hostKeyOf(show.feed_url);
  const p = hostHitRate(priors, hostKey);
  const frac = hostTimedFraction(priors, hostKey);
  const episodes = usableEpisodeCount(show.episode_count);
  let expected = p * frac * episodes;

  // Tiebreak only, and off by default. A rank multiplier rather than an added
  // term so it cannot promote a show whose host expectation is zero.
  if (topicWeight > 0 && topicRates) {
    const topics = topicRates.get(String(show.apple_collection_id)) || [];
    const lift = topics.length ? topics.reduce((a, b) => a + b, 0) / topics.length : 1;
    expected *= 1 + topicWeight * (lift - 1);
  }

  const nonDai = daiRates ? daiRates.nonDaiRate(hostKey) : null;
  return {
    host_key: hostKey,
    host_hit_rate: round(p, 4),
    host_timed_fraction: round(frac, 4),
    episode_count: episodes,
    expected_timed: round(expected, 2),
    expected_anchorable: nonDai == null ? null : round(expected * nonDai, 2),
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Per-host P(not DAI), shrunk the same way. Built from whatever swept indexes
    carry a `dai_suspected` verdict. Null-safe: a host we have never resolved
    returns the global rate. */
export function daiRatesFrom(availabilities, { strength = SHOW_PRIOR_STRENGTH } = {}) {
  const list = Array.isArray(availabilities) ? availabilities : [availabilities];
  const hosts = new Map();
  let n = 0, nonDai = 0;
  for (const av of list) {
    for (const s of av?.shows || []) {
      if (s.status !== "ok" || s.dai_suspected == null) continue;
      const key = hostKeyOf(s.feed_url);
      const h = hosts.get(key) || { n: 0, nonDai: 0 };
      h.n++;
      n++;
      if (s.dai_suspected === false) {
        h.nonDai++;
        nonDai++;
      }
      hosts.set(key, h);
    }
  }
  const global = n ? nonDai / n : 0;
  return {
    global,
    hosts,
    nonDaiRate(hostKey) {
      const h = hosts.get(hostKey);
      return ((h ? h.nonDai : 0) + strength * global) / ((h ? h.n : 0) + strength);
    },
  };
}

/* ------------------------------------------------------------- eligibility */

/** The pool this tranche may draw from: uncurated, has a feed, and is not a
    feed we have already swept. Deduped on the feed URL rather than the Apple
    id, because 187 breadth rows are the same feed charting in two genres and
    sweeping a feed twice is a wasted request, not a second sample.

    `alreadySweptFeeds` is what makes a second tranche cheap: it is every feed
    URL any prior index recorded, so re-running the ranker after a sweep
    produces the NEXT 300 shows rather than the same 300. */
export function eligibleShows(breadthShows, { alreadySweptFeeds = new Set() } = {}) {
  const seen = new Set();
  const out = [];
  for (const s of breadthShows || []) {
    if (!s.feed_url || s.in_curated) continue;
    const key = String(s.feed_url).trim().toLowerCase();
    if (!key || seen.has(key) || alreadySweptFeeds.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Every feed URL an index has already recorded a verdict for, lowercased to
    match `eligibleShows`. Errors are included on purpose: a feed that timed out
    three times is not a feed to spend three more requests on next tranche. */
export function sweptFeedUrls(availabilities) {
  const list = Array.isArray(availabilities) ? availabilities : [availabilities];
  const out = new Set();
  for (const av of list) {
    for (const s of av?.shows || []) {
      if (s.feed_url) out.add(String(s.feed_url).trim().toLowerCase());
    }
  }
  return out;
}

/* -------------------------------------------------------------- the tranche */

/** Hashes a seed string to a 32-bit state (xmur3).

    THIS IS NOT INTERCHANGEABLE WITH A SIMPLER HASH, AND THE FIRST VERSION HERE
    WAS WRONG. It started as `a = (a + charCode * 2654435761) >>> 0`, which is
    additive: seeds differing only in their last character land on states a
    fixed distance apart, and mulberry32's FIRST output from nearby states is
    correlated. Measured over 4,000 seeds of the form `seed-N`, the first draw
    fell into ten equal buckets 30/261/233/397/498/288/551/610/538/594 times
    against an expected 400 — a 20x spread between the emptiest and fullest
    bucket, in the exact draws that pick a sample's first elements.

    The stream itself was never the problem: partial Fisher-Yates run off one
    continuous stream measured 1477-1542 per bucket against 1500. So the whole
    defect lived in six characters of seed hashing, produced perfectly
    plausible-looking samples, and would have been invisible without the
    distribution test. Avalanche (xor-shift + multiply, twice) is what makes
    adjacent seeds land in unrelated places. */
export function seedState(seed) {
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Seeded PRNG (mulberry32). `Math.random` would make the explore arm
    unreproducible, so a killed run would resume onto a DIFFERENT random sample
    and the two halves could not be pooled into one estimate. */
export function rng(seed) {
  let a = seedState(seed);
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ranked, best expected yield first. Ties break on episode_count then Apple id
    so the order is total and the same inputs always give the same file. */
export function rankShows(shows, priors, opts = {}) {
  return shows
    .map((s) => ({ show: s, score: scoreShow(s, priors, opts) }))
    .sort(
      (a, b) =>
        b.score.expected_timed - a.score.expected_timed ||
        b.score.episode_count - a.score.episode_count ||
        String(a.show.apple_collection_id).localeCompare(String(b.show.apple_collection_id)),
    );
}

/** The exploit head, subject to a per-platform cap.

    `hostCap` defaults to Infinity HERE and to 40 at the CLI, deliberately: this
    is the library entry point and an uncapped call is a legitimate thing to
    want, while the tool that spends a real request budget should never make
    that choice by accident. The argument below is about the tool's default, not
    about the parameter's.

    WHY THE CAP IS NOT OPTIONAL. Ranked purely on expected yield, the first 300
    rows of this catalogue are 300 omnycontent.com shows — the whole arm on one
    platform, chosen on a sample of twelve. Two things go wrong at once. The
    obvious one is variance: if omny's 82% is an artifact of those twelve, the
    entire tranche is spent. The one that matters more is that such a run
    DISCOVERS NOTHING — it cannot tell us whether captivate, rss.com, spreaker
    or podetize transcribe, and those unmeasured platforms are 6,000 shows we
    would still be guessing about afterwards. The cap converts the exploit arm
    from "harvest the one host we know" into "harvest it AND price the others",
    which is what makes the next tranche better ranked than this one.

    Ranked order is preserved within and across hosts; the cap only skips. */
export function capByHost(ranked, { exploit = 300, hostCap = Infinity } = {}) {
  const perHost = new Map();
  const head = [];
  const skipped = [];
  for (const r of ranked) {
    if (head.length >= exploit) {
      skipped.push(r);
      continue;
    }
    const key = r.score.host_key;
    const n = perHost.get(key) || 0;
    if (n >= hostCap) {
      skipped.push(r);
      continue;
    }
    perHost.set(key, n + 1);
    head.push(r);
  }
  return { head, rest: skipped };
}

/** EXPLOIT: the capped ranked head. EXPLORE: a uniform sample of everything NOT
    in the head, so the two arms are disjoint and the explore arm is not quietly
    seeded with the winners we already chose. Disjointness is what lets the
    explore yield be read as a population estimate.

    Note the tail includes rows the CAP skipped, not just rows below the cut.
    That is deliberate: a capped-out omny show is still a fair draw for a
    uniform sample of the population, and excluding it would bias the explore
    arm away from exactly the platform we most want an honest second read on. */
export function stratifiedTranche(ranked, { exploit = 300, explore = 200, seed = "breadth-01", hostCap = Infinity } = {}) {
  const { head, rest: tail } = capByHost(ranked, { exploit: Math.max(0, exploit), hostCap });
  const next = rng(seed);

  // Partial Fisher-Yates over the tail: an unbiased sample without shuffling
  // 19,000 rows, and without the sort-by-random trick, which is not uniform.
  const idx = tail.map((_, i) => i);
  const take = Math.min(Math.max(0, explore), idx.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(next() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const sample = idx.slice(0, take).map((i) => tail[i]);

  return [
    ...head.map((r) => ({ ...r, arm: "exploit" })),
    ...sample.map((r) => ({ ...r, arm: "explore" })),
  ];
}

/** Catalogue rows in the shape `sweep-transcripts.mjs` reads: it needs
    `feed_url` and takes `show_id ?? String(apple_collection_id)`. `show_id` is
    set explicitly to the Apple id so the sweep's checkpoint keys join straight
    onto `data/breadth-classification.json` and `data/dai-classification.json`,
    both of which key on it. */
export function trancheCatalog(entries, meta = {}) {
  return {
    version: 1,
    built_at: new Date().toISOString(),
    notes:
      "Ranked breadth tranche for the transcript sweep (#114). Not a curation decision: " +
      "nothing here is proposed for data/catalog.json, and the 800KB mobile slice is unaffected.",
    ...meta,
    shows: entries.map(({ show, score, arm }) => ({
      show_id: String(show.apple_collection_id),
      apple_collection_id: show.apple_collection_id,
      title: show.title,
      feed_url: show.feed_url,
      apple_genre: show.apple_genre ?? null,
      chart_rank: show.chart_rank ?? null,
      episode_count: show.episode_count ?? null,
      arm,
      ...score,
    })),
  };
}

/* -------------------------------------------------------------------- main */

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const num = (flag, fallback) => {
    const raw = get(flag, String(fallback));
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a non-negative number, got ${JSON.stringify(raw)}`);
    return n;
  };
  return {
    exploit: num("--exploit", 300),
    explore: num("--explore", 200),
    seed: get("--seed", "breadth-01"),
    hostCap: num("--host-cap", 40),
    breadth: get("--breadth", null),
    availability: (get("--availability", "") || "").split(",").filter(Boolean),
    out: get("--out", null),
    report: argv.includes("--report"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const breadthPath = args.breadth ? resolvePath(process.cwd(), args.breadth) : join(ROOT, "data", "catalog-breadth.json");
  const avPaths = args.availability.length
    ? args.availability.map((p) => resolvePath(process.cwd(), p))
    : [join(ROOT, "data", "transcript-availability.json")];

  const availabilities = avPaths.filter((p) => existsSync(p)).map(readJson);
  if (availabilities.length === 0) throw new Error(`no availability index found at ${avPaths.join(", ")} — nothing to learn priors from`);

  const priors = hostPriors(availabilities);
  const dai = daiRatesFrom(availabilities);
  const breadth = readJson(breadthPath).shows || [];
  const pool = eligibleShows(breadth, { alreadySweptFeeds: sweptFeedUrls(availabilities) });

  console.log(
    `priors: ${priors.shows} swept show(s), ${priors.hits} with a timed transcript ` +
      `(${(priors.global_hit_rate * 100).toFixed(1)}% of shows), ${priors.hosts.size} host(s)`,
  );
  const byShows = [...priors.hosts.values()].sort((a, b) => b.shows - a.shows).slice(0, 15);
  for (const h of byShows) {
    console.log(
      `  ${h.host.padEnd(22)} ${String(h.shows).padStart(4)} swept  ${String(h.shows_with_timed).padStart(3)} hit  ` +
        `p=${hostHitRate(priors, h.host).toFixed(3)}  timed_frac=${hostTimedFraction(priors, h.host).toFixed(3)}`,
    );
  }
  console.log(`pool: ${pool.length} eligible uncurated feed(s) of ${breadth.length} breadth row(s)`);

  const ranked = rankShows(pool, priors, { daiRates: dai });
  if (args.report) {
    console.log(`\ntop 20 by expected timed transcripts per request:`);
    for (const r of ranked.slice(0, 20)) {
      console.log(
        `  ${String(r.score.expected_timed).padStart(7)}  ${String(r.score.expected_anchorable).padStart(7)} anch  ` +
          `${r.score.host_key.padEnd(18)} ${String(r.show.title).slice(0, 44)}`,
      );
    }
    return;
  }

  const entries = stratifiedTranche(ranked, { exploit: args.exploit, explore: args.explore, seed: args.seed, hostCap: args.hostCap });
  const exploitCount = entries.filter((e) => e.arm === "exploit").length;
  const catalog = trancheCatalog(entries, {
    seed: args.seed,
    pool_size: pool.length,
    arms: { exploit: exploitCount, explore: entries.length - exploitCount, host_cap: args.hostCap },
    priors: {
      swept_shows: priors.shows,
      shows_with_timed: priors.hits,
      global_hit_rate: round(priors.global_hit_rate, 4),
      global_timed_fraction: round(priors.global_timed_fraction, 4),
    },
  });

  const outPath = args.out ? resolvePath(process.cwd(), args.out) : join(ROOT, "data-local", "breadth", "tranche-01.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");
  const expExploit = entries.filter((e) => e.arm === "exploit").reduce((n, e) => n + e.score.expected_timed, 0);
  const expExplore = entries.filter((e) => e.arm === "explore").reduce((n, e) => n + e.score.expected_timed, 0);
  const hosts = new Map();
  for (const e of entries) if (e.arm === "exploit") hosts.set(e.score.host_key, (hosts.get(e.score.host_key) || 0) + 1);
  console.log(`\n${catalog.shows.length} show(s): ${exploitCount} exploit (expect ~${Math.round(expExploit)} timed) across ` +
    `${hosts.size} platform(s), ${entries.length - exploitCount} explore (expect ~${Math.round(expExplore)})`);
  console.log(`  exploit platforms: ${[...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(", ")}`);
  console.log(`RANK_COMPLETE: ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error("FATAL:", e.message);
    process.exit(1);
  }
}
