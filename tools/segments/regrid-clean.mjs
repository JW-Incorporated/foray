#!/usr/bin/env node
/* Ask a bucket of shows #323's four-cell probe grid: is one URL assembled per
   request? Defaults to the `measured_clean` bucket; `--disposition` names another.
   ============================================================================

   WHY THIS EXISTS. ADR-0008 adopted the 2-byte ranged GET *because HEAD
   requests lie*: the first version of that scan used HEAD, reported 18 of 18
   shows byte-stable, and was completely wrong. #323 then proved the replacement
   can be lied to the same way. On one `atelier.flightcast.com` enclosure, four
   requests for the length of one URL returned:

       probe   ranged    206   67,510,022
       probe   unranged  200   67,510,022
       client  ranged    206   67,510,022
       client  unranged  200   68,884,898

   Only an unranged request under the CLIENT identity is shown the assembled
   file, and `67,510,022 x 8 / 96,000 = 5,625.8s` against a feed declaring
   5,626s says the short number is the ad-free master to a fraction of a second.
   The difference is in a header, before any body is read.

   THE IMPLICATION IS THIS FILE. Every `measured_clean` verdict in this repo was
   reached with the ranged GET — 526 of them across 58 feeds — and that
   instrument is now known to be spoofable on at least one platform. 5,381 timed
   transcripts across 24 shows rest on it. If another platform lies the way
   flightcast does, some of those shows are not clean, and segments may already
   be planned against them. This asks each of them the flightcast question.

   AND THEN THE OTHER BUCKET, WHICH IS WHERE IT PAID. #324 asked all 24
   `recover` shows and none varied. The pool the finding actually pointed at was
   `unresolved`: #323 left six flightcast shows there, 5,320 timed transcripts,
   settleable only by another 60 MB download. `--disposition unresolved --host
   flightcast` asked them for 72 requests and no bodies, and condemned two —
   1,914 transcripts out of the anchorable count. The pool is a flag and
   NOTHING ELSE IN THIS FILE KNOWS WHICH ONE IT IS: same `probeGrid`, same
   four-cell floor, same reading of a grid. That is the point of it being a
   flag rather than a second tool.

   NOTHING HERE REIMPLEMENTS THE GRID. `probeGrid` is imported from
   `tools/transcribe/decode-compare.mjs`, the pool comes from the same measured
   files `breadth-yield.mjs` reads, the episode picker is `probeTargets` from
   `measure-suspects.mjs`, the feed fetch is `sweep-transcripts.mjs`, and every
   outbound identity and the per-host gate belong to `politeness.mjs`. This repo
   has paid seven times for a policy that was copied instead of imported
   (#211/#219/#249 matchers, #313 throttles, #316 headers, #318 User-Agents,
   #320 `writeJsonAtomic`, #321 `isPlausibleAudioSize`) and a second grid whose
   cells quietly disagreed with the committed one would be the worst of them,
   because the committed one is the evidence for the finding.

   WHAT A RESULT MEANS, AND WHAT IT DOES NOT. `varies_by_request: true` is
   positive evidence of the mechanism: two lengths for one URL mean two
   resources, and a file assembled per request is what dynamic insertion IS.
   `varies_by_request: false` proves only that this platform does not lie IN THE
   WAY FLIGHTCAST DOES. It is not a clean bill and this file never upgrades
   anything on it — `varyingSamples` already states the asymmetry and #321's
   honest phrasing, "consistent with a stitcher that did not vary inside a cache
   window", is the standard the notes below are written to.

   A PLATFORM VERDICT IS NOT A SHOW VERDICT. `_adswizz_note` in `dai-hosts.json`
   sets it: "One insert on one show is evidence about that show, not a
   platform-wide claim." Six of the 24 shows sit on `content.blubrry.com` and
   four on `content.libsyn.com`; #321 already measured blubrry splitting 9 clean
   to 1 dirty and libsyn splitting 4/4 by final origin. Every show here gets its
   own grids and its own verdict, and nothing in this file aggregates one to a
   hostname or touches a host list.

   COST. Four requests and about four bytes of body per episode. The unranged
   cells are aborted the moment their headers arrive, so no audio is fetched —
   see `probeGrid`'s own header. #323's six downloads were a bounded exception
   for decode-and-compare and that exception has expired; this mode cannot
   download anything, because it never reads a body.

   Usage:
     node tools/segments/regrid-clean.mjs [--per-show N] [--dry-run]
                                          [--yield FILE] [--measured F,F]
                                          [--out FILE] [--limit N]
                                          [--host SUBSTR,SUBSTR] [--resume]
                                          [--rederive] [--disposition D,D]

     --disposition selects which coverage bucket is audited and defaults to
     `recover`, i.e. #324's pool exactly. `--disposition unresolved --host
     flightcast` is the pass that settled the six shows #323 left open.

     RE-RUNNING A PASS NEEDS --resume, and `main` refuses without it. This tool
     changes the field it selects on, so a pool narrows every time it condemns
     something; see the refusal in `main` for what that would otherwise delete.

     --rederive takes its path from --out, whose default follows --disposition.
     The flightcast ledger is committed under a narrower name than that default
     (its pass was also narrowed by --host), so re-judging it wants
     `--rederive --out data/flightcast-settle-regrid.json`.

     --rederive re-judges the committed rows from the grids already stored on
     them and makes no request at all; it is how a change to the reading of a
     grid reaches evidence that was already bought.
*/

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

import { probeGrid } from "../transcribe/decode-compare.mjs";
import { probeTargets } from "./measure-suspects.mjs";
/* The ledger list from `ledgers.mjs` rather than through `measure-suspects.mjs`,
   which re-exports it: this file already imports that module for `probeTargets`,
   so either would work, but taking a constant from the module that owns it keeps
   the re-export a compatibility shim rather than a second supply route. */
