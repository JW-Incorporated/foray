/* The transcript label, and the shard key.
   Pure, keyless, no I/O, no network. Imported by tools/classify/prepare-batch.mjs
   (writes the label), tools/classify/merge-results.mjs (carries it into the
   record) and tools/classify/select.mjs (the shard key).

   ============================================================================
   THE ONE RULE THIS FILE EXISTS TO HOLD  (founder ruling, 2026-08-16)
   ============================================================================
   Wyatt: "make sure we're just labeling/cataloguing here — no show should be
   excluded at this stage, just catalogued. I don't want to accidentally toss
   out shows that are still useful, for example for playlists (not forays)."

   The field produced here is a DESCRIPTIVE LABEL. Never a filter, never a gate,
   never a reason a show leaves the catalogue or the selection queue. There is no
   `eligible: false`, no `skip`, no `excluded`, no dropped row.

   ============================================================================
   A TRANSCRIPT IS A COST, NOT A REQUIREMENT — and the difference is the point
   ============================================================================
   Read this before writing anything that reasons about the label, because an
   earlier framing of this work got it backwards and the wrong version is easy
   to re-derive from the review docs.

   **We can make transcripts.** Nine episodes for Foray #1 and nine for Foray #2
   were transcribed with our own ASR at ~1.1x realtime, and on domain vocabulary
   ours BEAT the publisher's: a Spotify SRT rendered "geology bites" as
   `jala g b`. So a missing `<podcast:transcript>` costs roughly **46 minutes of
   CPU per hour of audio**. It does not stop anything.

   What the label is therefore FOR: it says which shows are **cheap** to build
   from. A show that already ships a timed transcript is nearly free; one that
   does not is 46 min/hour of CPU. That is a scheduling and budgeting signal, and
   it is exactly why recording it is worth doing — and exactly why it must never
   filter. A show with no transcript is still catalogued, still recommendable,
   still Foray material at a price.

   Do NOT describe or model transcript availability as a requirement anywhere.
   The one thing that is genuinely a gate today is a **bounded ad delta**:
   paddable under ADR-0008's threshold, and needing a locate step that does not
   exist above it. That is per-episode, measured by
   tools/transcribe/ad-inflation.mjs, and deliberately nothing to do with this
   file.

   ============================================================================
   WHAT IS DELIBERATELY ABSENT
   ============================================================================
   **No per-show ad flag, ratio, median or boolean.** ADR-0008 (accepted
   2026-08-16) removed ad load as a rejection reason, so a per-show ad field
   would rebuild a gate the CTO had just taken down — and it would be invalid by
   that ADR's own rule, which requires N >= 2 probes of the SAME episode and a
   maximum in seconds. A per-show median across different episodes is "wrong
   twice over". The ranged-GET probe stays the separate narrow sweep it already
   is in tools/transcribe/ad-inflation.mjs.

   **Nothing else.** The feed also carries the enclosure host, `<language>` and
   the newest `<pubDate>`, all free, and the fleet review recommends capturing
   them. They are not captured, on the founder's instruction: "I just want it to
   flag transcripts, not go overboard." Every extra field is something a future
   session has to keep true.

   ============================================================================
   DEPENDENCY-FREE ON PURPOSE
   ============================================================================
   `tools/` carries no package.json, and CI's `data-and-site` job never runs
   `npm ci` in backend/ — so anything importable by a suite in this tree must not
   reach for backend/node_modules. The label is therefore read with
   tools/segments/sweep-transcripts.mjs's regex parser rather than with the
   fast-xml-parser instance prepare-batch.mjs borrows from backend for the
   Tier-0.5 description. Reusing it also single-sources TIMED_TRANSCRIPT_TYPES,
   which must agree with data/transcript-availability.json and with
   backend/src/feeds/parser.ts.                                              */

import { parseFeed, hasTimestamps, TIMED_TRANSCRIPT_TYPES } from "../segments/sweep-transcripts.mjs";

export { TIMED_TRANSCRIPT_TYPES };

/** Bumped when the shape of `transcript_labels` changes, so a consumer can tell
    a record written before the label existed (absent) from one written after
    (present, possibly all-zero). */
export const LABEL_SCHEMA_VERSION = 1;

/* Every field this module can put on a classification record. The no-exclusion
   suite iterates this list, so a new label is covered by the founder's
   constraint the moment it is named here. */
export const TRANSCRIPT_LABEL_FIELDS = Object.freeze([
  "label_schema_version",
  "episodes_sampled",
  "transcript_present",
  "transcript_tags",
  "episodes_with_timed_transcript",
  "transcript_types"
]);

/* Identifiers that would turn a label into a gate. The no-exclusion suite greps
   the pipeline's own source for these, because the cheapest way for this
   constraint to be lost is for a later change to add
   `if (!labels.transcript_present) continue;` — which reads as reasonable and is
   exactly the thing the founder ruled out. */
export const FORBIDDEN_GATE_KEYS = Object.freeze([
  "eligible",
  "ineligible",
  "excluded",
  "exclude",
  "rejected",
  "disqualified",
  "blocked",
  "filtered",
  "usable",
  "unusable",
  "foray_ready"
]);

// --------------------------------------------------------------- shard key --

