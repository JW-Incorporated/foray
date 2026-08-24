/* Transcript coverage — how many of the curated episodes can we read for free?
   (issue #104 follow-up, epic #102.)

   WHY THIS EXISTS — `data/transcript-availability.json` has recorded thousands
   of free transcripts since 2026-08-12, and every attempt to ask "so how many
   of OUR episodes have one?" answered zero. Not because the index was empty:
   because the two files share no episode key. `data/discover.json` items are
   keyed on Apple ids (`apple_collection_id` / `apple_track_id`); availability
   episode rows are keyed on the feed's `<guid>`. Neither file carries the
   other's key, so every join — by guid, by track id, by show slug — matched
   nothing, and the honest-looking output of that was "0 of 1,672".

   That is the worst shape a measurement can have. An empty index announces
   itself; a broken join reports a real number that happens to be zero, and
   zero is exactly what everyone already feared, so nobody re-checks it. The
   sweep's `--reset` doc, ADR-0004's ladder and the scale plan's §3 were all
   arguing about the size of a pool nothing could count.

   THE FIX IS ONE FIELD. The enclosure URL is the only value both files take
   verbatim from the same feed, so `sweep-transcripts.mjs` now records
   `enclosure_url` on every episode row and this file joins on it. Measured
   10/10 exact on Practical AI before the field was added, and the run summary
   below reports the match rate every time so a future drift is visible on the
   first run rather than after a quarter of planning against a wrong number.

   THE ONE BACKSTOP DEMANDS TWO SIGNALS. Enclosure URLs can be rewritten by a
   publisher moving CDNs, so a title-AND-duration match backs the primary key
   up. Requiring both is load-bearing, not cautious: tried independently they
   produced 7 matches on the real catalogue and all 7 were the wrong episode
   (see `joinItem`). Every match records `via`, and the CLI prints the split, so
   a report carried by the backstop rather than the key is visibly one to
   distrust.

   A BROKEN INDEX IS AN ERROR, NOT A ZERO. Three separate refusals, because
   "0 of 1,672" is the answer every one of these failures produces otherwise:

     NEVER_SWEPT             the index has no `generated_at`, so it was never
                             produced by a run — distinct from a run that swept
                             everything and found nothing, which reports an
                             honest zero
     NO_JOIN_KEY             fewer than 90% of episode rows carry the key. Not
                             "zero rows": a reviewer stripped it from 8,249 of
                             8,250 and the old all-or-nothing guard stayed quiet
                             while the backstop reported a confident 8.3%
     BACKSTOP_CARRYING_JOIN  the backstop is carrying more than 10% of matches
                             (once there are at least 20 of them — a share over
                             a handful of rows is noise), which means the exact
                             key has drifted

   NEVER FETCHES ANYTHING. Pure join over two committed files — no network, so
   it is free to run in CI and on every catalogue refresh.

   Usage:
     node tools/segments/transcript-coverage.mjs
       [--discover PATH] [--availability PATH] [--out PATH] [--json]           */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Duration slack for the corroborating match. Feeds round `itunes:duration`
    to the second and the two files can disagree by rounding alone; 2s admits
    that and nothing else. */
export const DURATION_TOLERANCE_SEC = 2;

/** Below this share of episode rows carrying `enclosure_url`, the index is
    treated as broken rather than sparse.

    A PARTIAL collapse is the dangerous one. The original guard only fired when
    ZERO rows had the key; a reviewer stripped it from 8,249 of 8,250 rows and
    the run reported a confident 139 of 1,672 (8.3%) with nothing red, because
    the title+duration backstop quietly absorbed the regression. A half-finished
    `--reset`, or a parser change that drops the enclosure on most feeds, lands
    exactly there. */
export const MIN_JOIN_KEY_RATIO = 0.9;

/** Above this share of matches coming from the backstop rather than the exact
    key, something is wrong with the key and the number cannot be trusted.
    On a healthy index the backstop contributes 0. */
export const MAX_BACKSTOP_SHARE = 0.1;

/** ...but only once there are enough matches for a share to mean anything. At
    N=2 a single legitimate backstop hit is 50% and the guard would fire on a
    healthy index; the real catalogue produces 158. A ratio computed over a
    handful of rows is noise, and a guard that cries wolf gets deleted, which
    costs more than the guard was worth. */
export const MIN_MATCHES_FOR_SHARE_GUARD = 20;

export class CoverageError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CoverageError";
    this.code = code;
  }
}

/** Case/punctuation-insensitive title key. Publishers re-punctuate titles
    between the feed and Apple's copy constantly ("#497 – Foo" vs "497 - Foo"),
    so comparing raw titles under-matches badly. */
export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Builds the lookup structures once. Kept separate from the join so a test can
    assert the index shape without running a full coverage pass. */