import { MEASURED_REPORT_RELS } from "./ledgers.mjs";
import { fetchFeed, parseFeed, writeJsonAtomic } from "./sweep-transcripts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** How many episodes of one show the grid is spent on, and why three.

    ONE EPISODE CAN CONDEMN. The grid's question is whether a single URL is
    assembled per request, and on flightcast four cells of ONE episode answered
    it. If the mechanism is running on a show's delivery path at all, one draw
    is very likely to see it, so a large N buys little on the condemning side.

    THREE DRAWS BECAUSE INSERTION IS PER-EPISODE, MEASURED. #319 found all five
    Spreaker shows inserting "in discrete ~30s slots on SOME episodes and not
    others", which made a five-sample median a measure of sampling luck: two
    shows came back `ad-free` while each had an episode carrying the same
    481,071-byte creative. A show whose newest episode happens to have an unsold
    slot is exactly the draw that returns four agreeing cells from a host that
    does stitch. Three newest-first draws hedge that.

    NOT FIVE, WHICH IS THE OTHER SCAN'S NUMBER AND SHOULD NOT BE COPIED HERE.
    `MIN_SAMPLES_FOR_AD_FREE` is five because that scan ADMITS shows and an
    acquittal needs a floor. This one admits nothing: stability never upgrades a
    row, so draws four and five could only ever confirm a "does not lie the way
    flightcast does" that was already not a clean bill. Their cost is real —
    at four requests an episode, five would be 480 requests against 288.

    NEWEST FIRST, inherited from `probeTargets` and load-bearing for the same
    reason it is there: ad insertion is a live campaign setting, so a show that
    switched it on last quarter is injected TODAY whatever its back catalogue
    says. */
export const EPISODES_PER_SHOW = 3;

/** A grid cell counts as an ANSWER only if the origin reported a length.

    `probeGrid` already refuses to read `Number(null)` as 0, so a missing
    `Content-Length` arrives here as `null` rather than as a fake third length.
    This is the other half of that guard: a cell that answered nothing must not
    be counted toward the agreement that makes a show read "stable" either. */
export function answeredCells(grid) {
  return (grid?.cells || []).filter((c) => Number.isFinite(c.total));
}

/** The grid is two binary axes, so it is four cells. Named because
    `gridIsInformative` and the artifact test both assert against it, and a
    partial grid answering as though it were whole is this file's headline
    failure. */
export const GRID_CELLS = 4;

/** Did this episode's grid actually ask the question it claims to have asked?

    THE FAILURE THIS EXISTS TO PREVENT is a show whose requests were refused
    reading as `stable` — four 403s produce zero totals, an empty
    `distinct_totals`, and `varies_by_request: false`, a row indistinguishable
    from a file that answered four times identically. That is the HEAD mistake
    in a new unit: a negative filed as a pass. `politeness.mjs` records a
    Buzzsprout edge answering 403 to one product token and 206 to another, so a
    partly-refused grid is a measured shape on this corpus, not a hypothetical.

    THE FLOOR IS ALL FOUR CELLS, AND ANYTHING LESS IS A DIFFERENT INSTRUMENT.
    Two weaker rules were written before this one and both were wrong, in the
    same direction, for the same reason.

      - "two answered cells" — too forgiving on the RANGE axis, and the first
        pass over the real pool caught it. `podcasts.beehiiv.com` answers an
        unranged request CHUNKED, with no `Content-Length` at all, so both its
        unranged cells report nothing and the two survivors are both ranged.
        That is two answers that agree, from a grid that never once compared a
        ranged request against an unranged one.

      - "one of each on the range axis" — too forgiving on the IDENTITY axis,
        and a reviewer caught it. A grid whose entire `client` identity was
        refused still passed, which is worse than it sounds: `probe` ranged +
        `probe` unranged + `client` ranged is exactly the three cells flightcast
        answers HONESTLY. The missing fourth is the only one that lied.

    THE DISCREPANCY WAS IN ONE CELL OF FOUR, so a grid missing any cell may be
    missing the one that would have condemned it. There is no principled subset:
    the instrument is the whole grid, and three quarters of it is not a weaker
    version of the same measurement but a different measurement that happens to
    agree with itself. `politeness.mjs` records a Buzzsprout edge answering 403
    to one product token and 206 to another, reproducible both ways, so losing
    exactly one identity is a measured shape on this corpus, not a hypothetical.

    (Note this is also the other half of `probeGrid`'s `Number(null) === 0`
    guard earning its keep. Without it those beehiiv cells would have arrived as
    `total: 0`, joined `distinct_totals`, and condemned an innocent show for the
    crime of not sending a header.) */
export function gridIsInformative(grid) {
  return (grid?.cells || []).length === GRID_CELLS && answeredCells(grid).length === GRID_CELLS;
}


/** The dispositions this harness audits when nothing says otherwise.

    `recover` ALONE IS THE DEFAULT because that is the bucket #324 was opened to
    audit — `measured_clean`, the only bucket a measurement has admitted. Every
    invocation that does not pass `--disposition` gets exactly #324's pool, so
    re-running the committed pass cannot silently widen underneath it. */
export const DEFAULT_POOL_DISPOSITIONS = Object.freeze(["recover"]);

/** Every disposition `measure-suspects.mjs` can write, and therefore every
    bucket this harness can be pointed at.

    VALIDATED SO A TYPO IS AN ERROR RATHER THAN AN EMPTY PASS. `--disposition
    unresolve` silently selected nothing, printed `0 show(s)`, and wrote a
    zero-row artifact under a path derived from the typo — a committed file
    that looks like a measurement and is the absence of one. */
export const KNOWN_DISPOSITIONS = Object.freeze(["recover", "unresolved", "drop"]);

export function assertKnownDispositions(dispositions) {
  const bad = dispositions.filter((d) => !KNOWN_DISPOSITIONS.includes(d));
  if (bad.length) {
    throw new Error(
      `--disposition: unknown value(s) ${bad.join(", ")}; measure-suspects.mjs writes only ${KNOWN_DISPOSITIONS.join(", ")}`,
    );
  }
  return dispositions;
}

