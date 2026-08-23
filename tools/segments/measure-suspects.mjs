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

   #321 POINTS THE SAME INSTRUMENT AT THE SHOWS NOBODY SUSPECTED. See the
   `which shows` section below: the suspects were the small end, and after #320
   every one of the 46 anchorable shows carries `dai_reason: "unknown"`. Same
   probe, same thresholds, same `disposition`; only the pool differs.

   Usage:
     node tools/segments/measure-suspects.mjs [--per-show N] [--dry-run]
                                              [--yield FILE] [--out FILE]
                                              [--pool suspects|anchorable]
                                              [--limit N] [--min-transcripts N]
                                              [--host SUBSTR,SUBSTR] [--resume]
                                              [--repeat N] [--reprobe]
                                              [--settled FILE,FILE]
*/

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  probeEpisode,
  summariseShow,
  isPlausibleAudioSize,
  undersizedSamples,
  AD_FREE_FLOOR,
  AD_FREE_THRESHOLD,
  MIN_SAMPLES_FOR_AD_FREE,
} from "../transcribe/ad-inflation.mjs";
import { ANCHOR_TIME_TOLERANCE_SEC } from "./merge-segments.mjs";
import { classifyShow, daiHostIn } from "../refresh/dai.mjs";
import { fetchFeed, parseFeed, writeJsonAtomic } from "./sweep-transcripts.mjs";
import { hostKeyOf } from "./rank-breadth.mjs";
/* The two lists of committed ledgers. They live in a module of their own
   because `breadth-yield.mjs` needs them too and must not import THIS file —
   see `ledgers.mjs`'s header. Re-exported below so every existing importer of
   `GRID_REPORT_RELS` keeps working. */
