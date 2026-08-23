#!/usr/bin/env node
/* Re-validate every `measured_clean` show with #323's four-cell probe grid.
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
*/

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

import { probeGrid } from "../transcribe/decode-compare.mjs";
import { probeTargets } from "./measure-suspects.mjs";
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

/** Did this episode's grid actually ask the question it claims to have asked?

    THE FAILURE THIS EXISTS TO PREVENT is a show whose requests were refused
    reading as `stable` — four 403s produce zero totals, an empty
    `distinct_totals`, and `varies_by_request: false`, a row indistinguishable
    from a file that answered four times identically. That is the HEAD mistake
    in a new unit: a negative filed as a pass. `politeness.mjs` records a
    Buzzsprout edge answering 403 to one product token and 206 to another, so a
    partly-refused grid is a measured shape on this corpus, not a hypothetical.

    THE FLOOR IS BOTH SIDES OF THE RANGE AXIS, NOT SIMPLY TWO ANSWERS, AND THAT
    IS THE LESSON THIS RUN PAID FOR. An earlier version asked only for two
    answered cells, and the first pass over the real pool found why that is too
    forgiving: `podcasts.beehiiv.com` answers an unranged request CHUNKED, with
    no `Content-Length` at all, so both its unranged cells report nothing and
    the two survivors are both ranged. Under a bare count-of-two that show read
    `stable` — while the flightcast discrepancy lives precisely on the cell it
    did not answer, the unranged one. A grid that cannot compare a ranged
    request against an unranged one has not asked the flightcast question at
    all, and must not be allowed to answer it in the negative.

    (Note this is also the other half of `probeGrid`'s `Number(null) === 0`
    guard earning its keep. Without it those two chunked cells would have
    arrived as `total: 0`, joined `distinct_totals`, and condemned an innocent
    show for the crime of not sending a header.) */
export function gridIsInformative(grid) {
  const answered = answeredCells(grid);
  return answered.some((c) => c.ranged) && answered.some((c) => !c.ranged);
}

/** The shows whose "clean" verdict this run is auditing, biggest asset first.

    THE POOL IS `disposition: "recover"` AND NOTHING ELSE, read from the same
    measured files `breadth-yield.mjs` consumes, because "which shows are
    measured_clean" must have exactly one definition in this repo. Re-deriving
    the bucket from verdicts here would let this audit disagree with the number
    it is auditing.

    ORDERED BY THE SHOW'S OWN TRANSCRIPT COUNT, which is deliberately NOT the
    host-total ordering `measure-suspects.mjs` uses and the difference is worth
    stating. That scan ordered by platform size because it was asking an open
    question about hosts and wanted the biggest platform question settled first.
    This one is auditing a per-show verdict against a per-show risk: each
    request buys the most certainty when it is spent on the show carrying the
    most transcripts, so an interrupted run has re-validated the largest
    possible share of the 5,381. */