/* FNV-1a, 32-bit, over the id STRING.

   Why not `Number(id) % N`, which is what --shard shipped with: Apple collection
   ids are not uniform mod 6. Measured over the 17,936 shows still needing a
   pass, `% 6` puts 1,514 shows in shard 0 (8.4%) against 3,334 in shard 3
   (18.6%) — a 2.20x imbalance. Finish time is the LARGEST shard, so shard 0 runs
   dry around day 12 and then emits CLASSIFY_BATCH_EMPTY for the rest of the
   blitz: a sixth of the fleet idle for over half the run. (Over all 19,787 the
   same key is a harmless 1.04x; the skew is a property of the remainder, because
   the 1,851 already done were taken in ascending-id order.)

   Sharding is a PARTITION, not a filter. The union of all N shards is the whole
   eligible set and the shards are disjoint — asserted in
   tools/classify/shard.test.mjs against the real catalogue. No show is dropped
   by being sharded; it is only assigned to one of six workers.

   STABILITY IS LOAD-BEARING. The key depends on the show's id and nothing else —
   not on the list, not on its length, not on position. A key derived from
   index-in-list would move a show between shards as siblings get classified,
   which repeats some work and skips the rest. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Which of `shardCount` shards owns this show. Depends only on the id. */
export function shardOf(id, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardOf: shardCount must be a positive integer, got ${JSON.stringify(shardCount)}`);
  }
  return fnv1a32(String(id)) % shardCount;
}

/* Parses `--shard i/N`. THROWS on anything malformed.

   It used to fail OPEN: `6/6`, `abc`, `0/0` or a missing value all left
   shardCount = 0, and the run silently processed the full unsharded catalogue —
   recreating the six-way duplicate-work collision the flag exists to fix, from
   one typo in one routine's config, with no warning anywhere.

   Note which direction this fails in: it refuses to RUN. It never drops a show.
   An omitted flag is still legal and still means "the whole catalogue". */
export function parseShard(spec) {
  if (spec === null || spec === undefined || spec === "") return null; // unsharded — the whole catalogue, deliberately
  const raw = String(spec).trim();
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (!m) {
    throw new Error(`--shard: expected "i/N" (e.g. "0/6"), got ${JSON.stringify(raw)}. Refusing to run unsharded by accident.`);
  }
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1) throw new Error(`--shard: N must be >= 1, got ${JSON.stringify(raw)}.`);
  if (index >= count) {
    throw new Error(`--shard: i must be < N (shards are 0-indexed, so N=${count} means 0/${count}..${count - 1}/${count}), got ${JSON.stringify(raw)}.`);
  }
  return { index, count };
}

// -------------------------------------------------------- transcript label --

/* All of this comes out of bytes prepare-batch.mjs ALREADY has on the wire. The
   feed is fetched for Tier-0.5 signal (description + recent episode titles) and
   everything else is discarded. Extracting this is a parser change: no LLM call,
   no extra request, no extra token, zero marginal cost.

   HONEST CAVEAT, and it must travel with the numbers: the counts are sampled
   over the <= `episodesSampled` items already fetched (8 by default), NOT over
   the show's whole back catalogue. `episodes_sampled` is recorded alongside them
   so the ratio is legible. They are a FLOOR, not a count — a show showing 0 of 8
   may well publish transcripts on older episodes. Which is one more reason a
   transcript label must never gate anything.

   `episodes_sampled: 0` is also how "we could not read this feed" appears. A
   show whose feed would not parse is still catalogued, with a label that is
   honestly empty rather than one that claims zero transcripts. */

/** A label for a show whose feed we could not read on this run. */
export function emptyTranscriptLabels(overrides = {}) {
  return {
    label_schema_version: LABEL_SCHEMA_VERSION,
    episodes_sampled: 0,
    transcript_present: false,
    transcript_tags: 0,
    episodes_with_timed_transcript: 0,
    transcript_types: {},
    ...overrides
  };
}

/** Computes `transcript_labels` from a raw feed body.

    @param xml              the feed bytes prepare-batch.mjs already fetched
    @param episodesSampled  how many leading <item>s to read (the same slice used
                            for Tier-0.5 signal — default 8)

    Never throws. A body that will not parse yields a valid, honestly-empty
    label object. */
export function transcriptLabelsFromXml(xml, episodesSampled = 8) {
  const labels = emptyTranscriptLabels();

  let episodes;
  try {
    episodes = parseFeed(xml).episodes.slice(0, Math.max(0, episodesSampled));
  } catch {
    return labels; // episodes_sampled stays 0 — "not read", not "no transcripts"
  }

  labels.episodes_sampled = episodes.length;
  for (const ep of episodes) {
    const types = (ep.transcript_types || []).filter(Boolean);
    if (types.length > 0) {
      labels.transcript_tags++;
      if (types.some((t) => hasTimestamps(t))) labels.episodes_with_timed_transcript++;
      for (const t of types) labels.transcript_types[t] = (labels.transcript_types[t] || 0) + 1;
    } else if (ep.transcript_url) {
      // A <podcast:transcript> with no readable @type is still a tag. Recorded
      // as "unknown" rather than dropped, so a new timestamped format shows up
      // as a question instead of as a loss.
      labels.transcript_tags++;
      labels.transcript_types.unknown = (labels.transcript_types.unknown || 0) + 1;
    }
  }
  labels.transcript_present = labels.transcript_tags > 0;
  return labels;
}
