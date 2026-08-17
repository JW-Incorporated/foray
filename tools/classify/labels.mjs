/* The transcript label, and the shard key.

   Keyless, and every function here is pure — but the MODULE is not free of I/O,
   and the header used to claim it was. Importing it pulls in
   tools/segments/sweep-transcripts.mjs, which imports tools/refresh/dai.mjs,
   which reads tools/refresh/dai-hosts.json at module scope. So: no network, no
   writes, no I/O in any call — one committed JSON file, read once at import.
   Stated precisely because this module is imported by the fleet SELECTOR, and a
   wrong claim here is what a future session would trust. Caught in review.

   Imported by tools/classify/prepare-batch.mjs (writes the label),
   tools/classify/merge-results.mjs (carries it into the record) and
   tools/classify/select.mjs (the shard key).

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
   THIS PARAGRAPH IS THE AUTHORITY. `docs/agents/fleet-review-2026-08.md` §3
   ranks transcript availability as the #1 *binding constraint*; the founder
   corrected that on 2026-08-16, and the review's framing is easy to re-derive if
   you read it without this note.

   **We can make transcripts.** ASR feasibility is measured, and the measurement
   lives in `docs/curation/transcription-scale-plan.md` §1/§5: **1.33x realtime
   for `base.en`**, i.e. of order **45 minutes of CPU per hour of audio**. (The
   ~1.1x figure quoted elsewhere, e.g. `docs/curation/foray2-asr-manifest.json`,
   is a planning rate, not that measurement. Cite the scale plan, and do not
   restate either number in new files — one source, linked, is the point.)

   So a missing `<podcast:transcript>` is an amount of CPU. It does not stop
   anything. What the label is therefore FOR: it says which shows are **cheap**
   to build from. That is a scheduling and budgeting signal, which is exactly why
   recording it is worth doing — and exactly why it must never filter. A show
   with no transcript is still catalogued, still recommendable, still Foray
   material at a price.

   Quality is a genuinely open question, not a settled win. A prior session
   compared our ASR against a publisher SRT on domain vocabulary and ours read
   better on the terms it checked, but **WER is formally unmeasured in this
   repo** — that is T2 (#117), still open per `STATE.md`. Do not cite "ours is
   better" as established; cite T2 when it reports.

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
  "episodes_with_transcript",
  "episodes_with_timed_transcript",
  "transcript_tags",
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

   `""` AND WHITESPACE THROW, and that is not pedantry — it is the likeliest way
   six cloud routines get misconfigured. A routine whose command reads
   `--shard "$SHARD"` with `SHARD` unset passes an empty string, which is
   indistinguishable at this layer from a deliberate whole-catalogue run and would
   silently do six times the work. Only a genuinely ABSENT flag (null/undefined,
   which parseArgs produces when `--shard` does not appear at all) means "the
   whole catalogue".

   Note which direction this fails in: it refuses to RUN. It never drops a show. */
export function parseShard(spec) {
  if (spec === null || spec === undefined) return null; // flag absent — the whole catalogue, deliberately
  const raw = String(spec).trim();
  if (raw === "") {
    throw new Error(
      '--shard: empty value. An unset variable (e.g. `--shard "$SHARD"`) reaches here as "" and used to run ' +
        "the FULL unsharded catalogue silently. Pass a real shard (0/6..5/6), or omit the flag entirely if you " +
        "genuinely mean the whole catalogue."
    );
  }
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

/* FIELD NAMES MATCH data/transcript-availability.json AND
   tools/segments/sweep-transcripts.mjs's `summariseShow`, deliberately and
   exactly, because the two files describe the same quantities over overlapping
   show sets and somebody will eventually aggregate them:

     episodes_with_transcript        episodes carrying >= 1 <podcast:transcript>
     episodes_with_timed_transcript  ... of which at least one is a TIMED format
     transcript_tags                 TAGS, not episodes — feeds publish ~2.9 per
                                     transcribed episode, so this is ~2.9x the
                                     episode count and is not a coverage number
     transcript_types                per-TYPE tag counts; sums to transcript_tags

   The first draft of this label used `transcript_tags` for the episode count,
   which meant `transcript_tags: 3` sitting next to a `transcript_types` that
   summed to 8, and a ~2.9x disagreement with the field of the same name in
   data/transcript-availability.json. Caught in review. */

/** A label for a show whose feed we could not read on this run. */
export function emptyTranscriptLabels(overrides = {}) {
  return {
    label_schema_version: LABEL_SCHEMA_VERSION,
    episodes_sampled: 0,
    transcript_present: false,
    episodes_with_transcript: 0,
    episodes_with_timed_transcript: 0,
    transcript_tags: 0,
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
    /* Every tag is counted, including one with no readable @type — recorded as
       "unknown" rather than dropped, so a publisher adding a new timestamped
       format alongside their existing VTT shows up as a question instead of as a
       silent loss. The first draft only reached the untyped branch when NO tag on
       the episode had a type, which meant the realistic case (typed + untyped
       together) dropped the untyped one. Caught in review. */
    const tags = ep.transcript_types || [];
    if (tags.length === 0) continue;

    labels.episodes_with_transcript++;
    if (tags.some((t) => hasTimestamps(t))) labels.episodes_with_timed_transcript++;
    for (const t of tags) {
      const key = t || "unknown";
      labels.transcript_tags++;
      labels.transcript_types[key] = (labels.transcript_types[key] || 0) + 1;
    }
  }
  labels.transcript_present = labels.episodes_with_transcript > 0;
  return labels;
}

/* Combines a previously-recorded label with a freshly-observed one, keeping the
   richer OBSERVATION.

   Why this exists: a Tier-2 escalation re-merges a show that Tier 1 already
   labelled. If that run happens to hit a 500, an unconditional overwrite would
   replace `episodes_sampled: 8, transcript_types: {text/vtt: 8}` with
   `episodes_sampled: 0` — a real measurement destroyed by a transient failure,
   in the one field whose entire purpose is budgeting.

   "Richer" is `episodes_sampled`, i.e. how many episodes the label actually saw.
   A fresh reading of the same or more episodes wins (feeds change, and the newer
   observation is the truer one); a reading of FEWER episodes than we already had
   loses. Note what this is not: it is not a judgment about the show, and it
   never affects whether the show is merged. Both branches produce a record. */
export function mergeTranscriptLabels(previous, next) {
  const a = previous && typeof previous === "object" ? previous : null;
  const b = next && typeof next === "object" ? next : null;
  if (!b) return a ?? emptyTranscriptLabels();
  if (!a) return b;
  return Number(b.episodes_sampled ?? 0) >= Number(a.episodes_sampled ?? 0) ? b : a;
}