export function cleanShows(reports, { limit = null, hosts = [] } = {}) {
  const rows = [];
  const seen = new Set();
  for (const report of reports || []) {
    for (const r of report?.results || []) {
      if (r?.disposition !== "recover" || r.show_id == null) continue;
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
export function verdictNote(v, { perShow = EPISODES_PER_SHOW } = {}) {
  if (v.status === "varies") {
    return (
      `PROBE GRID: ${v.varying_episodes} of ${v.episodes_probed} probed episode(s) were served ` +
      `MORE THAN ONE LENGTH for a single URL depending on how the request was made ` +
      `(${v.varying_totals.join(" / ")} bytes). Two lengths for one URL mean two resources, which is ` +
      `per-request assembly — the #323 finding, on this show. The ranged-GET samples that produced this ` +
      `show's ad-free verdict cannot be read as deliveries, so the verdict does not stand`
    );
  }
  if (v.status === "stable") {
    return (
      `PROBE GRID: ${v.episodes_probed} episode(s), each asked four ways (2-byte ranged GET and unranged, ` +
      `under both outbound identities), reported one length every time. This does NOT re-certify the show: ` +
      `it says only that this delivery path does not lie in the way atelier.flightcast.com does, and a ` +
      `stitcher that did not vary inside a cache window looks exactly like this. The show's disposition is ` +
      `unchanged and still rests on its ranged-GET samples`
    );
  }
  return (
    `PROBE GRID: inconclusive — only ${v.episodes_informative} of ${v.episodes_probed} attempted episode(s) ` +
    `(wanted ${perShow}) got a ranged and an unranged answer to compare. An origin that reports no length ` +
    `on one axis — an unranged reply sent chunked, or a refusal — cannot be asked the question at all, ` +
    `because the flightcast discrepancy appeared on exactly that axis. Nothing was learned about this ` +
    `show and its disposition is untouched; this is not a negative result`
  );
}

/** The audit's own arithmetic, so the PR body never has to be trusted.

    Counted over the pool this run actually probed rather than over the coverage
    file, and the two are reconciled by `--dry-run` printing both. */
export function summarise(rows) {
  const tally = (pred) => {
    const hit = (rows || []).filter(pred);
    return { shows: hit.length, timed_transcripts: hit.reduce((n, r) => n + (r.timed_transcripts || 0), 0) };
  };
  return {
    audited: tally(() => true),
    varies_by_request: tally((r) => r.grid?.status === "varies"),
    stable_across_the_grid: tally((r) => r.grid?.status === "stable"),
    inconclusive: tally((r) => r.grid?.status === "inconclusive"),
    note:
      "varies_by_request is positive evidence of per-request assembly and moves a show off measured_clean. " +
      "stable_across_the_grid is NOT a clean bill: it means this delivery path does not lie in the way " +
      "atelier.flightcast.com does, and stability across requests is consistent with a static file AND " +
      "with a stitcher that did not vary for us. inconclusive rows never got the comparison made — a refused or headerless cell, most often an origin answering unranged requests chunked — and learned nothing.",
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

export function parseArgs(argv) {
  const n = Number(arg(argv, "--per-show", String(EPISODES_PER_SHOW)));
  const limit = Number(arg(argv, "--limit", ""));
  return {
    perShow: Number.isFinite(n) && n > 0 ? Math.floor(n) : EPISODES_PER_SHOW,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    hosts: list(argv, "--host", ""),
    yieldPath: arg(argv, "--yield", "data/breadth-transcript-yield.json"),
    measured: list(argv, "--measured", "data/breadth-suspect-inflation.json,data/breadth-anchorable-inflation.json"),
    out: arg(argv, "--out", "data/breadth-clean-regrid.json"),
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
  const results = (prev?.results || []).map((r) => {
    const grid = showGridVerdict(r.grids);
    /* THE FETCH NOTE STILL WINS, and survives re-derivation: "the feed would
       not load" explains a row better than any verdict drawn from the grids
       that failure prevented. It is recovered from the stored note's prefix
       because it is the one fact on the row that no grid can reconstruct. */
    const fetchNote = typeof r.note === "string" && r.note.includes(" — PROBE GRID:")
      ? r.note.slice(0, r.note.indexOf(" — PROBE GRID:"))
      : null;
    const note = verdictNote(grid, { perShow });
    return { ...r, grid, note: fetchNote ? `${fetchNote} — ${note}` : note };
  });
  return { ...prev, results, summary: summarise(results), rederived_at: new Date().toISOString() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readJson = (p) => JSON.parse(readFileSync(resolvePath(process.cwd(), p), "utf8"));
  if (args.rederive) {
    const p = resolvePath(process.cwd(), args.out);
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

  const pool = cleanShows(
    args.measured.filter((p) => existsSync(resolvePath(process.cwd(), p))).map(readJson),
    { limit: args.limit, hosts: args.hosts },
  );
  const poolTranscripts = pool.reduce((n, r) => n + r.timed_transcripts, 0);

  console.log(
    `measured_clean pool: ${pool.length} show(s), ${poolTranscripts} timed transcripts` +
      (coverage ? ` (coverage file says ${coverage.shows} / ${coverage.timed_transcripts})` : ""),
  );
  console.log(`${args.perShow} episode(s) per show, 4 requests each — at most ${pool.length * args.perShow * 4} requests, no bodies\n`);

  if (args.dryRun) {
    for (const s of pool) {
      console.log(`  ${String(s.timed_transcripts).padStart(5)} timed  ${String(s.enclosure_host).padEnd(28)} ${s.title}`);
    }
    return 0;
  }

  const outPath = resolvePath(process.cwd(), args.out);
  const carried = new Map();
  const priorRequests = { feeds: 0, grid_requests: 0 };
  if (args.resume && existsSync(outPath)) {
    /* CARRIED FORWARD KEYED, and the request count carried with them. Both
       rules are `measure-suspects.mjs`'s, learned there from a reviewer: a
       resumed run that rewrites the file with only its own rows deletes
       evidence, and one that reports only its own requests understates the
       politeness cost of a two-pass measurement to anyone auditing it later. */
    const prior = JSON.parse(readFileSync(outPath, "utf8"));
    priorRequests.feeds = prior.requests?.feeds || 0;
    priorRequests.grid_requests = prior.requests?.grid_requests || 0;
    for (const r of prior.results || []) {
      /* ONLY A SETTLED ROW IS CARRIED. An `inconclusive` row is precisely the
         one a resumed run exists to re-attempt, so carrying it would make
         `--resume` permanently unable to improve the file. */
      if (r?.show_id != null && (r.grid?.status === "stable" || r.grid?.status === "varies")) carried.set(String(r.show_id), r);
    }
    console.log(`--resume: ${carried.size} prior row(s) already probed in ${args.out}\n`);
  }

  const started = Date.now();
  let feeds = 0;
  let gridRequests = 0;
  const rows = [];

  for (const s of pool) {
    if (carried.has(s.show_id)) {
      rows.push(carried.get(s.show_id));
      continue;
    }
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
        console.error("No further requests were made. Re-run with --resume once the host is happy.");
        writeJsonAtomic(outPath, {
          version: 1,
          generated_at: new Date().toISOString(),
          stopped_early: { reason: `HTTP ${stop[0].status}`, host: stop[0].host, url: stop[0].url },
          episodes_per_show: args.perShow,
          requests: { feeds: priorRequests.feeds + feeds, grid_requests: priorRequests.grid_requests + gridRequests },
          results: rows,
        });
        return 2;
      }
    }

    const verdict = showGridVerdict(grids);
    const row = {
      ...s,
      grid: verdict,
      note: note ? `${note} — ${verdictNote(verdict, { perShow: args.perShow })}` : verdictNote(verdict, { perShow: args.perShow }),
      grids,
    };
    rows.push(row);
    console.log(
      `${String(s.timed_transcripts).padStart(5)} timed  ${String(s.enclosure_host).padEnd(28)} ` +
        `${verdict.status.padEnd(10)} ${verdict.episodes_informative}/${verdict.episodes_probed} informative  ` +
        `${verdict.varies_by_request ? `<-- VARIES BY REQUEST: ${verdict.varying_totals.join(" / ")}` : ""}  ${s.title}`,
    );
  }

  const summary = summarise(rows);
  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    method:
      "tools/transcribe/decode-compare.mjs probeGrid (#323) re-run over every measured_clean show: for each " +
      "probed episode, four requests for one URL's length — 2-byte ranged GET and unranged, under both " +
      "outbound identities. No body is read; the unranged calls are aborted as their headers arrive.",
    policy:
      "This file can move a show OFF measured_clean and can never move one onto it. See verdictNote: a grid " +
      "that agrees with itself says this delivery path does not lie the way atelier.flightcast.com does, " +
      "which is a statement about one instrument, not a clean bill.",
    source: { yield: args.yieldPath, measured: args.measured },
    episodes_per_show: args.perShow,
    requests: {
      feeds: priorRequests.feeds + feeds,
      grid_requests: priorRequests.grid_requests + gridRequests,
      elapsed_sec: Math.round((Date.now() - started) / 1000),
    },
    summary,
    results: rows,
  };
  writeJsonAtomic(outPath, out);

  console.log(`\n  audited              ${String(summary.audited.timed_transcripts).padStart(5)} timed in ${String(summary.audited.shows).padStart(2)} show(s)`);
  console.log(`  VARIES BY REQUEST    ${String(summary.varies_by_request.timed_transcripts).padStart(5)} timed in ${String(summary.varies_by_request.shows).padStart(2)} show(s)`);
  console.log(`  stable across grid   ${String(summary.stable_across_the_grid.timed_transcripts).padStart(5)} timed in ${String(summary.stable_across_the_grid.shows).padStart(2)} show(s)  (NOT a clean bill)`);
  console.log(`  inconclusive         ${String(summary.inconclusive.timed_transcripts).padStart(5)} timed in ${String(summary.inconclusive.shows).padStart(2)} show(s)`);
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