/** The shows whose disposition this run is auditing, biggest asset first.

    THE POOL IS SELECTED ON `disposition` AND NOTHING ELSE, read from the same
    measured files `breadth-yield.mjs` consumes, because "which shows are in
    which coverage bucket" must have exactly one definition in this repo.
    Re-deriving the bucket from verdicts here would let this audit disagree with
    the number it is auditing.

    WHICH DISPOSITIONS, AND WHY IT IS A PARAMETER RATHER THAN A CONSTANT. #324
    asked the `recover` shows the flightcast question and none of them varied.
    The pool that finding actually points at is the OTHER one: #323 caught
    `atelier.flightcast.com` assembling per request and left six of its seven
    shows `unresolved` for a stated reason, 5,320 timed transcripts that the
    coverage figure still counts. Those rows need the identical instrument, the
    identical floor and the identical reading of a grid — so the pool is a
    parameter and everything downstream of it is untouched. Selecting them by
    re-implementing the grid against a different pool is the failure this repo
    has already paid for seven times.

    ORDERED BY THE SHOW'S OWN TRANSCRIPT COUNT, which is deliberately NOT the
    host-total ordering `measure-suspects.mjs` uses and the difference is worth
    stating. That scan ordered by platform size because it was asking an open
    question about hosts and wanted the biggest platform question settled first.
    This one is auditing a per-show verdict against a per-show risk: each
    request buys the most certainty when it is spent on the show carrying the
    most transcripts, so an interrupted run has re-validated the largest
    possible share of the 5,381. */
export function poolShows(reports, { limit = null, hosts = [], dispositions = DEFAULT_POOL_DISPOSITIONS } = {}) {
  const rows = [];
  const seen = new Set();
  const wanted = new Set(dispositions);
  for (const report of reports || []) {
    for (const r of report?.results || []) {
      if (!wanted.has(r?.disposition) || r.show_id == null) continue;
      const id = String(r.show_id);
      /* KEYED, because the two measured files are two POOLS of the same scan
         and a show could in principle appear in both. Counting it twice would
         inflate the audited transcript total above the coverage figure this run
         exists to reconcile with. */
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        show_id: id,
        title: r.title,
        feed_host: r.feed_host ?? null,
        enclosure_host: r.enclosure_host ?? null,
        timed_transcripts: r.timed_transcripts || 0,
        prior_verdict: r.verdict ?? null,
        prior_n: r.n ?? null,
        /* CARRIED ONTO THE ROW because `verdictNote` has to say something
           different about a show that was already `unresolved` than about one
           sitting in `measured_clean`, and the row is the only place that fact
           survives to `--rederive`, which re-judges from the file alone and
           never re-reads the measured pool. */
        prior_disposition: r.disposition ?? null,
      });
    }
  }
  const filtered = hosts.length
    ? rows.filter((r) => hosts.some((h) => String(r.enclosure_host || "").includes(h)))
    : rows;
  filtered.sort((a, b) => b.timed_transcripts - a.timed_transcripts || a.show_id.localeCompare(b.show_id));
  return Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
}

/** Statuses that mean an origin is asking us to slow down.

    STANDING RECORD IS ZERO 429s ACROSS EVERY PASS and this run must not be the
    one that breaks it quietly. `politeness.mjs` owns the gate and the backoff
    ladder for the fetchers that retry; `probeGrid` does not retry, so the only
    correct response available here is to stop and name the host. 503 is
    included because an origin under load says the same thing with it, and
    hammering through a 503 is how the 429 gets earned. */
export const SLOW_DOWN_STATUSES = new Set([429, 503]);

/** Hosts that asked this run to back off, with the cell that said so. */
export function slowDownSignals(grids) {
  const out = [];
  for (const g of grids || []) {
    for (const c of g?.cells || []) {
      if (!SLOW_DOWN_STATUSES.has(c.status)) continue;
      out.push({ host: c.resolved_host || null, url: g.url, status: c.status, identity: c.identity, ranged: c.ranged });
    }
  }
  return out;
}

/** THREE OUTCOMES, and the third one is the reason this function exists.

    `varies` — at least one episode was served two different lengths for one
    URL. Positive evidence of per-request assembly. This CONDEMNS.

    `stable` — every probed episode compared a ranged request against an
    unranged one, under both identities, and got one length every time. This
    acquits NOTHING. It says the show's delivery path does not lie in the way
    flightcast does, which is a statement about one instrument and one platform
    behaviour, not a clean bill. The note below says so in words rather than
    leaving a reader to infer it from a boolean.

    `inconclusive` — at least one probed episode never got the comparison made:
    the feed would not load, the show published no episode with both a timed
    transcript and an enclosure, requests were refused, or — measured on this
    pool, see `gridIsInformative` — the origin answered unranged requests
    chunked and reported no length at all. Separated from `stable` because they
    are opposite facts that a boolean renders identically, and conflating them
    is precisely the HEAD failure ADR-0008 is built around. An `inconclusive`
    row is not evidence about the show.

    NOTE THE ASYMMETRY IN THE FLOOR. One varying episode is enough to condemn,
    but "stable" requires that EVERY probed episode was informative. Evidence of
    a mechanism running does not need corroboration; absence of it is a sample
    size, and a sample partly made of refusals is a smaller one than it looks. */