export function indexAvailability(availability) {
  const shows = Array.isArray(availability?.shows) ? availability.shows : null;
  if (!shows) throw new CoverageError("BAD_AVAILABILITY", "availability file has no `shows` array");

  const byEnclosure = new Map();
  const showsByAcid = new Map();
  const showsByTitle = new Map();
  let episodeRows = 0;
  let rowsWithEnclosure = 0;

  for (const show of shows) {
    if (show.apple_collection_id != null) showsByAcid.set(String(show.apple_collection_id), show);
    if (show.title) showsByTitle.set(normalizeTitle(show.title), show);
    for (const ep of show.episodes || []) {
      episodeRows++;
      if (!ep.enclosure_url) continue;
      rowsWithEnclosure++;
      // First writer wins: a URL appearing twice is a feed republishing an
      // episode, and the earlier row is the one the catalogue was built from.
      if (!byEnclosure.has(ep.enclosure_url)) byEnclosure.set(ep.enclosure_url, { show, episode: ep });
    }
  }

  return { byEnclosure, showsByAcid, showsByTitle, episodeRows, rowsWithEnclosure, shows };
}

/** Resolves one discover item to its availability show, by Apple id first
    (stable) then by normalised title (what `ad-inflation.mjs` already uses). */
export function findShow(item, index) {
  const byId = index.showsByAcid.get(String(item.apple_collection_id));
  if (byId) return byId;
  return index.showsByTitle.get(normalizeTitle(item.show)) || null;
}

/** The join. Returns `{ show, episode, via }` or null.

    THE BACKSTOP REQUIRES BOTH SIGNALS, AND THAT IS NOT FUSSINESS. The first
    version of this function tried title, then duration, independently. Run
    against the real catalogue it produced 7 matches beyond the exact key and
    **every one of them was wrong**:

      Geology Bites   "Bernhard Steinberger on Whether Hotspots Are Fixed" (1736s)
                   -> "Alec Brenner on When Tectonic Plates First Moved"   (1735s)
      BBQ Central     same title, 563s vs 303s — a re-cut, not the same audio

    Neither signal discriminates alone. A show publishes hundreds of episodes
    and dozens land within a second of each other, so duration alone attaches an
    arbitrary transcript; and a show re-releases an episode under one title with
    a different cut, so title alone attaches the wrong timeline. Together they
    are strong: two unrelated episodes rarely share both.

    A wrong match here is worse than a miss. A missed episode is one transcript
    we do not have; a mismatched one is a segment whose anchors point into
    different audio entirely, and nothing downstream can detect that. */
export function joinItem(item, index) {
  const direct = item.audio_url ? index.byEnclosure.get(item.audio_url) : null;
  if (direct) return { ...direct, via: "enclosure_url" };

  const show = findShow(item, index);
  if (!show) return null;

  const want = normalizeTitle(item.title);
  if (!want || !Number.isFinite(item.duration_sec) || item.duration_sec <= 0) return null;

  const hit = (show.episodes || []).find(
    (e) =>
      e.transcript_url &&
      normalizeTitle(e.title) === want &&
      Number.isFinite(e.duration_sec) &&
      Math.abs(e.duration_sec - item.duration_sec) <= DURATION_TOLERANCE_SEC,
  );
  return hit ? { show, episode: hit, via: "title+duration" } : null;
}