import { GRID_REPORT_RELS, MEASURED_REPORT_RELS } from "./ledgers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ------------------------------------------------------------- which shows

   TWO POOLS, ONE INSTRUMENT, AND THE SECOND ONE IS THE LARGER PROBLEM (#321).

   #319 pointed this scan at the SUSPECTS: anchorable shows whose "not DAI"
   verdict was contradicted by a hostname we already knew something about. That
   is the small end. The large end is everything the hostname rule said nothing
   about at all — and after #320 that is every anchorable show there is. All 46
   of them carry `dai_reason: "unknown"`, which does not mean "verified static";
   it means `classifyShow` walked the redirect chain and recognised no host on
   it. 10,933 timed transcripts rest on a negative.

   INFERENCE IS EXACTLY WHAT #319 TESTED AND FOUND WANTING. It measured seven
   inferred-anchorable shows and six of them injected. Running the same
   instrument over the shows nobody suspected is not a different question asked
   twice; it is the first time the question has been asked of the supply that
   actually matters.

   THE ORDER IS BY PLATFORM SIZE, WHICH IS THE POINT AND NOT A DEFAULT.
   The corpus is concentrated: `atelier.flightcast.com` alone carries 5,461 of
   the 10,933 net transcripts across seven shows — 47% — and four more hosts
   carry another 4,170. Ordering shows by their own transcript count would
   interleave a 1,368-transcript show with a 1-transcript one and answer five
   platform questions at 20% each. Ordering by HOST TOTAL first settles the
   biggest platform question first, so an interrupted run has still answered the
   one that changes what we do next. It is also the conservative direction for a
   run that may be stopped: the transcripts still resting on inference when the
   requests run out are the fewest possible.

   IT IS NOT A PLATFORM VERDICT AND THIS ORDERING MUST NOT BE READ AS ONE.
   `_adswizz_note` in `dai-hosts.json` sets the precedent: "One insert on one
   show is evidence about that show, not a platform-wide claim." Grouping by
   host is a REQUEST ORDER. Each show still gets its own five probes and its own
   `disposition`, and a host with a dirty show and a clean one is reported as
   exactly that. Nothing in this file aggregates a verdict to a hostname. */

/** Why a show is in the anchorable pool: nothing measured it, ever.

    Deliberately not "clean" and deliberately not "suspect". `dai_reason:
    "unknown"` was filed as a pass by `classifyShow`, and this names what that
    pass actually rests on so the shortlist cannot be re-read later as a claim
    anybody checked. */
export const INFERRED_STATIC_REASON = "inferred-static";

/** Total timed transcripts per enclosure host, over the rows given.

    Extracted because the ordering below and the report both need it and a
    second count that drifted from the first is this repo's most-repeated bug. */
export function hostTotals(rows) {
  const totals = new Map();
  for (const r of rows) {
    const h = String(r.enclosure_host || "unknown");
    /* BOTH SPELLINGS, because the two row shapes this file handles disagree on
       the name and a silent zero is the failure mode. A swept index row calls
       it `episodes_with_timed_transcript`; a pool row produced by `selectPool`
       calls it `timed_transcripts`. Reading only the former returned all zeros
       for a pool — which is why `main` used to round-trip the pool back through
       `report.shows` to count it, an O(n*m) detour that also counted a
       DIFFERENT set of rows than the ordering had used. */
    totals.set(h, (totals.get(h) || 0) + (r.timed_transcripts ?? r.episodes_with_timed_transcript ?? 0));
  }
  return totals;
}

/** The shows this run will spend requests on, in the order it will spend them.

    `pool: "suspects"` is #319's behaviour, byte for byte: the shortlist the
    yield report already computed. `pool: "anchorable"` is the new question —
    every anchorable show the shortlist did NOT flag, i.e. every show currently
    counted in `anchorable_net_of_suspects`.

    ANYTHING ALREADY MEASURED IS EXCLUDED, and the shortlist is only half of
    that. The suspects are netted out of the 10,933 already, so re-probing them
    cannot move it. But a suspect measured `recover` LEAVES the shortlist — that
    is what `suspectAnchorable` does with a recovery — so it reappears as an
    ordinary anchorable row with a measurement already committed against it.
    Apokalypse & Filterkaffee is exactly that show: #319 spent five probes on
    it, and a shortlist-only exclusion would have spent five more to re-learn
    the same answer. `settled` is therefore the show_ids of every row that
    already reached a disposition, from every measurement file passed in, and
    the shortlist is unioned into it rather than checked instead of it.

    ROWS COME OUT IN THE SHORTLIST'S SHAPE so the loop below, `dispositionOf`,
    and `measuredDispositions` in `breadth-yield.mjs` cannot tell the two pools
    apart. The pool decides what gets measured; it must not decide how. */
export function selectPool(report, { pool = "suspects", limit = null, minTranscripts = 1, hosts = [], settled = new Set() } = {}) {
  if (pool === "suspects") return report?.suspect_anchorable || [];
  if (pool !== "anchorable") throw new Error(`--pool must be "suspects" or "anchorable", got ${pool}`);

  const skip = new Set([...settled].map(String));
  for (const s of report?.suspect_anchorable || []) skip.add(String(s.show_id));
  const want = hosts.map((h) => String(h).toLowerCase()).filter(Boolean);
  const rows = (report?.shows || []).filter(
    (r) =>
      r.anchorable &&
      !skip.has(String(r.show_id)) &&
      (r.episodes_with_timed_transcript || 0) >= minTranscripts &&
      (!want.length || want.some((h) => String(r.enclosure_host || "").toLowerCase().includes(h))),
  );

  /* Host total first, then the show's own size, then show_id. The last key is
     not decoration: without it two shows of equal size on one host order by
     whatever the input happened to be, and a `--limit` run would probe a
     different set on a re-run than the one it reported. */
  const totals = hostTotals(rows);
  const ordered = rows.sort(
    (a, b) =>
      (totals.get(String(b.enclosure_host || "unknown")) || 0) - (totals.get(String(a.enclosure_host || "unknown")) || 0) ||
      String(a.enclosure_host || "").localeCompare(String(b.enclosure_host || "")) ||
      (b.episodes_with_timed_transcript || 0) - (a.episodes_with_timed_transcript || 0) ||
      String(a.show_id).localeCompare(String(b.show_id)),
  );

  const capped = Number.isInteger(limit) && limit > 0 ? ordered.slice(0, limit) : ordered;
  return capped.map((r) => ({
    show_id: r.show_id,
    title: r.title,
    feed_host: hostKeyOf(r.feed_url),
    enclosure_host: r.enclosure_host,
    reason: INFERRED_STATIC_REASON,
    timed_transcripts: r.episodes_with_timed_transcript || 0,
  }));
}

/** What this run learned, counted in shows and in transcripts.

    DELIBERATELY NOT `recount`. That function answers the suspects' question —
    how much of a netted-OUT shortlist comes back — and its `anchorable_after`
    is `net + recovered`. Applied to the anchorable pool, where every row is
    already inside `net`, the same arithmetic would count every clean show
    twice. Two pools asking two questions get two accountings, and the one that
    does not apply is not written.

    THE SECOND NUMBER IS THE DELIVERABLE. "10,933, all inferred" and "6,000, all
    measured" are very different assets, and only the split says which one this
    is. `measured_clean` is the asset; `still_inferred` is the liability, and it
    is computed in `breadth-yield.mjs` where the whole row set is in scope
    rather than guessed at from a run that may have been capped by `--limit`. */
export function measurementSplit(results) {
  const rows = results || [];
  const rowsFor = (d) => rows.filter((r) => r.disposition === d);
  const timed = (list) => list.reduce((n, r) => n + (r.timed_transcripts || 0), 0);
  const tally = (list) => ({ shows: list.length, timed_transcripts: timed(list) });
  return {
    measured_clean: tally(rowsFor("recover")),
    measured_injecting: tally(rowsFor("drop")),
    unresolved: tally(rowsFor("unresolved")),
    /* A NAMED SUBSET OF `unresolved`, and on this corpus it is the single most
       consequential number the run produced. These are shows repeat-probed
       under ADR-0008's same-episode rule that never once varied: no evidence
       whatsoever of a stitcher, and no denominator with which to prove its
       absence. Rolled into a bare `unresolved` they are indistinguishable from
       a show whose feed would not load — and the difference is 5,461
       transcripts, 47% of the corpus, and the answer to "does flightcast
       inject". It OVERLAPS `unresolved` by construction; it is a different
       slice of the same rows, never an extra bucket to add in. */
    repeat_stable_no_denominator: tally(
      rowsFor("unresolved").filter(
        (r) =>
          (r.samples || []).length > 0 &&
          /* EVERY sample repeat-probed and NONE of them ratio-able, read off the
             samples rather than off `r.repeats`. A show with one repeated
             episode and four single ones is not "probed N times and never
             varied", and the note this slice justifies says exactly that. */
          (r.samples || []).every((x) => plausibleDeliveries(x).length >= 2 && x.ratio == null) &&
          !varyingSamples(r.samples),
      ),
    ),
    note:
      "unresolved is neither a clean bill nor evidence of ads: the show keeps whatever its " +
      "pre-measurement status was, and stays inferred rather than becoming measured. " +
      "repeat_stable_no_denominator is the subset of it that was probed N times and never varied — " +
      "no sign of insertion, and no declared length with which to confirm its absence",
  };
}

/** Prefixes of the notes only the probe loop can know — see `fetchNoteOf`. */
export const FETCH_NOTE_PREFIXES = ["feed unreadable:", "no feed_url"];

/** A carried row's note, but ONLY when the samples could not have produced it.

    THE BUG THIS CLOSES WAS CREATED BY A FIX. Once `--resume` began re-deriving
    every prior row rather than only the settled ones, a row whose feed had been
    momentarily unreadable went back through `deriveRow` with no note — and
    `deriveRow` fills an empty-sample row's note with
    `NO_DECLARED_LENGTH_REASON`. So `feed unreadable: socket hang up` was
    rewritten, in committed evidence, as "this show needs ADR-0008
    decode-and-compare, not a retry". Those are the two opposite follow-ups that
    reason exists to keep apart, and the rewrite asserted the wrong one.

    ONLY THESE NOTES SURVIVE, and that is the whole point. A note derived from
    the samples must be RE-derived, or a signal added later never reaches the
    rows already measured — which is the reason re-derivation exists. A note
    describing a failed fetch cannot be re-derived from samples that a failed
    fetch prevented from existing. The two are told apart by prefix because the
    loop is the only writer of either. */
export function fetchNoteOf(row) {
  const note = row?.note;
  if (typeof note !== "string") return null;
  return FETCH_NOTE_PREFIXES.some((p) => note.startsWith(p)) ? note : null;
}

/** Everything a result row says ABOUT its samples, computed from those samples.

    THE SAMPLES ARE THE EVIDENCE; EVERY OTHER FIELD IS AN OPINION ABOUT THEM.
    Keeping that true is what lets `--resume` carry a row forward from an
    earlier pass and still have it describe itself in today's vocabulary: the
    resumed rows go back through this function, so a signal added after they
    were measured (`constant_offset_bytes` was) appears on them without
    re-asking a publisher for bytes we already have.

    IT EXISTS BECAUSE THERE WOULD OTHERWISE BE TWO COPIES OF THIS ARITHMETIC —
    one in the probe loop and one in the resume path — and this repo has found
    the same duplicated-implementation bug six times, most recently
    `writeJsonAtomic` in #320. Two copies of a verdict rule is the most
    expensive shape that failure can take: the file would contain rows judged by
    two different standards with nothing on them saying which.

    `note` IS PASSED IN, not derived, when the loop already knows something the
    samples cannot show — an unreadable feed, a missing feed URL. Notes that ARE
    derivable from the samples are computed here, so a resumed row gets them
    too. An incoming note wins: "the feed would not load" explains a row's empty
    samples better than any inference drawn from their absence.

    `decodes` IS THE `decodeIndex` OF THE DECODE LEDGER, injected rather than
    read from disk here for the same reason `isDaiHost` is injected into
    `suspectAnchorable`: this function is pure and its suite must be able to
    exercise the override without a data file that is expected to change. Null
    means "no decode evidence", which is the state of every row this scan has
    ever produced until one is downloaded — and it must leave the screen's
    verdict exactly as it found it. */
export function deriveRow(base, { note = null, decodes = null, grids = null } = {}) {
  const samples = base.samples || [];
  const summary = summariseShow(samples.map((x) => x.ratio));
  const undersized = undersizedSamples(samples);
  const inserted = insertedSamples(samples);
  const unmeasured = unmeasuredSamples(samples);
  const varying = varyingSamples(samples);
  /* OBSERVED, NOT DECLARED. The row used to stamp `repeats: args.repeat` across
     the whole show while the loop decided per EPISODE whether to repeat — an
     episode that declares a length is probed once however `--repeat` is set. On
     a show with a mix, the row claimed three probes of episodes that got one,
     the `repeat_stable_no_denominator` slice counted it, and its note asserted
     "each probed 3x ... this feed declares no enclosure length" of a feed that
     does. The committed evidence escapes only because that pass was narrowed by
     `--host` to two platforms that declare no lengths at all. Reading the count
     back off the samples cannot lie, and it is null unless EVERY sample carries
     the same repeat count — a mixed show is not a repeat-probed show. */
  const counts = samples.map((x) => plausibleDeliveries(x).length);
  const repeats = counts.length && counts.every((n) => n === counts[0] && n >= 2) ? counts[0] : null;
  const spread = maxDeliverySpread(samples);
  const constantOffset = constantOffsetBytes(samples);
  const screened = dispositionOf(summary.verdict, { inserted, undersized, unmeasured, varying });
  /* THE DECODE OUTRANKS THE SCREEN — see `decodeOverride`. Both dispositions
     are kept on the row when they differ, because "the bytes said recover and
     the decode said drop" is the single most useful thing a later reader of
     this file can be told. */
  /* AND THE GRID JOINS THEM — see `combineOverrides` for which wins when both
     speak. `grids` is null for every pool nobody has gridded, and a null index
     leaves the pair exactly as `decodeOverride` left it. */
  const override = combineOverrides(
    decodeOverride({ show_id: base.show_id, enclosure_host: base.enclosure_host }, decodes),
    gridOverride({ show_id: base.show_id }, grids),
  );
  const gridStatus = grids?.byShow.get(String(base.show_id))?.grid?.status ?? null;
  const disposition = override ? override.disposition : screened;
  const worst = maxDeltaSec(samples);

  /* AN INCOMING NOTE STILL WINS, which the docstring above promises and an
     earlier version of this line broke: "the feed would not load" explains a
     row better than any verdict drawn from the samples that failure prevented.
     The override's note is appended rather than dropped, so a row with both
     carries both. */
  let why = note && override ? `${note} — also: ${override.note}` : override ? override.note : note;
  if (!why && samples.length === 0) why = NO_DECLARED_LENGTH_REASON;
  /* A drop whose gap never changes size is the one drop most likely to be
     wrong, and the row has to say so — see `constantOffsetBytes`. Left as a
     bare `drop` it is indistinguishable from a show caught stitching, and on
     this pool it is 1,368 transcripts. */
  if (!why && constantOffset && disposition === "drop") {
    why =
      `every sampled episode differs from its declared length by the same ${constantOffset} bytes, across a much ` +
      `wider spread of episode sizes — a CONSTANT gap, not one proportional to the episode, which is not the ` +
      `shape most ad load has. It does not follow that the gap is innocent: ADR-0008 lists pre-roll-only as a ` +
      `real DAI configuration and a fixed-length pre-roll is also a constant offset, so a fixed metadata block ` +
      `(ID3v2 artwork is typically ~100KB) and a short house pre-roll fit these bytes equally well. ` +
      `impliedDeltaSec converts the gap at the audio bitrate because it assumes every byte is audio. ` +
      `Disposition left at drop deliberately — ADR-0008 decode-and-compare on one episode is what chooses`;
  }
  /* A repeat-probed show that never varied is BYTE-STABLE ACROSS REQUESTS and
     still not admitted — see `varyingSamples` on why stability does not acquit.
     Saying so is the difference between "nobody measured this" and "measured,
     and here is exactly what the measurement can and cannot conclude". Without
     it the two read identically as `unresolved`. */
  if (!why && repeats && !varying && summary.verdict === "unknown") {
    why =
      `${samples.length} episode(s) each probed ${repeats}x delivered a byte-identical length every time; this feed ` +
      `declares no enclosure length, so the ratio cannot run and stability across repeats is consistent with a ` +
      `static file AND with a stitcher that did not vary for us — ADR-0008 decode-and-compare settles it`;
  }
  if (!why && summary.reason) why = summary.reason;

  return {
    show_id: base.show_id,
    title: base.title,
    feed_host: base.feed_host,
    enclosure_host: base.enclosure_host,
    suspect_reason: base.suspect_reason,
    timed_transcripts: base.timed_transcripts,
    verdict: summary.verdict,
    disposition,
    ...(override && override.disposition !== screened
      ? { screened_disposition: screened, decided_by: override.decided_by || "decode-and-compare" }
      : {}),
    /* WAS THE GRID SPENT ON THIS ROW, AND WHAT DID IT SEE — recorded as data
       and given no power over anything. `gridOverride` is condemn-only by
       construction, so a `stable` grid leaves no trace in `disposition` or in
       `note`, and without this field the four flightcast shows the grid did NOT
       condemn are indistinguishable from four nobody asked. #324's whole point
       about `inconclusive` is that an unspent question and a spent one that
       came back negative are opposite facts a single absence renders
       identically. */
    ...(gridStatus ? { grid_status: gridStatus } : {}),
    median: summary.median,
    n: summary.n,
    inserted_samples: inserted,
    ...(unmeasured > 0 ? { unmeasured_samples: unmeasured } : {}),
    ...(repeats ? { repeats, varying_samples: varying } : {}),
    ...(spread ? { max_delivery_spread_bytes: spread } : {}),
    ...(constantOffset ? { constant_offset_bytes: constantOffset } : {}),
    max_delta_sec_implied: worst,
    tier: adrTier(worst),
    dai_by_chain: base.dai_by_chain ?? null,
    dai_via: base.dai_via ?? null,
    resolved_chain: base.resolved_chain || [],
    ...(undersized > 0 ? { undersized_samples: undersized } : {}),
    ...(why ? { note: why } : {}),
    samples,
  };
}

/* ------------------------------------------------ the decode, which outranks

   ADR-0008: "Where we can afford the download, decode-and-compare is the
   instrument; the ranged-GET ratio is a screen." Everything above this line is
   the screen. `tools/transcribe/decode-compare.mjs` is the instrument, and when
   the two disagree the instrument wins -- but ONLY in the specific ways below,
   because "a full download said so" is exactly the kind of authority that gets
   over-applied.

   THE READ IS OF A DATA FILE, NOT AN IMPORT. `decode-compare.mjs` imports
   `CONSTANT_OFFSET_TOLERANCE_BYTES` from this module, so importing it back
   would be a cycle. The decode ledger is JSON with a stable shape; consuming it
   as data keeps the dependency one-way and keeps these functions pure. */

/** Where the decode ledger lives, relative to the repo root. */
export const DECODE_REPORT_REL = join("data", "decode-and-compare.json");

/** A decode row proves the ranged GET wrong about THIS HOST when the bytes that
    actually arrived exceed the total the probe read out of `Content-Range`.

    THIS IS THE FINDING THAT FORCED THE FUNCTION, and it is worth stating in
    full because the whole scan above rests on the opposite assumption.
    ADR-0008 opens by recording that HEAD REQUESTS LIE on ad-inserting hosts --
    they return the ad-free master's `Content-Length` while a real GET delivers
    the assembled file -- and the 2-byte ranged GET was adopted precisely
    because it does not. On `atelier.flightcast.com` it does. The DOAC episode's
    `Content-Range` total read 67,510,022 on eleven separate probes across three
    days, and two independent unranged GETs each delivered 68,884,898 bytes:
    1,374,876 bytes, 114.4 s at the file's 96kbps, that the origin declares and
    does not send. An unranged GET declares the same short `Content-Length`, and
    a Range past the declared end 416s -- so the extra bytes are unreachable by
    ANY ranged request and invisible to this entire scan.

    WHAT IT COSTS: every byte figure this scan holds for that host is a master
    length rather than a delivery, so no show on it can be admitted on those
    bytes -- not even one whose numbers look perfect, because looking perfect is
    exactly what the lie produces. Hence `blindHosts` below. */
export function decodeUnderreports(row, toleranceBytes = CONSTANT_OFFSET_TOLERANCE_BYTES) {
  /* `probe_recorded_bytes` ONLY, with no fallback to the feed's declared
     length. A reviewer caught the fallback and it was a wide, silent hazard:
     `declared_bytes` is the publisher's `<enclosure length>`, not anything a
     ranged GET ever said, so an ordinary DAI show added to the target list
     without a probe figure -- delivering more than its feed declares, which is
     what injection LOOKS like -- would have marked its entire CDN blind and
     forced every other show on that host to `unresolved`. The two numbers
     answer different questions and only one of them is about the instrument. */
  const probed = row?.probe_recorded_bytes;
  const delivered = row?.comparison?.delivered_bytes;
  if (!Number.isFinite(probed) || !Number.isFinite(delivered)) return false;
  return delivered - probed > toleranceBytes;
}

/** Did the ranged GET and the wire agree about how big this file is?

    TRUE means the decode measured THE SAME OBJECT the screen measured, which is
    the precondition for a decode being allowed to speak for a show's other,
    un-downloaded episodes. Null when there is no probe figure to compare.

    TWO-SIDED, AND A REVIEWER WAS RIGHT TO INSIST. `decodeUnderreports` above is
    one-sided because it answers a different question -- "is this host sending
    more than it admits", the specific failure that makes byte evidence
    worthless. But for ACQUITTING a show, a disagreement in either direction is
    disqualifying for the same reason: the probe and the download did not fetch
    the same bytes, so whatever the download proves, it does not prove it about
    the object the screen judged. The first draft checked only the expensive
    direction, which meant an under-delivery was quietly treated as agreement --
    reasoning from the outcome we wanted rather than from the rule. */
export function probeCorroborated(row, toleranceBytes = CONSTANT_OFFSET_TOLERANCE_BYTES) {
  /* `probe_recorded_bytes` is copied from a hand-maintained constant in
     `decode-compare.mjs`'s TARGETS unless a `--probe-grid` run has refreshed it
     from an actual request, in which case the row records
     `probe_recorded_source: "probe-grid"`. Both are read the same way here --
     the field is the field -- but the distinction is worth naming, because a
     gate that guards every acquittal should not be satisfiable by editing a
     literal, and the grid is what makes it a measurement instead. */
  const probed = row?.probe_recorded_bytes;
  const delivered = row?.comparison?.delivered_bytes;
  if (!Number.isFinite(probed) || !Number.isFinite(delivered)) return null;
  return Math.abs(delivered - probed) <= toleranceBytes;
}

/** The decode ledger, indexed for the two questions the row builder asks. */
export function decodeIndex(report) {
  const byShow = new Map();
  const blindHosts = new Set();
  for (const row of report?.results || []) {
    const id = String(row.show_id ?? "");
    /* A DIAGNOSTIC ROW IS EVIDENCE ABOUT AN INSTRUMENT, NOT ABOUT A SHOW.
       `decode-compare.mjs` marks a target `diagnostic` when it deliberately
       fetches something other than the publisher's DECLARED enclosure URL --
       corner case #1's one sanctioned violation, used to ask which hop in a
       redirect chain changes a length. Keyed on `show_id` alone such a row
       would sit in the same bucket as the real one and be eligible to condemn
       or acquit the show on the strength of a URL no listener is ever served.
       It still counts toward `blindHosts` below, because what it observed
       about the HOST is exactly what it was fetched to observe. */
    if (id && !row.diagnostic) {
      if (!byShow.has(id)) byShow.set(id, []);
      byShow.get(id).push(row);
    }
    /* KEYED ON THE RESOLVED HOST, which for some CDNs is a per-NODE name
       (`dn720303.ca.archive.org`). That is deliberately narrow: marking a host
       blind withholds every show on it, so the key should name the thing
       actually observed and not a guess at how far the behaviour generalises.
       The cost is that a sibling node would have to be caught separately. */
    if (decodeUnderreports(row) && row.resolved_host) blindHosts.add(String(row.resolved_host).toLowerCase());
  }
  return { byShow, blindHosts };
}

/** What the decode says a row's disposition should be, or null to leave it.

    THREE RULES, and the asymmetry between them is deliberate -- it is the same
    asymmetry `dispositionOf` and `varyingSamples` already run on: positive
    evidence of a mechanism is proof, absence of it is a sample size.

    1. A DECODE THAT FOUND EXCESS OR SHORTFALL CONDEMNS, immediately and
       whatever the median said. `excess-audio` means the delivered file carries
       audio the publisher's own transcript does not describe, so every
       timestamp authored from that transcript is wrong by that much; a
       `short-of-transcript` file is a timeline describing a copy we are not
       receiving, which `AD_FREE_FLOOR` already calls disqualifying "for exactly
       the reason injection does". One observation is enough for both.

    2. A HOST CAUGHT UNDER-REPORTING TAKES ITS SHOWS' BYTE EVIDENCE WITH IT.
       The scan's samples for such a host are master lengths, not deliveries, so
       a show on it cannot be admitted on them however clean they look -- and
       "however clean they look" is not hypothetical: all five DOAC samples read
       within 0.5 s of the feed's own duration while the file carried 114 s
       more. Such a show needs `MIN_SAMPLES_FOR_AD_FREE` DECODED-clean episodes
       of its own, the same floor `summariseShow` already applies to ratios, and
       one is not two. Until then it is `unresolved` -- not a demotion, but the
       first honest statement of what is known about it.

    3. A CLEAN DECODE ON A TRUSTED HOST ACQUITS, because there the decode
       corroborates the screen rather than replacing it: the bytes that arrived
       matched the bytes the probe was told to expect, so the show's other
       samples mean what they say and the decode has settled the one thing the
       ratio could not. This is the Art Bell case exactly. */
export function decodeOverride(row, index) {
  if (!index) return null;
  const rows = index.byShow.get(String(row.show_id)) || [];
  const host = String(row.enclosure_host || "").toLowerCase();

  const bad = rows.find((r) => ["excess-audio", "short-of-transcript"].includes(r?.comparison?.verdict));
  if (bad) {
    const c = bad.comparison;
    /* WORDED FOR BOTH DIRECTIONS. A `short-of-transcript` row has a NEGATIVE
       `beyond_transcript_sec`, and the excess-only phrasing rendered it as
       "-490s this show's own transcript does not describe", which is not
       English and not the finding. */
    const short = c.beyond_transcript_sec < 0;
    return {
      disposition: "drop",
      note:
        "DECODED: " + c.decoded_sec + "s of audio against a transcript ending at " + c.last_cue_sec +
        "s and a feed declaring " + c.feed_duration_sec + "s — " +
        (short
          ? Math.abs(c.beyond_transcript_sec) + "s SHORTER than the timeline this show's own transcript describes"
          : c.beyond_transcript_sec + "s this show's own transcript does not describe") +
        ". ADR-0008 decode-and-compare on \"" + bad.episode +
        "\"; the ranged-GET screen above did not see it",
    };
  }

  /* CLEAN BY THE STRICTER OF THE TWO THRESHOLDS, which a reviewer caught and
     which was a real inconsistency rather than a nitpick. `TRAILING_ALLOWANCE_SEC`
     is 30 s -- audio past the last spoken cue that an outro explains -- while
     this file's own `INSERT_EVIDENCE_SEC` condemns a sample at 10 s. Left alone,
     a decode landing 11-30 s past the transcript would have ACQUITTED a show
     over a screen that condemns the identical delta, with the override being
     the path by which the looser number won. An instrument that outranks
     another must not also be more permissive than it. */
  const clean = rows.filter(
    (r) =>
      r?.comparison?.verdict === "matches-transcript" &&
      Math.abs(r?.comparison?.beyond_transcript_sec ?? Infinity) < INSERT_EVIDENCE_SEC,
  );
  if (index.blindHosts.has(host)) {
    /* ISSUES THE VERDICT RATHER THAN HANDING BACK, and an earlier version
       returned null here, which was wrong in the one direction that costs. Null
       means "the screen decides" -- and the screen's byte figures for this host
       are master lengths rather than deliveries, which is the entire reason the
       host is on this list. So two decoded-clean episodes would have UNBLOCKED
       evidence this function had just finished voiding, instead of standing on
       their own. On a blind host the decodes are the only witnesses there are;
       if there are enough of them they speak, and if there are not the row
       stays unresolved. */
    if (clean.length >= MIN_SAMPLES_FOR_AD_FREE) {
      const ok = clean[0];
      return {
        disposition: "recover",
        note:
          `DECODED CLEAN ${clean.length}x on a host whose Content-Range cannot be trusted (${host}): ` +
          `${ok.comparison.decoded_sec}s of audio against a transcript ending at ${ok.comparison.last_cue_sec}s. ` +
          `Admitted on the decodes alone — this host's byte figures are master lengths and took no part`,
      };
    }
    return {
      disposition: "unresolved",
      note:
        host + " was caught delivering more bytes than its Content-Range declares, so every byte figure above " +
        "is a master length rather than a delivery and cannot admit this show. " +
        (clean.length
          ? clean.length + " episode decoded clean, below the " + MIN_SAMPLES_FOR_AD_FREE + "-sample floor"
          : "no episode of this show has been decoded") +
        /* NAMES BOTH INSTRUMENTS, and the sentence was false in two directions
           until it did. It read "decode-and-compare is the ONLY instrument that
           can settle it", which (a) `combineOverrides` then concatenated
           directly after a probe grid that had just settled it, producing a row
           that contradicted itself inside one sentence, and (b) was already
           wrong the moment #323 shipped `probeGrid` — four requests and no body
           against a 60 MB download. It stays accurate standing alone, which is
           the form the shows the grid did NOT condemn still carry. */
        " — settling it needs ADR-0008 decode-and-compare, or a probe grid that catches the assembly",
    };
  }

  /* AND ONLY ON A ROW WHOSE BYTES THE PROBE CORROBORATED. Without this, a
     decode is allowed to acquit a show on the strength of an object the screen
     never saw -- which is exactly the Art Bell trap: that row's probe figure
     was 99,303 bytes away from what the wire delivered, because the enclosure
     had stopped resolving to the host the scan measured. Returning null rather
     than a verdict is deliberate: a decode of a different object is not
     evidence against the show either, so the screen's own conclusion stands
     untouched and the decode stays on the record in
     `data/decode-and-compare.json` for a human to read. */
  const corroborated = clean.filter((r) => probeCorroborated(r) === true);
  if (corroborated.length > 0) {
    const ok = corroborated[0];
    return {
      disposition: "recover",
      note:
        "DECODED CLEAN: " + ok.comparison.decoded_sec + "s of audio against a transcript ending at " +
        ok.comparison.last_cue_sec + "s — " + ok.comparison.beyond_transcript_sec +
        "s of trailing audio, and the delivered bytes matched what the ranged GET declared. " +
        "ADR-0008 decode-and-compare on \"" + ok.episode + "\"",
    };
  }
  return null;
}

/* ------------------------------------------------------------- the grid

   A THIRD INSTRUMENT, AND THE CHEAPEST OF THE THREE. The screen above divides a
   delivered length by a declared one. The decode downloads the file and counts
   the audio. `probeGrid` (#323, driven over a pool by `regrid-clean.mjs`) does
   neither: it asks ONE URL for its length four ways — 2-byte ranged GET and
   unranged, under each of the two outbound identities — and reports whether the
   answers agree. Four requests, no body, no download.

   IT CAN ONLY EVER CONDEMN, and that asymmetry is the whole of its licence.
   Two different lengths for one URL mean two resources, and a file assembled
   per request is what dynamic insertion IS — the same reasoning `varyingSamples`
   and `dispositionOf`'s first branch already run on. Agreement proves only that
   this delivery path does not lie the way `atelier.flightcast.com` does, which
   `regrid-clean.mjs`'s own `verdictNote` says in words; #323's bare-chain
   control returns four identical cells ON THE LYING ORIGIN and stays
   `unresolved`. So `gridOverride` returns `drop` or null and has no third
   branch, by construction rather than by policy.

   AGAIN AS DATA, NOT AS AN IMPORT, for the reason `DECODE_REPORT_REL` gives:
   `regrid-clean.mjs` imports `probeTargets` from this module, so importing it
   back would be a cycle. */

/** Where the probe-grid ledgers live, relative to the repo root — see
    `ledgers.mjs`, which now owns the list. Re-exported rather than moved out of
    this module's surface, because `measure-suspects.test.mjs` imports it from
    here and the list's readers should not have to know which file holds it. */
export { GRID_REPORT_RELS, MEASURED_REPORT_RELS };

/** The grid ledgers, indexed by show. Later files win on a repeated `show_id`.

    KEYED ON `show_id` AND NEVER ON HOST, and on this pool that is not a
    formality. `_adswizz_note` in `dai-hosts.json` sets the rule — "one insert on
    one show is evidence about that show, not a platform-wide claim" — and the
    flightcast pass MEASURED it: of the six shows on `atelier.flightcast.com`,
    two are served a longer file on the client/unranged cell and four are served
    one length in all four cells. A host-keyed index would have condemned all
    six on the strength of two, which is precisely the aggregation #321 found
    wrong on blubrry (9 clean / 1 dirty) and libsyn (4/4).

    LAST FILE WINS so a later, narrower pass supersedes an earlier one for the
    shows it re-probed, matching how `--resume` replaces rows by `show_id`.
    "Last" means LAST IN `GRID_REPORT_RELS`, not most recently written: the
    order is the hand-maintained array below and nothing here reads a timestamp.
    A new ledger therefore has to be APPENDED — inserted above an existing one
    it would be silently overruled by older evidence for any show they share. */
export function gridIndex(reports) {
  const byShow = new Map();
  for (const report of reports || []) {
    for (const r of report?.results || []) {
      if (r?.show_id == null || !r.grid) continue;
      byShow.set(String(r.show_id), r);
    }
  }
  return { byShow };
}

/** What the grid says about a row's disposition, or null to leave it alone.

    ONE RULE AND NO OTHERS. `grid.status === "varies"` means at least one probed
    episode was served more than one length for a single URL. Everything else —
    `stable`, `inconclusive`, no row at all — returns null, because none of them
    is evidence about the show in the direction that could move it. A null index
    changes nothing, which is the state of every pool nobody has gridded. */
export function gridOverride(row, index) {
  if (!index) return null;
  const r = index.byShow.get(String(row?.show_id));
  if (r?.grid?.status !== "varies") return null;
  /* PAIRS, NOT THE UNION. `varying_pairs` is one entry per varying episode and
     each entry is the two lengths ONE url was served; `varying_totals` pools
     them, so a three-episode show reads as a single URL with six lengths. See
     `showGridVerdict`. The fallback is for rows written before the field
     existed — none of which vary, so it is unreachable on today's evidence and
     is here so a stale artifact degrades to the pooled form rather than to a
     note with no numbers in it at all. */
  const pairs = r.grid.varying_pairs?.length ? r.grid.varying_pairs : [(r.grid.varying_totals || []).join(" / ")];
  return {
    disposition: "drop",
    /* NAMED ON THE OVERRIDE rather than stamped by the row builder, which used
       to hardcode `decided_by: "decode-and-compare"` for whatever moved a row.
       With a second instrument that string would have credited 1,914
       transcripts of grid evidence to a download that was never spent — and
       `decided_by` is the field a reader consults to find out what to re-run. */
    decided_by: "probe-grid",
    note:
      "PROBE GRID: " + r.grid.varying_episodes + " of " + r.grid.episodes_probed +
      " probed episode(s) were served MORE THAN ONE LENGTH for a single URL depending only on how the " +
      "request was made (" + pairs.join("; ") + " bytes — one entry per episode, each entry the distinct " +
      "lengths ONE url was served). More than one length for one URL means more than one resource, " +
      "which is per-request assembly — #323's finding, measured on this show. No body was read: four " +
      "requests per episode and the unranged calls aborted at their headers",
  };
}

/** How the decode and the grid are combined when both have something to say.

    THEY CANNOT SIMPLY BE OR-ed, and the order matters in one direction only.

    THE GRID NEVER OVERTURNS A DECODE THAT ALSO CONDEMNS — it corroborates it,
    and the decode's note is the one worth keeping because it is denominated in
    SECONDS OF AUDIO against the show's own transcript, which is the thing a
    later reader needs. The grid's contribution is recorded beside it rather
    than replacing it.

    THE GRID SETTLES A DECODE THAT SAID `unresolved`, and this is the branch
    every row on today's evidence takes. `decodeOverride`'s rule 2 withholds
    every show on a host caught under-reporting — that is why six flightcast
    shows sat `unresolved` — while saying "decode-and-compare is the only
    instrument that can settle it". The grid is a second one, four requests
    instead of a 60 MB download, and where it sees the mechanism it has settled
    exactly that. Calling this an override would misdescribe it: `unresolved` is
    not a finding to be overturned.

    THE GRID DOES OVERTURN A DECODE THAT ACQUITS, which is the one genuinely
    contested case. `decodeOverride`'s rule 3 admits a show on one clean decode
    of one episode; if the grid then catches that show's URLs being assembled
    per request, the decoded copy was ONE ASSEMBLY and the acquittal rested on a
    sample of one drawn from a distribution. Positive evidence of a mechanism
    outranks an acquittal built on its absence — the asymmetry stated in
    `decodeOverride`'s own header and in `varyingSamples`. Nothing in today's
    evidence hits this branch (no show carries both), and it is written down
    rather than left to whichever `||` happened to come first. */
export function combineOverrides(decode, grid) {
  if (!grid) return decode || null;
  if (!decode) return grid;
  if (decode.disposition === "drop") {
    return {
      ...decode,
      decided_by: "decode-and-compare (probe grid corroborating)",
      note: `${decode.note} — CORROBORATED by the probe grid: ${grid.note}`,
    };
  }
  if (decode.disposition === "unresolved") {
    return {
      ...grid,
      decided_by: "probe-grid",
      note: `${grid.note}. This SETTLES what the decode ledger could not: ${decode.note}`,
    };
  }
  return {
    ...grid,
    decided_by: "probe-grid (over decode-and-compare)",
    /* THE OVERRULED DECODE'S NOTE IS KEPT, NOT PARAPHRASED. An earlier version
       interpolated only `decode.disposition` into a sentence and dropped the
       note, which lost the decode's seconds-of-audio entirely — and on this
       branch `screened_disposition` records the SCREEN, so the decode's finding
       would have left no trace on the row at all. `deriveRow` states the rule
       this violates: "the bytes said recover and the decode said drop" is the
       single most useful thing a later reader can be told, and the branch that
       DISAGREES with a decode is the one where that is most true. */
    note:
      `${grid.note}. This OVERRIDES the decode ledger's "${decode.disposition}" for this show — ` +
      `a decode reads one assembly, and the grid caught the assembling. The overruled decode said: ` +
      `${decode.note}`,
  };
}

/** Has this row already cost the requests that would answer it?

    STRICTER THAN "HAS A DISPOSITION", AND STRICTER THAN "HAS A SAMPLE", because
    both weaker rules freeze a transient failure into a permanent verdict — the
    exact thing `--resume` exists to avoid.

    "Has a disposition" is too weak: a row whose feed would not load gets
    `unresolved` with no samples at all, and skipping it means one bad minute on
    one feed host becomes a verdict nobody re-checks.

    "Has at least one sample" is ALSO too weak, and a reviewer caught that the
    comment claiming otherwise was wrong. The probe loop pushes a sample for
    every episode it attempts, INCLUDING total failures: `probeEpisode` exhausts
    its retry ladder and returns `{ratio: null, delivered_bytes: null,
    error: "HTTP 503"}`, which the loop records. A show whose host was rate-
    limiting during the run therefore ends with five error samples, a
    disposition of `unresolved`, and permanent immunity from every later
    `--resume`.

    So a row is settled when at least one probe actually came back with a
    PLAUSIBLE length to measure — `isPlausibleAudioSize`, the same floor
    `plausibleDeliveries` uses, and for the same reason. `n > 0` was the first
    version of this line and it reintroduced the bug one screen up: a 403 or a
    404 is not retried, so `probeEpisode` returns the ERROR BODY's Content-Length
    as `delivered_bytes`. Under `n > 0` a show whose every probe drew a 404 —
    which `ad-inflation.mjs`'s own header records happening to Captivate — reads
    as five successful measurements and is skipped by every later `--resume`.
    That is the freeze this function exists to prevent, wearing the costume of
    the fix. That covers the feed-level failure, the probe-level failure, and
    the no-declared-length case (which produces no samples at all and must be
    re-probeable under `--repeat`), while a genuinely measured row — including a
    repeat-probed one, whose `delivered_bytes` is populated even though its
    ratio is null — is never asked for twice. */
export function isSettled(row) {
  if (!row || !row.disposition) return false;
  return (row.samples || []).some((s) => isPlausibleAudioSize(s?.delivered_bytes));
}

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
    a `filter`, not a sort — but it is a deliberate one.

    `requireDeclaredLength: false` LIFTS THE DENOMINATOR RULE, and only the
    repeat probe may ask for it. The rule above is right whenever the RATIO is
    the instrument: without a declared length that sample can only ever come
    back `unknown`, so probing it spends a real request to learn nothing.
    `--repeat` changes what the instrument is — it compares a URL's delivered
    length against ITSELF across requests, and that comparison needs no feed
    declaration at all. Measured on this pool: all seven `atelier.flightcast.com`
    shows — 5,461 timed transcripts, 47% of the corpus — publish `<enclosure>`
    with no `length` attribute on every one of their 200 indexed episodes. Under
    the denominator rule they yield zero targets and the scan says "could not
    tell" about half the supply. `main` lifts it exactly when repeats are on and
    never otherwise. */
export function probeTargets(episodes, perShow, { requireDeclaredLength = true } = {}) {
  const out = [];
  for (const ep of episodes || []) {
    if (out.length >= perShow) break;
    if (!ep.enclosure_url) continue;
    if (!ep.has_timestamps) continue;
    if (requireDeclaredLength && (!Number.isFinite(ep.enclosure_bytes) || ep.enclosure_bytes <= 0)) continue;
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

    IMPORTED, not "imported in spirit". That phrase is what this docstring said
    beside a literal `120` — and it is the phrase that precedes every one of the
    six duplicated-implementation incidents this repo has paid for. A reviewer
    pointed out `ANCHOR_TIME_TOLERANCE_SEC` is already exported from
    `merge-segments.mjs`, which is where ADR-0008 takes the number from, so
    there was never anything to restate. Used for REPORTING only. */
export const PADDABLE_CEILING_SEC = ANCHOR_TIME_TOLERANCE_SEC;

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

/** The repeat observations of one episode that are big enough to BE an episode.

    A REVIEWER FOUND THE BUG THIS CLOSES, and it was the worst one available
    here. `probeEpisode` reads `delivered_bytes` from `Content-Range` OR a bare
    `Content-Length`, and it deliberately does not retry a 403/404/410 — those
    are answers, not hiccups. So an error page's `Content-Length` is a small
    positive integer that lands in `deliveries` looking exactly like a
    measurement. One 404 in the middle of a repeat run turns
    `[41146837, 1136, 41146837]` into "this episode delivered two different
    lengths", `varyingSamples` returns 1, and `dispositionOf` reads variance
    FIRST — so a show is condemned as a stitcher by our own failed request. On
    Success Story that is 1,264 transcripts. `ad-inflation.mjs`'s own header
    records Buzzsprout answering 403 and Captivate 404 on precisely these
    probes, so this is a live path and not a hypothetical.

    `isPlausibleAudioSize` IS IMPORTED RATHER THAN RE-DERIVED. It exists for
    this exact failure — its docstring says "One host returned 2 bytes for a
    HEAD during the first probe" — and the first version of the code above
    reinvented it as a weaker `n > 0`. That is the seventh duplicated
    implementation this repo would have shipped, and it would have been a copy
    that disagreed with the original in the direction that destroys supply. */
export function plausibleDeliveries(sample) {
  return (sample?.deliveries || []).filter((n) => isPlausibleAudioSize(n));
}

/** Samples where ONE episode's URL delivered two different file lengths.

    ADR-0008's OWN INSTRUMENT, not a new one. That ADR is explicit that a
    statistic taken across DIFFERENT episodes is "the wrong axis" and that
    bounding what a host does needs `N >= 2 probes of the SAME episode`; it
    records two probes of one Gastropod episode hours apart disagreeing by
    33.4 s. `NO_DECLARED_LENGTH_REASON` already names decode-and-compare as the
    follow-up a feed with no `length` attribute needs. This is the cheap half of
    that: same URL, same GUID, N ranged GETs spaced by the host gate, and the
    total out of `Content-Range` compared against itself.

    WHY IT HAD TO EXIST. The ratio needs a denominator the publisher publishes,
    and 47% of this corpus has no such publisher. All seven
    `atelier.flightcast.com` shows omit `<enclosure length>` entirely, so
    `inflationRatio` returns null for every episode of all of them and the
    verdict vocabulary can only say `unknown`. Half the supply would have stayed
    inferred not because it is ambiguous but because the instrument was pointed
    at a number nobody wrote down.

    ASYMMETRIC, AND THAT ASYMMETRY IS THE WHOLE DISCIPLINE HERE.
    Content-Range's total is the length of the resource being served. Two
    different totals for one URL mean two different resources, which means the
    file is assembled per request — that is what dynamic ad insertion IS, and it
    is proof, not a threshold. So variance CONDEMNS.
    Stability does NOT acquit. A stitcher may key its decision on session, IP or
    time and hand the same client the same stitch inside a cache window, so N
    identical answers are consistent with a static file AND with a host that
    simply did not vary for us. `dispositionOf` therefore reads this only in the
    `drop` direction; a byte-stable no-length show stays `unresolved`, which is
    the honest verdict and the one `NO_DECLARED_LENGTH_REASON` already gives.

    THE ONE INNOCENT EXPLANATION, recorded rather than assumed away: if the
    redirect chain resolved to a DIFFERENT episode between probes, the lengths
    would differ for a reason that is not insertion. Every probe here is the
    same feed URL for the same GUID within a couple of minutes, and the resolved
    chain is recorded on the row, so the claim is checkable. It is also the less
    likely reading: a chain that serves a different episode per request is a
    worse problem for anchoring than ads are. */
export function varyingSamples(samples) {
  return (samples || []).filter((s) => {
    const seen = plausibleDeliveries(s);
    return seen.length >= 2 && new Set(seen).size > 1;
  }).length;
}

/** The widest disagreement one episode's repeats showed, in bytes.

    Reported, never gated on — the same rule `maxDeltaSec` is written under.
    A spread is what makes "this host stitches" legible as a quantity: a
    9.4MB spread on one episode is the ~30 s slot count, not a rounding
    artefact, and it is the number that tells a reader whether to believe the
    row without re-running the scan. */
export function maxDeliverySpread(samples) {
  let worst = 0;
  for (const s of samples || []) {
    const seen = plausibleDeliveries(s);
    if (seen.length < 2) continue;
    worst = Math.max(worst, Math.max(...seen) - Math.min(...seen));
  }
  return worst || null;
}

/** The widest two episode deltas may differ and still read as "the same". */
export const CONSTANT_OFFSET_TOLERANCE_BYTES = 1024;

/** A byte gap that is the SAME SIZE on every episode, whatever the episode.

    REPORTED, NEVER GATED ON — the rule `adrTier` and `impliedDeltaSec` are
    written under. Nothing below changes a disposition, and a reviewer confirmed
    that by inspection: the value reaches the `note` and the committed row and
    nothing else.

    WHAT IT SEPARATES. Ad load usually scales with the episode, and every
    obviously-injecting show in this pool shows it doing so: Snail Trail 4x4
    delivers +811,065 bytes on three episodes, +1,498,237 on a fourth and
    -870,068 on a fifth. The Art Bell Archive instead delivers +99,324 / +99,387
    / +99,331 / +99,303 / +99,319 over five episodes running 51.9MB to 56.5MB —
    an 84-byte spread across a 4.6MB spread in episode size. Those are two
    different shapes and only one of them is what `impliedDeltaSec` assumes.

    IT DOES NOT SAY THE GAP IS INNOCENT, AND AN EARLIER VERSION OF THIS COMMENT
    DID. A reviewer caught the overreach against ADR-0008 itself, which lists
    **pre-roll only** as a real DAI configuration and says of it, in as many
    words, that "every break is at `t = 0`, so `cum(t)` is the same constant"
    everywhere. A fixed-length house pre-roll is therefore ALSO a constant byte
    offset. So what this function distinguishes is "constant" from
    "proportional" — not "metadata" from "ads". Art Bell's ~99KB is about 16 s
    at its bitrate, which is a plausible ID3v2 artwork block AND a plausible
    short pre-roll, and nothing measurable here chooses between them.

    WHY THE DISPOSITION IS LEFT ALONE. Both readings are consistent with the
    bytes, one of them is ads, and only a decode can tell — ADR-0008's
    decode-and-compare, on one episode. Re-admitting 1,368 transcripts on the
    flattering reading is the exact move #319 measured and found wanting: six of
    seven shows inferred anchorable were injecting. The row keeps `drop` and
    carries the number a founder needs in order to ask for the decode.

    THREE SAMPLES MINIMUM, the offset must exceed the tolerance, and the episode
    sizes must differ by several times the offset. Two agreeing deltas is a
    coincidence. An offset SMALLER than the band we are willing to call "the
    same" is not distinguishable from zero — without that guard, two committed
    `recover` rows carried offsets of 429 and 434 bytes, where a 1024-byte
    tolerance makes "constant" vacuous and a `4 x 429` spread guard is satisfied
    by any two different episodes; a finding-shaped field that means nothing is
    worse than no field. It also removes the `lo = -500, hi = 500` case, which
    returned a literal 0 that every consumer survived only because 0 is falsy.
    And if every episode is the same size, "constant in bytes" and "proportional
    to duration" are the same observation, so this could not tell ads from tags
    even in principle — a daily show of ~20-minute episodes is exactly that. */
export function constantOffsetBytes(samples) {
  const deltas = [];
  const sizes = [];
  for (const s of samples || []) {
    if (!Number.isFinite(s.declared_bytes) || !Number.isFinite(s.delivered_bytes)) continue;
    deltas.push(s.delivered_bytes - s.declared_bytes);
    sizes.push(s.declared_bytes);
  }
  if (deltas.length < 3) return null;
  const lo = Math.min(...deltas);
  const hi = Math.max(...deltas);
  if (hi - lo > CONSTANT_OFFSET_TOLERANCE_BYTES) return null;
  const offset = Math.round((lo + hi) / 2);
  if (Math.abs(offset) <= CONSTANT_OFFSET_TOLERANCE_BYTES) return null;
  if (Math.max(...sizes) - Math.min(...sizes) < Math.abs(offset) * 4) return null;
  return offset;
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
export function dispositionOf(verdict, { inserted = 0, undersized = 0, unmeasured = 0, varying = 0 } = {}) {
  /* FIRST, because it is the only branch here that rests on positive evidence
     of the mechanism rather than on a comparison with a number the publisher
     supplied. See `varyingSamples`. A show whose ratio could not be computed at
     all still reaches `verdict === "unknown"` and would fall to `unresolved`
     one line down; catching a host assembling a different file per request is
     an answer, and an answer outranks "could not tell". */
  if (varying > 0) return "drop";
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
  /* Same fail-loud rule as `--per-show`, for the same reason: a NaN bound
     silently selects nothing, and a scan that made no requests reports every
     show as "could not tell" without anything on the row saying why. */
  const intOrNull = (flag) => {
    const raw = get(flag, null);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer, got ${raw}`);
    return n;
  };
  const pool = get("--pool", "suspects");
  if (pool !== "suspects" && pool !== "anchorable") {
    throw new Error(`--pool must be "suspects" or "anchorable", got ${pool}`);
  }
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
    pool,
    /* DEFAULTED PER POOL, so a run cannot silently overwrite the other pool's
       evidence. #319's file is the record for the suspects and #321's is the
       record for the rest; one path serving both would mean whichever ran last
       erased the other, and `breadth-yield.mjs` reads BOTH. */
    out: get("--out", pool === "anchorable" ? "data/breadth-anchorable-inflation.json" : "data/breadth-suspect-inflation.json"),
    limit: intOrNull("--limit"),
    minTranscripts: intOrNull("--min-transcripts") ?? 1,
    /* HOW MANY TIMES EACH EPISODE IS ASKED FOR — ADR-0008's `N >= 2 probes of
       the SAME episode`. 1 is #319's behaviour and stays the default: repeats
       multiply the request count by N and are only worth spending where the
       ratio cannot run. See `varyingSamples`. */
    repeat: intOrNull("--repeat") ?? 1,
    hosts: String(get("--host", "")).split(",").map((s) => s.trim()).filter(Boolean),
    /* Measurement files whose settled shows this run must not re-probe — see
       `selectPool`. A missing path is skipped rather than fatal, because a
       checkout that has never run either scan must still be able to run this
       one.

       DEFAULTS TO EVERY COMMITTED LEDGER, which is a fix rather than a
       widening. It used to name #319's file alone, so `--pool anchorable`
       taking its defaults treated the 41 shows #321 settled as unmeasured and
       re-spent their probes; the pool that has to be skipped is "everything
       anybody has measured", and that is exactly what `MEASURED_REPORT_RELS`
       is.

       NARROW IT WITH `--settled` ITSELF WHEN RE-MEASURING IS THE INTENT, and
       NOT with `--reprobe`, which cannot reach these rows. `--reprobe` only
       keeps the `--resume` `done` set empty; `settled` removes shows from
       `selectPool` before that set is ever consulted, so a show settled in a
       DIFFERENT ledger is filtered out and no amount of `--reprobe` brings it
       back. Pass the narrower `--settled` list explicitly. */
    settled: String(get("--settled", MEASURED_REPORT_RELS.join(","))).split(",").map((s) => s.trim()).filter(Boolean),
    /* An interrupted run must not cost the requests it already spent. The
       output is rewritten after every show, so `--resume` reads back what
       landed and skips those show_ids.

       IT SKIPS ONLY ROWS THAT ACTUALLY SAMPLED SOMETHING, which is stricter
       than "has a disposition" and had to be. A show whose feed was momentarily
       unreadable, and a show every episode of which was filtered out for
       declaring no length, BOTH get `disposition: "unresolved"` and zero
       samples. Skipping on the disposition alone would freeze a transient
       network failure into a permanent verdict, and would make it impossible to
       re-run the no-length shows under `--repeat` — which is the one mode that
       can answer them. A row with no samples cost one feed request; re-spending
       that is the cheap side of the trade. */
    resume: argv.includes("--resume"),
    /* Measure the selected shows again even if they are already settled. The
       reason it exists: when the INSTRUMENT changes, committed evidence
       gathered by the old one is stale in a way `--resume` is designed not to
       notice. Narrow it with `--host` or `--limit`; on its own it re-spends the
       whole pool. */
    reprobe: (() => {
      /* REFUSED WITHOUT `--resume`, because on its own it is silently
         destructive rather than merely useless. `--reprobe` is read only inside
         the resume branch, so without it nothing is re-probed — but the run
         still rewrites the output with only its own rows, deleting every
         out-of-scope prior row. That is the exact loss the keyed carry-forward
         was written to prevent, and `--reprobe` is the flag most likely to be
         paired with a narrowing `--host`. */
      if (!argv.includes("--reprobe")) return false;
      if (!argv.includes("--resume")) {
        throw new Error("--reprobe requires --resume; without it the run would rewrite the output with only the shows it re-probed");
      }
      return true;
    })(),
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(resolvePath(process.cwd(), args.yieldPath), "utf8"));
  const feedById = new Map((report.shows || []).map((s) => [String(s.show_id), s.feed_url]));

  const gross = report.yield?.breadth_all?.anchorable_timed_transcripts ?? null;
  const net = report.anchorable_net_of_suspects ?? null;

  /* THE DECODE LEDGER, LOADED ONCE AND INJECTED. Absent on a fresh checkout and
     absent for every pool nobody has spent a download on, which is the common
     case — `decodeOverride` is written so that a null index changes nothing at
     all, and the suite pins that. */
  const decodePath = join(ROOT, DECODE_REPORT_REL);
  const decodes = existsSync(decodePath)
    ? decodeIndex(JSON.parse(readFileSync(decodePath, "utf8")))
    : null;
  if (decodes) {
    console.log(
      `decode ledger: ${decodes.byShow.size} show(s) measured by full download` +
        (decodes.blindHosts.size ? `; ranged GET proven blind on ${[...decodes.blindHosts].join(", ")}` : ""),
    );
  }

  /* THE GRID LEDGERS, LOADED THE SAME WAY AND FOR THE SAME REASON. Absent on a
     fresh checkout; `gridOverride` is written so a null index changes nothing,
     and the suite pins that. */
  const gridPaths = GRID_REPORT_RELS.map((rel) => join(ROOT, rel)).filter((p) => existsSync(p));
  const grids = gridPaths.length ? gridIndex(gridPaths.map((p) => JSON.parse(readFileSync(p, "utf8")))) : null;
  if (grids) {
    const varying = [...grids.byShow.values()].filter((r) => r.grid?.status === "varies");
    console.log(
      `probe grids: ${grids.byShow.size} show(s) asked how big one URL is four ways; ` +
        `${varying.length} served more than one length for a single URL`,
    );
  }

  const outPath = resolvePath(process.cwd(), args.out);
  const settled = new Set();
  for (const p of args.settled) {
    const abs = resolvePath(process.cwd(), p);
    if (abs === outPath || !existsSync(abs)) continue;
    for (const r of JSON.parse(readFileSync(abs, "utf8")).results || []) {
      if (r?.show_id != null && r.disposition) settled.add(String(r.show_id));
    }
  }
  const pool = selectPool(report, {
    pool: args.pool,
    limit: args.limit,
    minTranscripts: args.minTranscripts,
    hosts: args.hosts,
    settled,
  });

  /* Carried forward rather than re-probed. See `--resume` in `parseArgs`. */
  /* KEYED, NOT APPENDED, and a reviewer found why it had to be. The output is
     rewritten in full every time, so a `--resume` run that carried forward only
     the rows it considered settled DELETED every other prior row — run the full
     pool, then resume with `--host` narrowed, and the out-of-scope rows are
     neither carried nor re-probed and simply vanish, while `requests` goes on
     claiming the cost of evidence the file no longer holds. Every prior row is
     kept; the ones this run re-probes are replaced by show_id. */
  const carried = new Map();
  const done = new Set();
  /* CARRIED FORWARD, not reset. The file's `requests` block is what the PR body
     quotes as the cost of the evidence, and a resumed run that reported only
     its own tail would understate a two-pass measurement by hundreds of
     requests — reading, to anyone auditing politeness later, as though the
     evidence were far cheaper to obtain than it was. */
  const priorRequests = { feeds: 0, ranged_gets: 0 };
  const passes = [];
  if (args.resume && existsSync(outPath)) {
    const prior = JSON.parse(readFileSync(outPath, "utf8"));
    priorRequests.feeds = prior.requests?.feeds || 0;
    priorRequests.ranged_gets = prior.requests?.ranged_gets || 0;
    /* PROVENANCE ACCUMULATES LIKE THE REQUEST COUNT DOES. `source` used to
       describe only the last invocation, so the committed file said
       `per_show: 5` with no `repeat` beside 8 rows carrying `repeats: 3` and a
       cumulative 367 requests — a provenance block that could not be reconciled
       with the evidence it was attached to. */
    /* Zero-work entries are dropped on the way in as well as on the way out: a
       re-derive pass makes no request, and a provenance list padded with
       records of nothing obscures the passes that did cost something. */
    passes.push(...(prior.source?.passes || []).filter((x) => (x.feeds || 0) || (x.ranged_gets || 0)));
    for (const r of prior.results || []) {
      if (r?.show_id == null || !r.disposition) continue;
      /* RE-DERIVED, not copied. See `deriveRow`: the samples are the evidence
         and everything else is an opinion about them, so a row measured by an
         earlier pass must be re-judged by today's rules rather than carried
         forward under yesterday's. Copying it would let one file hold rows
         judged by two standards, with nothing on them saying which — and it
         would silently freeze out any signal added since. No request is made:
         this reads bytes already committed. */
      carried.set(String(r.show_id), deriveRow(r, { note: fetchNoteOf(r), decodes, grids }));
      if (isSettled(r) && !args.reprobe) done.add(String(r.show_id));
    }
    console.log(
      `--resume: ${carried.size} prior row(s) in ${args.out}, ${done.size} settled ` +
        `(${priorRequests.feeds} feed + ${priorRequests.ranged_gets} ranged GET already spent)` +
        (args.reprobe ? "; --reprobe: every selected show is measured again" : ""),
    );
    console.log("");
  }
  const todo = pool.filter((s) => !done.has(String(s.show_id)));

  console.log(
    `pool "${args.pool}": ${pool.length} show(s), ${pool.reduce((n, s) => n + s.timed_transcripts, 0)} timed transcripts ` +
      `(${gross} anchorable as classified, ${net} net); ${todo.length} to probe\n`,
  );
  if (args.pool === "anchorable") {
    /* THE POOL'S OWN TOTALS, which under `--limit` are deliberately NOT the
       totals the ordering used: `selectPool` ranks hosts over every candidate
       row and this reports what will actually be probed. Two scopes, one
       function, and saying so is the difference between a discrepancy and a
       bug. */
    for (const [h, n] of [...hostTotals(pool)].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)} timed  ${h}`);
    }
    console.log("");
  }

  /* --dry-run STOPS HERE, BEFORE THE FIRST REQUEST, and until #326 it did not.
     It gated only `writeReport()` at the bottom of the loop, so a "dry" run
     fetched every feed and spent every ranged GET and then threw the answers
     away — the most expensive way to ask a question this repo has. The flag was
     reached for to preview this exact pool and cost ~3 minutes of a publisher's
     patience for nothing.

     THE NAME ALREADY PROMISED THIS, and its sibling already delivers it:
     `regrid-clean.mjs --dry-run` prints the pool and returns 0 without opening a
     socket. Two files in one directory, one flag name, opposite costs, and the
     expensive one is the one you would reach for to check before spending. A
     preview that spends the budget is not a preview.

     The pool, its host totals and the `todo` count are all printed above, which
     is everything the flag was ever used to see. */
  if (args.dryRun) {
    for (const s of todo) {
      console.log(`  ${String(s.timed_transcripts).padStart(5)} timed  ${String(s.enclosure_host).padEnd(28)} ${s.title}`);
    }
    console.log(
      `\n--dry-run: ${todo.length} show(s) would be probed at up to ${args.perShow} episode(s) each` +
        `${args.repeat > 1 ? ` x${args.repeat} repeats` : ""} — no request made, no file written.`,
    );
    return;
  }

  const started = Date.now();
  let requests = 0;
  let feedRequests = 0;
  /* Counted as it happens, not taken from `todo.length`: the mid-loop
     checkpoint writes this block too, and a crashed run must not record that it
     probed a list it had only planned. */
  let probedCount = 0;

  for (const s of todo) {
    probedCount++;
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

    const probed = probeTargets(episodes, args.perShow, { requireDeclaredLength: args.repeat < 2 });
    for (const ep of probed) {
      /* REPEATS OF THE SAME URL, spaced by the host gate exactly like any other
         request — `awaitHostSlot` is inside `probeEpisode`, so N repeats are N
         gated requests and not a burst. The FIRST is the one the ratio is taken
         from; the rest exist only to be compared with it.

         SPENT ONLY WHERE THE RATIO CANNOT RUN. An earlier version repeated
         every probed episode in a repeat run, which a reviewer noted made
         `--repeat 3` over the full pool cost 3x on 33 shows whose declared
         length already answers the question — the docstring's "only worth
         spending where the ratio cannot run" was operator discipline rather
         than an invariant. It is an invariant now: an episode that declares a
         length is probed once, whatever `--repeat` says. */
      const repeats = Number.isFinite(ep.enclosure_bytes) && ep.enclosure_bytes > 0 ? 1 : Math.max(1, args.repeat);
      const runs = [];
      for (let i = 0; i < repeats; i++) {
        const p = await probeEpisode(ep.enclosure_url, ep.enclosure_bytes);
        requests += p.attempts;
        runs.push(p);
      }
      const p = runs[0];
      const deliveries = runs.map((r) => r.delivered_bytes);
      samples.push({
        guid: ep.guid ?? null,
        episode: String(ep.title || "").slice(0, 90),
        declared_bytes: p.declared_bytes,
        delivered_bytes: p.delivered_bytes,
        duration_sec: Number.isFinite(ep.duration_sec) ? ep.duration_sec : null,
        ratio: p.ratio == null ? null : Math.round(p.ratio * 1000) / 1000,
        delta_sec_implied: impliedDeltaSec(p.declared_bytes, p.delivered_bytes, ep.duration_sec),
        /* Only when there is something to compare. A one-probe run writing
           `deliveries: [n]` would put a field on every row of #319's file that
           can never mean anything, and `varyingSamples` would have to know to
           ignore it. */
        ...(deliveries.length > 1 ? { deliveries } : {}),
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

    const row = deriveRow(
      {
        show_id: s.show_id,
        title: s.title,
        feed_host: s.feed_host,
        enclosure_host: s.enclosure_host,
        /* WHY THIS ROW WAS SELECTED, and the name is #319's rather than a
           better one on purpose: `breadth-suspect-inflation.json` is committed
           under it and renaming the key would leave that file describing itself
           in a vocabulary the tool no longer writes. On the anchorable pool it
           reads `inferred-static`, a selection reason and not a suspicion. */
        suspect_reason: s.reason,
        timed_transcripts: s.timed_transcripts,
        dai_by_chain: chain ? chain.dai : null,
        dai_via: chain ? chain.via : null,
        resolved_chain: chain ? chain.hosts : [],
        samples,
      },
      { note, decodes, grids },
    );
    carried.set(String(s.show_id), row);

    const med = row.median == null ? "  -  " : row.median.toFixed(3);
    console.log(
      `  ${row.disposition.padEnd(10)} ${row.verdict.padEnd(8)} ${med}  ` +
        `${row.inserted_samples}/${samples.length} ins  ` +
        (args.repeat > 1 ? `${row.varying_samples}/${samples.length} vary  ` : "") +
        `worst ${String(row.max_delta_sec_implied == null ? "-" : `${row.max_delta_sec_implied}s`).padStart(5)}  ` +
        `${String(row.tier || "-").padEnd(17)} ` +
        `${chain && chain.dai ? `DAI:${chain.via}` : "chain clean"}`.padEnd(24) +
        `  ${String(s.timed_transcripts).padStart(4)} timed  ${s.title.slice(0, 30)}`,
    );
    /* The note is the row's only explanation of a zero-sample, byte-stable or
       constant-offset result, and a scan whose most interesting outcome is
       invisible in its own console output is how "could not tell" gets read as
       "nothing to see". */
    if (row.note) console.log(`             ${row.note.slice(0, 150)}`);

    /* AFTER EVERY SHOW, not once at the end. A run over the anchorable pool is
       forty-odd feeds and two hundred ranged GETs across an hour, and a crash
       at show 39 that threw away 38 measured shows would be spending a host's
       patience twice for one answer. `writeJsonAtomic` is imported rather than
       re-implemented — it is the SIXTH duplicated implementation this repo
       found (#320) and it carries the Windows `EPERM`-on-rename retry that a
       fresh copy would not. */
    writeReport();
  }

  const elapsedMin = (Date.now() - started) / 60000;
  const results = [...carried.values()];
  const split = measurementSplit(results);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`requests: ${feedRequests} feed + ${requests} ranged GET over ${elapsedMin.toFixed(1)} min`);

  if (args.pool === "suspects") {
    const counts = recount(results, { gross, net });
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
  } else {
    console.log(`  measured clean      ${String(split.measured_clean.timed_transcripts).padStart(5)} timed in ${String(split.measured_clean.shows).padStart(2)} show(s)`);
    console.log(`  measured injecting  ${String(split.measured_injecting.timed_transcripts).padStart(5)} timed in ${String(split.measured_injecting.shows).padStart(2)} show(s)  <- leaves the corpus`);
    console.log(`  unresolved          ${String(split.unresolved.timed_transcripts).padStart(5)} timed in ${String(split.unresolved.shows).padStart(2)} show(s)  <- stays inferred`);
    console.log(
      `anchorable net ${net} -> ${net == null ? "?" : net - split.measured_injecting.timed_transcripts}; ` +
        `run \`breadth-yield.mjs --measured\` over this file for the measured-vs-inferred split of the whole corpus`,
    );
    /* THE SAME LINE THE SUSPECTS BRANCH PRINTS, and it was missing here — which
       a reviewer pointed out makes `<- leaves the corpus` above read as "gone"
       in exactly the way `adrTier`'s own docstring says it must not. ADR-0008
       keeps both tiers in the corpus: paddable plays today with an extended
       stop, locate-required is authored now and plays once the locate step
       exists. Note the honest gap: a row dropped on repeat VARIANCE has no
       declared length, so no `delta_sec_implied`, so no tier — the mitigation
       is structurally unavailable on exactly the rows `varying` condemns, and
       those rows are counted as `untiered` rather than silently omitted. */
    /* OVER THE DROPPED ROWS ONLY, which `recount`'s own tier sums are not: they
       run over every row in the pool because on the suspects pool every row IS
       netted out. On the anchorable pool most rows are clean, so reusing them
       here printed "5,389 paddable" beside a 1,413-transcript drop list —
       a number four times larger than the thing it claims to soften. */
    const dropped = results.filter((r) => r.disposition === "drop");
    const tierTimed = (t) =>
      dropped.filter((r) => r.tier === t).reduce((n, r) => n + (r.timed_transcripts || 0), 0);
    const untiered = dropped.filter((r) => !r.tier).reduce((n, r) => n + (r.timed_transcripts || 0), 0);
    console.log(
      `ADR-0008 screen of the ${split.measured_injecting.timed_transcripts} dropped: ` +
        `${tierTimed("paddable-screened")} paddable, ${tierTimed("locate-required")} locate-required ` +
        `(authored now, played after the locate step)` +
        (untiered ? `, ${untiered} untiered (no declared length, so no seconds to screen on)` : ""),
    );
  }

  writeReport();
  console.log(`SUSPECTS_MEASURED: ${outPath}`);

  /* Hoisted so the per-show checkpoint and the final write are the same bytes.
     Two writers of one file is how a checkpoint and its summary drift. */
  function writeReport() {
    const rows = [...carried.values()];
    writeJsonAtomic(outPath, {
      version: 1,
      measured_at: new Date().toISOString(),
      method: "2-byte ranged GET; tools/transcribe/ad-inflation.mjs via tools/segments/measure-suspects.mjs",
      /* NAMED IN THE FILE, because two pools now write two files in one shape
         and only this says which question the rows answer. */
      pool: args.pool,
      source: {
        yield_report: args.yieldPath,
        /* EVERY INVOCATION THAT CONTRIBUTED, not just the last one. `requests`
           is cumulative across `--resume`, so a `source` describing only the
           final pass cannot be reconciled with it — the committed file said
           `per_show: 5` with no `repeat` beside eight rows carrying
           `repeats: 3` and 367 cumulative requests. A provenance block that
           disagrees with the evidence it is attached to is worse than none. */
        passes: [
          /* A PASS LIST THAT DOES NOT ADD UP TO `requests` IS WORSE THAN NONE,
             and it cannot add up on the first resume after this field was
             introduced: the prior file recorded a cumulative total and no
             per-pass breakdown. Rather than hand-edit the difference in, the
             remainder is stated as what it is. Self-correcting: once every pass
             carries its own entry the difference is 0 and nothing is emitted. */
          ...(() => {
            const known = passes.reduce(
              (a, x) => ({ feeds: a.feeds + (x.feeds || 0), ranged_gets: a.ranged_gets + (x.ranged_gets || 0) }),
              { feeds: 0, ranged_gets: 0 },
            );
            const feeds = priorRequests.feeds - known.feeds;
            const rangedGets = priorRequests.ranged_gets - known.ranged_gets;
            return feeds > 0 || rangedGets > 0
              ? [{ note: "earlier pass(es), recorded before this field existed", feeds, ranged_gets: rangedGets }]
              : [];
          })(),
          ...passes,
          /* A pass that made no request is bookkeeping noise, not provenance. */
          ...(feedRequests || requests ? [{
            per_show: args.perShow,
            ...(args.repeat > 1 ? { repeat: args.repeat } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.hosts.length ? { hosts: args.hosts } : {}),
            ...(args.reprobe ? { reprobe: true } : {}),
            shows_probed: probedCount,
            feeds: feedRequests,
            ranged_gets: requests,
            at: new Date().toISOString(),
          }] : []),
        ],
      },
      requests: {
        feeds: priorRequests.feeds + feedRequests,
        ranged_gets: priorRequests.ranged_gets + requests,
      },
      ...(args.pool === "suspects" ? { counts: recount(rows, { gross, net }) } : {}),
      /* Recomputed here rather than closed over, and READ OFF `carried` rather
         than off any `const` declared beside the summary. The checkpoint calls
         this mid-loop, so anything bound after the loop is still in its
         temporal dead zone — a crash-only failure in the code whose entire job
         is surviving a crash. This function has now had that bug twice: once
         for `split`, once for `results` when the loop moved to a keyed map.
         Nothing outside this closure may be referenced here. */
      measurement: measurementSplit(rows),
      results: rows,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