export function showGridVerdict(grids) {
  const list = grids || [];
  const informative = list.filter(gridIsInformative);
  const varying = list.filter((g) => g.varies_by_request);
  const seen = (gs) => [...new Set(gs.flatMap((g) => answeredCells(g).map((c) => c.total)))].sort((a, b) => a - b);
  const status = varying.length ? "varies" : informative.length && informative.length === list.length ? "stable" : "inconclusive";
  return {
    status,
    varies_by_request: varying.length > 0,
    episodes_probed: list.length,
    episodes_informative: informative.length,
    varying_episodes: varying.length,
    /* TWO TOTALS FIELDS, AND CONFLATING THEM WOULD MISREPORT THE FINDING.
       `totals_seen` is the union across episodes and is a diagnostic only —
       three episodes of one show are three different files, so three distinct
       numbers there is the ORDINARY case and means nothing at all.
       `varying_totals` is the union over only the grids that disagreed WITH
       THEMSELVES, i.e. the two lengths one URL was served. That is the #323
       shape and it is the only one the note may quote. */
    varying_totals: seen(varying),
    /* THE SAME EVIDENCE, UNPOOLED, AND THE POOLED FORM IS ACTIVELY MISLEADING
       ONCE A SHOW HAS MORE THAN ONE VARYING EPISODE. `varying_totals` unions
       three episodes' pairs into `a / b / c / d / e / f`, which reads as one URL
       having been served six lengths — the exact conflation the comment above
       warns about for `totals_seen`, reintroduced one field lower. The finding
       is per URL and has to be rendered per URL: `["a vs b", "c vs d"]`, one
       entry per episode, each entry the DISTINCT lengths ONE url was served.
       Two is what every varying grid on this corpus has shown and it is what
       the mechanism produces, but nothing here assumes it — a grid served three
       distinct lengths renders `a vs b vs c`, which is why the prose downstream
       says "distinct lengths" and not "the two lengths".
       `varying_totals` is kept because it is the union the summary line prints
       and #324's committed rows carry it. */
    varying_pairs: varying.map((g) => answeredCells(g).map((c) => c.total))
      .map((totals) => [...new Set(totals)].sort((a, b) => a - b).join(" vs "))
      .filter(Boolean),
    totals_seen: seen(list),
  };
}

/** What this run says about a row, in words, and it never says "clean".

    The `stable` sentence is written against #321's standard: that pass reported
    "N identical answers" as though repetition were proof, and its own correction
    — "consistent with a stitcher that did not vary inside a cache window" — is
    the phrasing the corpus figures now rest on. A grid adds two IDENTITIES and
    the RANGE axis to that, so it can say something #321's repeats could not:
    the discrepancy flightcast shows is not present here. That is a strictly
    narrower claim than clean and this text has to keep it narrow, because the
    note is what a later reader will quote. */
export function verdictNote(v, { perShow = EPISODES_PER_SHOW, priorDisposition = "recover" } = {}) {
  /* WHICH POOL THE ROW CAME FROM CHANGES WHAT THERE IS TO SAY, and only for the
     two settled outcomes. A `recover` row is being AUDITED: something admitted
     it, and the note has to name what that something was. An `unresolved` row
     was never admitted by anything, so "the verdict does not stand" would
     describe a verdict that was never issued, and "still rests on its
     ranged-GET samples" would credit samples this repo has already voided.
     Defaulting to `recover` keeps every note #324 committed byte-identical
     under `--rederive`, since those rows predate the field. */
  const clean = priorDisposition === "recover";
  if (v.status === "varies") {
    return (
      `${NOTE_PREFIX} ${v.varying_episodes} of ${v.episodes_probed} probed episode(s) were served ` +
      `MORE THAN ONE LENGTH for a single URL depending on how the request was made ` +
      `(${v.varying_pairs.join("; ")} bytes — one entry per episode, each entry the distinct lengths ONE url ` +
      `was served). More than one length for one URL means more than one resource, which is ` +
      `per-request assembly — the #323 finding, on this show. ` +
      (clean
        ? `The ranged-GET samples that produced this show's ad-free verdict cannot be read as deliveries, ` +
          `so the verdict does not stand`
        : `This show was already unresolved for want of an instrument that could speak; the grid is one, and ` +
          `what it observed is the mechanism itself. That is positive evidence and it condemns — the show ` +
          `leaves the anchorable count rather than sitting in it awaiting a download`)
    );
  }
  if (v.status === "stable") {
    return (
      `${NOTE_PREFIX} ${v.episodes_probed} episode(s), each asked all four ways (2-byte ranged GET and ` +
      `unranged, under both outbound identities), and all ${v.episodes_probed * GRID_CELLS} cells reported ` +
      `the same length for their URL. This does NOT re-certify the show: it says only that this delivery ` +
      `path does not lie in the way atelier.flightcast.com does, and a stitcher that did not vary inside a ` +
      `cache window looks exactly like this. ` +
      (clean
        ? `The show's disposition is unchanged and still rests on its ranged-GET samples`
        /* NEITHER CIRCULAR NOR SELF-CONTRADICTING, and it was briefly both. It
           cited #323's bare-chain control by name as corroboration — which on
           that show's own row cited the row itself — and it ended "only
           ADR-0008 decode-and-compare can settle it", the exact claim
           `decodeOverride`'s sibling sentence drops one file over, for the exact
           reason: a grid settled two of these shows for 72 requests and no
           download. Two committed files asserting opposite things about the
           same four show_ids is the failure two reviewer rounds have already
           caught here. */
        : `The show's disposition is unchanged and remains unresolved: a grid that agrees with itself ` +
          `admits nothing, because four identical cells are also what a stitcher that did not vary for us ` +
          `looks like. Settling it needs ADR-0008 decode-and-compare, or a grid that does catch an assembly`)
    );
  }
  return (
    `${NOTE_PREFIX} inconclusive — only ${v.episodes_informative} of ${v.episodes_probed} attempted ` +
    `episode(s) (wanted ${perShow}) returned a length in all ${GRID_CELLS} cells. A grid missing any cell ` +
    `cannot be asked the question: on flightcast exactly one cell of the four carried the discrepancy and ` +
    `the other three agreed, so a missing cell may be the one that would have condemned. Common causes are ` +
    `a refusal under one identity and an unranged reply sent chunked with no Content-Length. Nothing was ` +
    `learned about this show and its disposition is untouched; this is not a negative result`
  );
}

/** The audit's own arithmetic, so the PR body never has to be trusted.

    Counted over the pool this run actually probed rather than over the coverage
    file, and the two are reconciled by `--dry-run` printing both.

    `unclassified` EXISTS TO KEEP THE SUM HONEST, and a reviewer is why. The
    three real buckets read `r.grid.status`, so a row that somehow carries no
    `grid` at all was counted in `audited` and in nothing else — the buckets
    silently stopped summing to the total, in a block the PR body quotes
    verbatim. No code path emits such a row today and the suite pins that the
    committed file has none. It is the SILENCE that was wrong: a fourth bucket
    that is visibly non-zero is a bug report, where a total that quietly fails
    to add up is a wrong number nobody notices. */