/** The whole measurement. Returns the report the CLI prints and writes. */
export function coverage({ discover, availability }) {
  const items = Array.isArray(discover) ? discover : discover?.items;
  if (!Array.isArray(items)) throw new CoverageError("BAD_DISCOVER", "discover file has no `items` array");
  if (items.length === 0) throw new CoverageError("EMPTY_DISCOVER", "discover file has zero items");

  const index = indexAvailability(availability);

  /* PROVENANCE BEFORE COUNTS. "Never swept" and "swept and found nothing" are
     different facts that used to produce the identical output line, `0 of 1,672
     (0%)`. That ambiguity is the whole reason this tool exists: a probe of the
     committed index read zero and nobody could tell whether the sweep had never
     run at scale or had run and found nothing. An index that was never
     generated has no `generated_at`, so the two are distinguishable — cheaply,
     and without the blunt "throw whenever the index is empty" that would break
     the legitimate every-feed-is-dead case below. */
  if (!availability?.generated_at) {
    throw new CoverageError(
      "NEVER_SWEPT",
      `availability index carries no \`generated_at\`, so it was never produced by a sweep. ` +
        `Reporting 0% from it would be indistinguishable from a real zero. ` +
        `Run: node tools/segments/sweep-transcripts.mjs --reset`,
    );
  }

  if (index.episodeRows > 0) {
    const keyed = index.rowsWithEnclosure / index.episodeRows;
    if (keyed < MIN_JOIN_KEY_RATIO) {
      throw new CoverageError(
        "NO_JOIN_KEY",
        `only ${index.rowsWithEnclosure} of ${index.episodeRows} episode rows carry \`enclosure_url\` ` +
          `(${Math.round(keyed * 1000) / 10}%, floor ${MIN_JOIN_KEY_RATIO * 100}%); the index predates the join key ` +
          `or was written by a partial run. Re-run: node tools/segments/sweep-transcripts.mjs --reset`,
      );
    }
  }

  const via = { enclosure_url: 0, "title+duration": 0 };
  const formats = {};
  const byShow = new Map();
  let withTranscript = 0;
  let withTimed = 0;
  const showsSeen = new Set();

  for (const item of items) {
    const showName = item.show || "(unknown)";
    showsSeen.add(showName);
    if (!byShow.has(showName)) {
      byShow.set(showName, {
        show: showName,
        apple_collection_id: item.apple_collection_id ?? null,
        discover_episodes: 0,
        with_transcript: 0,
        with_timed_transcript: 0,
        dai_suspected: item.dai_suspected ?? null,
        formats: {},
      });
    }
    const bucket = byShow.get(showName);
    bucket.discover_episodes++;

    const hit = joinItem(item, index);
    if (!hit) continue;

    withTranscript++;
    via[hit.via]++;
    bucket.with_transcript++;
    const type = hit.episode.transcript_type || "unknown";
    formats[type] = (formats[type] || 0) + 1;
    bucket.formats[type] = (bucket.formats[type] || 0) + 1;
    if (hit.episode.has_timestamps) {
      withTimed++;
      bucket.with_timed_transcript++;
    }
  }

  /* The header promises this fails loudly if the match rate collapses. This is
     that promise, implemented: the backstop exists to survive a publisher moving
     CDNs, not to carry the join. When it is carrying the join, the exact key has
     broken and every number below is an understatement nobody would notice. */
  if (withTranscript >= MIN_MATCHES_FOR_SHARE_GUARD && via["title+duration"] / withTranscript > MAX_BACKSTOP_SHARE) {
    throw new CoverageError(
      "BACKSTOP_CARRYING_JOIN",
      `${via["title+duration"]} of ${withTranscript} matches came from the title+duration backstop ` +
        `(over ${MAX_BACKSTOP_SHARE * 100}%); the \`enclosure_url\` key has drifted and this coverage number ` +
        `understates the truth. Re-run: node tools/segments/sweep-transcripts.mjs --reset`,
    );
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const shows = [...byShow.values()]
    .filter((s) => s.with_transcript > 0)
    .sort((a, b) => b.with_timed_transcript - a.with_timed_transcript || b.with_transcript - a.with_transcript);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    discover: { episodes: items.length, shows: showsSeen.size },
    availability: {
      generated_at: availability?.generated_at ?? null,
      shows_indexed: index.shows.length,
      episode_rows: index.episodeRows,
      episode_rows_with_enclosure_url: index.rowsWithEnclosure,
    },
    coverage: {
      episodes_with_transcript: withTranscript,
      episodes_with_timed_transcript: withTimed,
      transcript_pct: pct(withTranscript, items.length),
      timed_transcript_pct: pct(withTimed, items.length),
      shows_with_transcript: shows.length,
      matched_via: via,
      formats,
    },
    by_show: shows,
  };
}

// -------------------------------------------------------------------- main --

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    discover: get("--discover", null),
    availability: get("--availability", null),
    out: get("--out", null),
    json: argv.includes("--json"),
  };
}

function envPath(name, override, ...def) {
  if (override) return resolvePath(process.cwd(), override);
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const discoverPath = envPath("DISCOVER_PATH", args.discover, "data", "discover.json");
  const availabilityPath = envPath("AVAILABILITY_PATH", args.availability, "data", "transcript-availability.json");

  const report = coverage({
    discover: JSON.parse(readFileSync(discoverPath, "utf8")),
    availability: JSON.parse(readFileSync(availabilityPath, "utf8")),
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const c = report.coverage;
    console.log(`${c.episodes_with_transcript} of ${report.discover.episodes} curated episodes have a publisher transcript (${c.transcript_pct}%)`);
    console.log(`  of which timed (anchorable): ${c.episodes_with_timed_transcript} (${c.timed_transcript_pct}%)`);
    console.log(`  concentrated in ${c.shows_with_transcript} of ${report.discover.shows} shows`);
    console.log(`  matched via: ${Object.entries(c.matched_via).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    console.log(`  formats: ${Object.entries(c.formats).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`);
    console.log(`\n  show                                                        eps  transcript  timed  dai`);
    for (const s of report.by_show) {
      console.log(
        `  ${s.show.slice(0, 56).padEnd(56)} ${String(s.discover_episodes).padStart(4)} ${String(s.with_transcript).padStart(11)} ${String(s.with_timed_transcript).padStart(6)}  ${s.dai_suspected ? "yes" : "no"}`,
      );
    }
  }

  if (args.out) {
    const outPath = resolvePath(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nCOVERAGE_WRITTEN: ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error("FATAL:", e instanceof CoverageError ? e.message : e);
    process.exit(1);
  }
}