export function summarise(rows) {
  const tally = (pred) => {
    const hit = (rows || []).filter(pred);
    return { shows: hit.length, timed_transcripts: hit.reduce((n, r) => n + (r.timed_transcripts || 0), 0) };
  };
  const known = new Set(["varies", "stable", "inconclusive"]);
  return {
    audited: tally(() => true),
    varies_by_request: tally((r) => r.grid?.status === "varies"),
    stable_across_the_grid: tally((r) => r.grid?.status === "stable"),
    inconclusive: tally((r) => r.grid?.status === "inconclusive"),
    unclassified: tally((r) => !known.has(r.grid?.status)),
    note:
      "varies_by_request is positive evidence of per-request assembly and moves a show DOWN out of whichever " +
      "bucket it was in — off measured_clean, or out of the anchorable count altogether for a show that was " +
      "already unresolved. " +
      "stable_across_the_grid is NOT a clean bill: it means this delivery path does not lie in the way " +
      "atelier.flightcast.com does, and stability across requests is consistent with a static file AND " +
      "with a stitcher that did not vary for us. inconclusive rows never got a length back in all four " +
      "cells — a refusal under one identity, or an origin answering unranged requests chunked — and a grid " +
      "missing any cell may be missing the one that would have condemned. unclassified must be zero: it " +
      "counts rows carrying no verdict at all, and exists so the four buckets always sum to audited.",
  };
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function list(argv, name, fallback) {
  return String(arg(argv, name, fallback) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The artifact a pool writes to when `--out` does not name one.

    THE DEFAULT PATH HAS TO FOLLOW THE POOL, and a reviewer found why. `--out`
    defaulted to `data/breadth-clean-regrid.json` unconditionally, so
    `--disposition unresolved` with no `--out` would overwrite #324's committed
    evidence with a different pool's rows — and `GRID_REPORT_RELS` in
    `measure-suspects.mjs` would then go on consuming that file as the
    clean-pool ledger. One committed artifact per pool, chosen by the same flag
    that chooses the pool, is the cheap guard; naming `--out` explicitly still
    wins, because a caller who names a path has said what they mean. */
export function defaultOutFor(dispositions) {
  const key = [...dispositions].sort().join("-");
  return key === "recover" ? "data/breadth-clean-regrid.json" : `data/${key}-regrid.json`;
}

export function parseArgs(argv) {
  const n = Number(arg(argv, "--per-show", String(EPISODES_PER_SHOW)));
  const limit = Number(arg(argv, "--limit", ""));
  const dispositions = assertKnownDispositions(list(argv, "--disposition", DEFAULT_POOL_DISPOSITIONS.join(",")));
  return {
    perShow: Number.isFinite(n) && n > 0 ? Math.floor(n) : EPISODES_PER_SHOW,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    hosts: list(argv, "--host", ""),
    /* DEFAULTS TO #324'S POOL. An invocation that names no disposition gets
       `recover` and nothing else, so re-running the committed pass cannot
       widen underneath it. */
    dispositions,
    yieldPath: arg(argv, "--yield", "data/breadth-transcript-yield.json"),
    measured: list(argv, "--measured", MEASURED_REPORT_RELS.join(",")),
    out: arg(argv, "--out", defaultOutFor(dispositions)),
    dryRun: argv.includes("--dry-run"),
    resume: argv.includes("--resume"),
    rederive: argv.includes("--rederive"),
  };
}

/** Re-judge every committed row from the grids already stored on it. No request.

    `deriveRow` and `--recompare` are the same idea and this is here for the same
    reason: THE GRIDS ARE THE EVIDENCE AND EVERYTHING ELSE ON THE ROW IS AN
    OPINION ABOUT THEM. When the way this file reads a grid changes, the
    committed rows must be re-judged by today's rule rather than left carrying
    yesterday's, because a file holding rows judged by two standards — with
    nothing on them saying which — is worse than either standard.

    It also means a wording or roll-up fix costs nothing. Re-running the pass to
    change a sentence would spend another 288 requests on origins that already
    answered, which is the opposite of politeness. */
export function rederive(prev, { perShow = EPISODES_PER_SHOW } = {}) {
  const results = (prev?.results || []).map((r) => judgeRow(r, { perShow }));
  /* `policy` IS RE-STAMPED, `source` IS NOT, and `method` IS RE-DERIVED FROM
     `source`. The split is the point.

     `policy` states what a reader may conclude from this file — the tool's
     current rule — so a re-judged file must carry the current wording for the
     same reason its rows must carry the current verdict: two ledgers describing
     themselves in different vocabularies is the prose form of "rows judged by
     two standards".

     `source` is PROVENANCE — what was asked, of whom, when — and re-stamping it
     would let a zero-request re-judgement rewrite the history of a pass it did
     not make. So it is copied untouched.

     `method` is a SENTENCE ABOUT `source`, and that is why it is recomputed
     from `prev.source` rather than from today's argv. Recomputing it from argv
     would let `--rederive` (which takes no `--disposition`) relabel a pass's
     pool; leaving it alone froze the bug it had — the flightcast file claiming
     `measured_clean`. Reading the pool off the file's own record fixes the
     sentence without inventing a fact. Files written before the field default
     to `recover`, which is the pool they were run against. */
  /* AND THE POOL IS BACKFILLED ONTO `source` THE FIRST TIME IT IS INFERRED, so
     the inference happens exactly once. A file written before the field defaults
     to `recover` — correct, because that was the only pool that existed — but
     leaving the key absent means every future `--rederive` re-infers it from
     `DEFAULT_POOL_DISPOSITIONS`, and changing that constant would silently
     relabel the pass. Writing it down converts a standing assumption into a
     recorded fact. */
  const dispositions = prev?.source?.dispositions || [...DEFAULT_POOL_DISPOSITIONS];
  return {
    ...prev,
    method: methodFor(dispositions),
    policy: POLICY,
    source: { ...(prev?.source || {}), dispositions },
    results,
    summary: summarise(results),
    rederived_at: new Date().toISOString(),
  };
}

/** How a row's fetch note and its grid note are joined, and split apart again.

    ONE CONSTANT FOR BOTH DIRECTIONS, because `judgeRow` recovers the fetch note
    by searching for exactly what it wrote. Derived from `NOTE_PREFIX`, which
    every note `verdictNote` emits must open with, so the join and the split
    cannot drift: renaming the prefix on one side alone would otherwise start
    silently eating "feed unreadable: ..." on the next re-judgement, leaving a
    row that still looks perfectly well-formed. The suite pins both the
    round-trip and the prefix. */
/** What was asked, of which bucket. Named because it must NAME THE POOL IT
    ACTUALLY AUDITED.

    This string was hardcoded to "over every measured_clean show", so the
    flightcast artifact opened by claiming a bucket it had not touched and then
    listed `"dispositions": ["unresolved"]` three keys later — a provenance
    block that could not be reconciled with the evidence attached to it, which
    is `measure-suspects.mjs`'s own `source.passes` lesson. */
export function methodFor(dispositions) {
  return (
    `tools/transcribe/decode-compare.mjs probeGrid (#323) re-run over every show whose disposition is ` +
    `[${[...dispositions].join(", ")}]: for each probed episode, four requests for one URL's length — ` +
    "2-byte ranged GET and unranged, under both outbound identities. No body is read; the unranged calls " +
    "are aborted as their headers arrive."
  );
}

/** What a reader may conclude from either grid ledger. Re-stamped by
    `--rederive` so both files say it in the same words; see `rederive`. */
export const POLICY =
  "This file can only ever move a show DOWN — off measured_clean, or out of the anchorable count " +
  "altogether — and can never move one up. See verdictNote: a grid that agrees with itself says this " +
  "delivery path does not lie the way atelier.flightcast.com does, which is a statement about one " +
  "instrument, not a clean bill, and it leaves an already-unresolved show unresolved.";

export const NOTE_PREFIX = "PROBE GRID:";
export const NOTE_SEP = " — ";
export const NOTE_JOIN = NOTE_SEP + NOTE_PREFIX;

/** One row, re-judged from the grids stored on it. No request.

    THE GRIDS ARE THE EVIDENCE AND EVERYTHING ELSE ON THE ROW IS AN OPINION
    ABOUT THEM, so this is the ONLY place a row's `grid` and `note` are set —
    the live pass, `--rederive` and `--resume` all go through it. `deriveRow`
    earns the same rule in `measure-suspects.mjs` and a reviewer had to teach it
    there: `--resume` used to copy prior rows verbatim, which let one file hold
    rows judged by two standards with nothing on them saying which. That is not
    hypothetical here. The first pass over this pool ran a weaker
    `gridIsInformative` and called `podcasts.beehiiv.com` stable; a `--resume`
    that copied rows would have carried exactly the row the fix existed to
    correct, still saying `stable`, past the fix. */
export function judgeRow(row, { perShow = EPISODES_PER_SHOW } = {}) {
  const grid = showGridVerdict(row?.grids);
  /* THE FETCH NOTE STILL WINS, and survives re-judgement: "the feed would not
     load" explains a row better than any verdict drawn from the grids that
     failure prevented, and it is the one fact on the row that no grid can
     reconstruct. */
  const prior = typeof row?.note === "string" ? row.note : "";
  const fetchNote = prior.includes(NOTE_JOIN) ? prior.slice(0, prior.indexOf(NOTE_JOIN)) : null;
  /* `?? undefined`, NOT `|| "recover"`. The row carries `prior_disposition:
     null` only for rows written before the field existed, and letting
     `verdictNote`'s own default supply the fallback keeps that default stated
     in exactly one place. */
  const note = verdictNote(grid, { perShow, priorDisposition: row?.prior_disposition ?? undefined });
  return { ...row, grid, note: fetchNote ? `${fetchNote}${NOTE_SEP}${note}` : note };
}

/** The report's provenance block, shared by the completed and stopped-early
    writes. FACTORED BECAUSE THE STOPPED WRITE USED TO OMIT IT: a run cut short
    by a throttle produced a file with no `method`, no `policy` and no `summary`,
    which is the one file a later reader most needs to be able to interpret —
    and which the artifact test would have rejected with an unhelpful
    `undefined`. A partial measurement still has to say what it is. */
export function reportShell(args, requests) {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    method: methodFor(args.dispositions),
    policy: POLICY,
    source: { yield: args.yieldPath, measured: args.measured, dispositions: args.dispositions },
    episodes_per_show: args.perShow,
    requests,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readJson = (p) => JSON.parse(readFileSync(resolvePath(process.cwd(), p), "utf8"));
  if (args.rederive) {
    const p = resolvePath(process.cwd(), args.out);
    /* NAMES THE FILE, because `--rederive` takes its path from `--out`, whose
       default follows `--disposition` — so `--rederive --disposition
       unresolved` looks for `data/unresolved-regrid.json` and the flightcast
       ledger is committed under a narrower, more honest name (that pass was
       also narrowed by `--host`). A bare ENOENT stack trace does not tell a
       reader that, and a reviewer hit it. */
    if (!existsSync(p)) {
      console.error(
        `no such ledger: ${args.out}\n` +
          `--rederive re-judges an existing file and its path comes from --out, which defaults to ` +
          `${defaultOutFor(args.dispositions)} for this --disposition. Pass --out explicitly, e.g.\n` +
          `  node tools/segments/regrid-clean.mjs --rederive --out data/flightcast-settle-regrid.json`,
      );
      return 2;
    }
    const out = rederive(JSON.parse(readFileSync(p, "utf8")), { perShow: args.perShow });
    writeJsonAtomic(p, out);
    for (const r of out.results) {
      console.log(
        `${String(r.timed_transcripts).padStart(5)} timed  ${String(r.enclosure_host).padEnd(28)} ` +
          `${r.grid.status.padEnd(10)} ${r.grid.episodes_informative}/${r.grid.episodes_probed} informative  ${r.title}`,
      );
    }
    console.log(`\nre-judged ${out.results.length} row(s) from the stored grids — no request made`);
    return 0;
  }

  const report = readJson(args.yieldPath);
  const feedById = new Map((report.shows || []).map((s) => [String(s.show_id), s.feed_url]));
  const coverage = report.measurement_coverage?.measured_clean || null;

  const pool = poolShows(
    args.measured.filter((p) => existsSync(resolvePath(process.cwd(), p))).map(readJson),
    { limit: args.limit, hosts: args.hosts, dispositions: args.dispositions },
  );
  const poolTranscripts = pool.reduce((n, r) => n + r.timed_transcripts, 0);

  /* THE COVERAGE CROSS-CHECK IS ONLY MEANINGFUL FOR THE `recover` POOL, because
     `measured_clean` is the bucket that disposition maps onto. Printing it
     beside an `unresolved` pool would invite exactly the misreading the line
     exists to prevent — two unrelated numbers side by side reading as a
     reconciliation. */
  const reconcilable = args.dispositions.length === 1 && args.dispositions[0] === "recover";
  console.log(
    `pool [${args.dispositions.join(", ")}]: ${pool.length} show(s), ${poolTranscripts} timed transcripts` +
      (coverage && reconcilable ? ` (coverage file says measured_clean is ${coverage.shows} / ${coverage.timed_transcripts})` : ""),
  );
  console.log(`${args.perShow} episode(s) per show, 4 requests each — at most ${pool.length * args.perShow * 4} requests, no bodies\n`);

  if (args.dryRun) {
    for (const s of pool) {
      console.log(`  ${String(s.timed_transcripts).padStart(5)} timed  ${String(s.enclosure_host).padEnd(28)} ${s.title}`);
    }
    return 0;
  }

  const outPath = resolvePath(process.cwd(), args.out);

  /* REFUSE TO DELETE EVIDENCE, AND THE POOL IS WHY THIS IS NEEDED AT ALL.

     THE POOL IS A FLAG OVER A FIELD THIS PASS MUTATES. `--disposition
     unresolved` selected six flightcast shows; the two it condemned are now
     `drop`, so the identical command today selects FOUR. Re-run without
     `--resume` and the artifact is rewritten with four rows — the two `varies`
     grids are gone, `gridOverride` goes null for those shows, and 1,914
     transcripts silently return to the anchorable count. The evidence for a
     verdict would be destroyed by re-running the command that produced it.

     `recover` never showed this because #324 condemned nobody, so the pool was
     a fixed point. It is not one in general, and a reviewer found the
     reproduction block in the README walking straight into it.

     `--resume` is the correct form and it already keeps every prior row (see
     the block below); this only refuses the form that does not. It compares
     show_ids rather than counts, because a pool that changed membership without
     changing size is the same loss and would slip a count check. */
  const orphaned = existsSync(outPath) && !args.resume
    ? (JSON.parse(readFileSync(outPath, "utf8")).results || [])
        .filter((r) => r?.show_id != null && !pool.some((s) => s.show_id === String(r.show_id)))
    : [];
  if (orphaned.length) {
    console.error(
      `\nREFUSING TO WRITE ${args.out}: it holds ${orphaned.length} row(s) for shows outside today's pool, ` +
        `and this run would delete them.\n` +
        orphaned.map((r) => `  ${String(r.timed_transcripts).padStart(5)} timed  ${r.grid?.status ?? "?"}  ${r.title}`).join("\n") +
        `\n\nThis pass CHANGES the dispositions it selects on, so re-running it narrows its own pool. ` +
        `Re-run with --resume (keeps every prior row and re-judges it, re-probing only the unsettled ones), ` +
        `or --rederive (re-judges the stored grids and makes no request), or --out a different path.`,
    );
    return 2;
  }

  /* EVERY PRIOR ROW, keyed by show. `done` is the narrower set this run may
     SKIP; `kept` is what the output must still contain. */
  const kept = new Map();
  const done = new Set();
  const priorRequests = { feeds: 0, grid_requests: 0 };
  if (args.resume && existsSync(outPath)) {
    /* TWO RULES, BOTH `measure-suspects.mjs`'s AND BOTH TAUGHT IT BY A REVIEWER,
       and an earlier version of this block cited them by name while obeying
       neither.

       EVERY PRIOR ROW IS KEPT, not only the ones this run considers settled and
       not only the ones in today's pool. Run the full pool, then resume with
       `--host` narrowed or `--limit` set, and rows outside that narrower pool
       are neither carried nor re-probed: they simply vanish, while `requests`
       goes on claiming the cost of evidence the file no longer holds. The rows
       this run re-probes are replaced below, by `show_id`.

       AND THEY ARE RE-JUDGED, NOT COPIED. See `judgeRow`: the grids are the
       evidence and the verdict is an opinion about them, so a row measured by an
       earlier pass must be re-judged by today's rules. This is not hypothetical
       here — the first pass over this pool ran a weaker `gridIsInformative` and
       called `podcasts.beehiiv.com` stable. No request is made: this reads
       cells already committed. */
    const prior = JSON.parse(readFileSync(outPath, "utf8"));
    priorRequests.feeds = prior.requests?.feeds || 0;
    priorRequests.grid_requests = prior.requests?.grid_requests || 0;
    for (const r of prior.results || []) {
      if (r?.show_id == null) continue;
      const judged = judgeRow(r, { perShow: args.perShow });
      kept.set(String(r.show_id), judged);
      /* ONLY A SETTLED ROW IS SKIPPED. An `inconclusive` row is precisely the
         one a resumed run exists to re-attempt, so marking it done would make
         `--resume` permanently unable to improve the file. */
      if (judged.grid.status === "stable" || judged.grid.status === "varies") done.add(String(r.show_id));
    }
    console.log(
      `--resume: ${kept.size} prior row(s) in ${args.out}, ${done.size} settled ` +
        `(${priorRequests.feeds} feed + ${priorRequests.grid_requests} grid request(s) already spent)\n`,
    );
  }

  const started = Date.now();
  let feeds = 0;
  let gridRequests = 0;
  /* SEEDED WITH EVERY KEPT ROW, then replaced by `show_id` as this run measures.
     Building the output from `pool` alone is what deleted the out-of-pool rows;
     see the `--resume` block above. */
  const byId = new Map(kept);
  /* Written into every checkpoint below rather than derived from `pool`, so a
     run that stops early records what it PROBED and not what it planned to. */
  const rowsOut = () => pool.map((s) => byId.get(s.show_id)).filter(Boolean)
    .concat([...byId.values()].filter((r) => !pool.some((s) => s.show_id === String(r.show_id))));

  for (const s of pool) {
    if (done.has(s.show_id)) continue;
    const feedUrl = feedById.get(s.show_id);
    let episodes = [];
    let note = null;
    if (!feedUrl) note = "no feed_url in the yield report for this show_id";
    else {
      try {
        feeds++;
        episodes = parseFeed(await fetchFeed(feedUrl)).episodes;
      } catch (e) {
        note = `feed unreadable: ${e.message}`;
      }
    }

    /* `requireDeclaredLength: false`, DELIBERATELY, and for the reason
       `probeTargets`' own docstring gives `--repeat`: the denominator rule
       exists because the RATIO needs a feed-declared length to divide by. The
       grid divides by nothing. It compares a URL's reported length against
       ITSELF across four ways of asking, so an episode with no `length`
       attribute answers this question exactly as well as one with it — and
       requiring the attribute would silently skip whichever episodes lack it,
       which on flightcast is all of them. */
    const targets = probeTargets(episodes, args.perShow, { requireDeclaredLength: false });
    const grids = [];
    for (const ep of targets) {
      const g = await probeGrid({ audio_url: ep.enclosure_url });
      gridRequests += g.cells.length;
      grids.push({ ...g, episode: ep.title || null, guid: ep.guid || null });
      const stop = slowDownSignals([g]);
      if (stop.length) {
        /* STOP AND REPORT, NAMING THE HOST. Not a backoff-and-continue: the
           brief's standing record is zero 429s across every pass, and a run
           that quietly absorbed one would spend the rest of the pool proving
           the record wrong while still reporting it. */
        console.error(
          `\nSTOPPING — ${stop[0].host || "an origin"} answered HTTP ${stop[0].status} ` +
            `(${stop[0].identity}, ${stop[0].ranged ? "ranged" : "unranged"}) on ${stop[0].url}`,
        );
        /* HONEST ABOUT THE OVERSHOOT. `probeGrid` exposes no abort hook, so the
           four cells of the episode in flight had already been sent when this
           was read; up to three of them followed the throttle. Nothing further
           is requested. Saying "no further requests were made" full stop would
           be the kind of small inaccuracy that makes a politeness record
           worthless. */
        console.error(
          `Up to ${GRID_CELLS - 1} further cell(s) of that episode were already in flight; nothing after it ` +
            `was requested. Re-run with --resume once the host is happy.`,
        );
        const stoppedRows = byId.size ? rowsOut() : [];
        writeJsonAtomic(outPath, {
          ...reportShell(args, { feeds: priorRequests.feeds + feeds, grid_requests: priorRequests.grid_requests + gridRequests }),
          stopped_early: { reason: `HTTP ${stop[0].status}`, host: stop[0].host, url: stop[0].url },
          summary: summarise(stoppedRows),
          results: stoppedRows,
        });
        return 2;
      }
    }

    /* ONE PLACE SETS `grid` AND `note`, and it is the same one `--rederive` and
       `--resume` use. The fetch note is handed in through the row so `judgeRow`
       can recover it later; see `NOTE_JOIN`. */
    const row = judgeRow({ ...s, grids, note: note ? `${note}${NOTE_JOIN}` : null }, { perShow: args.perShow });
    const verdict = row.grid;
    byId.set(s.show_id, row);
    console.log(
      `${String(s.timed_transcripts).padStart(5)} timed  ${String(s.enclosure_host).padEnd(28)} ` +
        `${verdict.status.padEnd(10)} ${verdict.episodes_informative}/${verdict.episodes_probed} informative  ` +
        `${verdict.varies_by_request ? `<-- VARIES BY REQUEST: ${verdict.varying_totals.join(" / ")}` : ""}  ${s.title}`,
    );
  }

  const rows = rowsOut();
  const summary = summarise(rows);
  writeJsonAtomic(outPath, {
    ...reportShell(args, {
      feeds: priorRequests.feeds + feeds,
      grid_requests: priorRequests.grid_requests + gridRequests,
      elapsed_sec: Math.round((Date.now() - started) / 1000),
    }),
    summary,
    results: rows,
  });

  console.log(`\n  audited              ${String(summary.audited.timed_transcripts).padStart(5)} timed in ${String(summary.audited.shows).padStart(2)} show(s)`);
  console.log(`  VARIES BY REQUEST    ${String(summary.varies_by_request.timed_transcripts).padStart(5)} timed in ${String(summary.varies_by_request.shows).padStart(2)} show(s)`);
  console.log(`  stable across grid   ${String(summary.stable_across_the_grid.timed_transcripts).padStart(5)} timed in ${String(summary.stable_across_the_grid.shows).padStart(2)} show(s)  (NOT a clean bill)`);
  console.log(`  inconclusive         ${String(summary.inconclusive.timed_transcripts).padStart(5)} timed in ${String(summary.inconclusive.shows).padStart(2)} show(s)`);
  if (summary.unclassified.shows) console.log(`  UNCLASSIFIED         ${String(summary.unclassified.timed_transcripts).padStart(5)} timed in ${String(summary.unclassified.shows).padStart(2)} show(s)  <-- rows with no verdict; this is a bug`);
  console.log(`\nwrote ${args.out} — ${feeds} feed + ${gridRequests} grid request(s) this pass`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code || 0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

export { ROOT };
