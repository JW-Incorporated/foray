/* score.mjs — the five-pillar quality scorecard, one MQ row per Foray (GV-24).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-24 from W1-11; #1286)
 * The Foray Generation Baseline lists twenty-one quality metrics, MQ-01..MQ-21,
 * and until now each lived in a different place or nowhere: a few on the run's
 * `report.json`, some only measurable on the candidate Foray, the judged ones
 * waiting on judges that do not exist yet, and the listening one in the
 * founder's cards. This module puts them on ONE row per Foray, off the timed
 * path, saying for every cell where it came from.
 *
 *   scoreCandidate({ candidate, entry, pool, sources, judged, listen, tierTargets })
 *     -> { "MQ-01": { value, source, note }, ..., "MQ-21": { ... } }
 *
 * `source` is the metric's producer: "report" (the run's report entry),
 * "candidate" (measured here on the candidate Foray), "judged" (a judged.json
 * from the offline judge pass, GV-92, or the report's own judge fields once the
 * in-pipeline judges exist) or "listen" (the founder's listening cards, GV-08).
 *
 * RULE 1 OF THE BENCH HOLDS HERE TOO: ABSENT IS NULL, NEVER 0. A metric this
 * row cannot know is `value: null` with a `note` saying why ("no report", "no
 * narration scripts", "no judged file"). A clip-only Foray has NO voice, not a
 * voice that scored zero; a published Foray has no run report, so its veracity
 * metrics are absent by construction, not failed.
 *
 * WHAT IS COMPUTED HERE (from the candidate)
 *   MQ-06  clean-cut share: segment items whose MINTED row landed on a `turn` or
 *          `sentence` boundary (Q-01, tapeExtent.ts), over every segment item.
 *          A pool row's edges were a curator's, so it counts as unknown, never
 *          clean; `claim-only` is known and not clean.
 *   MQ-07  distinct shows, distinct episodes, the largest show's share of tape.
 *          Show: the candidate's own segmentSources, then data/segment-sources
 *          .json, then the pool row's show_id. The report's veracity.showVariety
 *          (GV-83) wins when the report carries it.
 *   MQ-08  tape over runtime, median clip, share of clips under 60 s (run.mjs's
 *          clipDurations / clipStats, so the bench and the scorecard measure
 *          the same clips).
 *   MQ-14  tier fit = runtimeSec / tier target. The report's veracity.tierFit
 *          (GV-106) wins; else entry.tierTargetSec (R2-15); else the PROPOSED
 *          table below.
 *   MQ-15..18  voice-metrics.mjs (GV-10) over the narration scripts.
 *   MQ-19  narratorStructureLeaks over the narration scripts
 *          (backend/src/copy/narratorStructure.js, imported as check-narration
 *          does).
 *
 * WHAT IS READ (never computed here)
 *   report: MQ-01 groundedQuoteRate, MQ-04 unverifiedPages, MQ-09 tapeYield,
 *           MQ-11 beatCoverage, MQ-13 introRestates, MQ-21 entry.publishable
 *   judged: MQ-02 supportedSentenceRate, MQ-03 attributionAccuracy,
 *           MQ-05 clipOnSubjectRate, MQ-10 promptFit, MQ-12 seamCoherence
 *   listen: MQ-20 mean overall of the founder's cards (unseal.listenByCandidate)
 *
 * PUBLISHED FORAYS AND THE REFERENCE SCORECARD
 *   node tools/generation-bench/score.mjs --forays data/forays.json [--ids a,b]
 *   node tools/generation-bench/score.mjs --forays data/forays.json --write
 *   node tools/generation-bench/score.mjs --forays data/forays.json --check
 * score Forays that have no report. Only voice, tape, structure and runtime
 * apply. `--write` writes golden/reference-scorecard.jsonl (or `--out`); every
 * row is labelled 'curated clip-only' or 'generated pre-Q-03' and is a
 * REFERENCE, not a target: the four generated ones come from the pre-Q-03
 * writer the founder called clunky, and no metric is tuned towards them.
 * `--check` re-derives the rows and reports drift (exit 1). It is a CLI check,
 * deliberately not a unit test, so a later change to data/forays.json cannot
 * break CI. MQ-20 is left out of the reference unless `--listen-keys` is
 * passed: the pack keys live on one machine, and a committed file that changed
 * with the machine it was checked on would drift by construction.
 *
 * ONE CANDIDATE
 *   node tools/generation-bench/score.mjs --candidate <foray.json> [--report <report.json>
 *     [--entry N]] [--judged <file>] [--segments <pool>] [--segment-sources <file>]
 *     [--cards <store.jsonl>] [--listen-keys <dir>]
 * prints one JSON line. A judged file beside the candidate
 * (`<candidate>.judged.json`, GV-92's output name) is read when `--judged` is
 * not given.
 *
 * It spends no model call and reads no network: every number here is code over
 * committed or local files.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import narratorStructure from "../../backend/src/copy/narratorStructure.js";
import { scoreVoice } from "../foray/voice-metrics.mjs";
import { DEFAULT_STORE as DEFAULT_LISTEN_CARDS, readCards } from "../listening/card.mjs";
import { listenByCandidate } from "../listening/unseal.mjs";
import { clipDurations, clipStats, loadSegmentPool, num, readJson } from "./run.mjs";

const { narratorStructureLeaks } = narratorStructure;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The committed reference file for the 7 Forays in data/forays.json. */
export const REFERENCE_FILE = path.join(HERE, "golden", "reference-scorecard.jsonl");
export const SCORECARD_SCHEMA = "scorecard/1";

/** Every MQ id, in order. A scorecard always carries all 21 keys. */
export const MQ_IDS = Object.freeze(Array.from({ length: 21 }, (_, i) => `MQ-${String(i + 1).padStart(2, "0")}`));

/** The producer each metric comes from. */
export const MQ_SOURCES = Object.freeze({
  "MQ-01": "report",
  "MQ-02": "judged",
  "MQ-03": "judged",
  "MQ-04": "report",
  "MQ-05": "judged",
  "MQ-06": "candidate",
  "MQ-07": "candidate",
  "MQ-08": "candidate",
  "MQ-09": "report",
  "MQ-10": "judged",
  "MQ-11": "report",
  "MQ-12": "judged",
  "MQ-13": "report",
  "MQ-14": "candidate",
  "MQ-15": "candidate",
  "MQ-16": "candidate",
  "MQ-17": "candidate",
  "MQ-18": "candidate",
  "MQ-19": "candidate",
  "MQ-20": "listen",
  "MQ-21": "report"
});

/**
 * MQ-14's fallback targets, in seconds, PROPOSED. Decision 24 of the roadmap:
 * the committed spec values (docs/curation/foray-generation-requirements.md,
 * "~15 min / ~60 min / up to ~180 min") in one table. They conflict with the
 * plan's R2-15 row, which expects a short of 8-12 min; moving short to 10 min
 * is this one line if the golden-set listen prefers it. Used only when neither
 * the report's veracity.tierFit (GV-106) nor entry.tierTargetSec is there.
 */
export const TIER_TARGET_SEC_PROPOSED = Object.freeze({ short: 15 * 60, medium: 60 * 60, long: 180 * 60 });
const TIER_NOTE = "PROPOSED target (committed spec ~15/60/180 min; the R2-15 row expects 8-12 min for short)";

/** MQ-06: the boundary kinds that count as a clean cut. */
export const CLEAN_BOUNDARIES = Object.freeze(["turn", "sentence"]);

/** MQ-08: a clip shorter than this counts toward the short-clip share. */
export const SHORT_CLIP_SEC = 60;

/** The judged fields: the judged.json key (GV-92) and the report's veracity
 * field once an in-pipeline judge writes it. */
export const JUDGED_FIELDS = Object.freeze({
  "MQ-02": "supportedSentenceRate",
  "MQ-03": "attributionAccuracy",
  "MQ-05": "clipOnSubjectRate",
  "MQ-10": "promptFit",
  "MQ-12": "seamCoherence"
});

/**
 * Reference labels for the 7 Forays committed in data/forays.json when this
 * card landed. Three are curated, clip-only (no narration); four were written
 * by the pre-Q-03 generator. Any other id is labelled from its shape.
 */
export const REFERENCE_LABELS = Object.freeze({
  "grilling-history-2": "curated clip-only",
  "capital-types-1": "curated clip-only",
  "geology-plates-1": "curated clip-only",
  "beyond-the-algorithm-engineering-production-ai-s-e6533b": "generated pre-Q-03",
  "how-ai-actually-gets-built-3b83e1": "generated pre-Q-03",
  "the-chain-reaction-how-engineering-disasters-rea-25f1b7": "generated pre-Q-03",
  "what-engineers-actually-do-all-day-e08236": "generated pre-Q-03"
});

/* ------------------------------------------------------------------ */
/* Small readers                                                        */
/* ------------------------------------------------------------------ */

const cell = (id, value, note = null) => ({ value: value === undefined ? null : value, source: MQ_SOURCES[id], note });

/** A rate from a report field that is a number or a `{ rate }` object
 * (GV-26's tapeYield / beatCoverage). */
function rateOf(field) {
  if (num(field) !== null) return field;
  if (field && typeof field === "object") return num(field.rate);
  return null;
}

/** A judged value: a number, or an object carrying `value`, `rate` or `mean`. */
function judgedValueOf(field) {
  if (num(field) !== null) return field;
  if (field && typeof field === "object") return num(field.value) ?? num(field.rate) ?? num(field.mean);
  return null;
}

/** The segment-sources registry as a Map by episode id. Accepts the committed
 * file's shape ({ sources: [...] }), a bare array, or a Map. */
export function sourcesMap(sources) {
  if (sources instanceof Map) return sources;
  const rows = Array.isArray(sources) ? sources : Array.isArray(sources?.sources) ? sources.sources : [];
  return new Map(rows.filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
}

/** data/segment-sources.json (or another registry), or an empty map when the
 * file is not there. */
export function loadSegmentSources(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  return sourcesMap(readJson(file));
}

/** The published shape (`runtime_sec`) and the candidate shape (`runtimeSec`)
 * read the same: a candidate keeps its own field, a published Foray's is
 * copied across. Nothing else is touched. */
export function asCandidate(foray) {
  if (!foray || typeof foray !== "object") return null;
  if (num(foray.runtimeSec) !== null) return foray;
  return { ...foray, runtimeSec: num(foray.runtime_sec) };
}

/** The narration scripts a listener hears: every narration item with a
 * non-empty `script`. A redacted candidate (scripts stripped) has none. */
export function narrationScripts(candidate) {
  const items = Array.isArray(candidate?.items) ? candidate.items : [];
  return items
    .filter((item) => item && item.type === "narration" && typeof item.script === "string" && item.script.trim() !== "")
    .map((item) => ({ id: typeof item.id === "string" ? item.id : undefined, script: item.script }));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ------------------------------------------------------------------ */
/* Candidate-side metrics                                               */
/* ------------------------------------------------------------------ */

/** Each segment item, with its minted row, its pool row and its duration. */
function clipsOf(candidate, pool) {
  const items = (candidate.items || []).filter((item) => item && item.type === "segment");
  const durations = clipDurations(candidate, pool);
  const mintedById = new Map((candidate.segments || []).filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
  return items.map((item, i) => ({
    segmentId: item.segment_id,
    minted: mintedById.get(item.segment_id) || null,
    poolRow: pool.get(item.segment_id) || null,
    durationSec: durations[i]
  }));
}

/** MQ-06: clean cuts over every segment item; null with no clips or with no
 * clip whose boundary is known (nothing was measured, so nothing is 0). */
export function cleanCutShare(clips) {
  if (clips.length === 0) return { value: null, note: "no clips" };
  let clean = 0;
  let known = 0;
  for (const clip of clips) {
    /* Only a minted row's boundary is this run's cut; a pool row is unknown
       even if it carries a boundary of its own. */
    const boundary = clip.minted && typeof clip.minted.boundary === "string" ? clip.minted.boundary : null;
    if (boundary === null) continue;
    known += 1;
    if (CLEAN_BOUNDARIES.includes(boundary)) clean += 1;
  }
  const unknown = clips.length - known;
  if (known === 0) return { value: null, note: `no minted clip records a boundary (${clips.length} clip(s) unknown)` };
  return { value: clean / clips.length, note: `${clean} clean of ${clips.length} clip(s); ${unknown} unknown (pool rows or no boundary), never counted clean` };
}

/** MQ-07 from the candidate: shows, episodes and the largest show's tape. */
export function showVariety(clips, candidate, sources, pool) {
  if (clips.length === 0) return { value: null, note: "no clips" };
  const own = sourcesMap(candidate.segmentSources);
  const registry = sourcesMap(sources);
  const shows = new Set();
  const episodes = new Set();
  const tapeByShow = new Map();
  let unresolved = 0;
  for (const clip of clips) {
    const episode =
      (clip.minted && typeof clip.minted.itemId === "string" && clip.minted.itemId) ||
      (clip.poolRow && typeof clip.poolRow.item_id === "string" && clip.poolRow.item_id) ||
      null;
    if (episode !== null) episodes.add(episode);
    const show =
      (episode !== null && typeof own.get(episode)?.show === "string" && own.get(episode).show) ||
      (episode !== null && typeof registry.get(episode)?.show === "string" && registry.get(episode).show) ||
      (clip.poolRow && typeof clip.poolRow.show_id === "string" && clip.poolRow.show_id) ||
      null;
    if (show === null) {
      unresolved += 1;
      continue;
    }
    shows.add(show);
    if (clip.durationSec !== null) tapeByShow.set(show, (tapeByShow.get(show) || 0) + clip.durationSec);
  }
  if (shows.size === 0) return { value: null, note: `no clip's show resolved (${clips.length} clip(s))` };
  const tape = [...tapeByShow.values()].reduce((a, b) => a + b, 0);
  let largestShow = null;
  for (const [show, sec] of tapeByShow) if (largestShow === null || sec > tapeByShow.get(largestShow)) largestShow = show;
  return {
    value: {
      distinctShows: shows.size,
      distinctEpisodes: episodes.size,
      largestShow,
      largestShowTapeShare: tape > 0 ? tapeByShow.get(largestShow) / tape : null
    },
    note: unresolved ? `${unresolved} of ${clips.length} clip(s) with no resolvable show, left out` : null
  };
}

/** MQ-08: tape over runtime, median clip, share under 60 s. */
export function tapeShape(candidate, clips, pool) {
  if (clips.length === 0) return { value: null, note: "no clips" };
  const stats = clipStats(candidate, pool);
  const measured = clips.map((c) => c.durationSec).filter((d) => d !== null);
  if (measured.length === 0) return { value: null, note: `no clip duration resolved (${clips.length} clip(s))` };
  return {
    value: {
      tapeOfRuntime: stats.tapeOfRuntime,
      medianClipSec: median(measured),
      shareUnder60: measured.filter((d) => d < SHORT_CLIP_SEC).length / measured.length
    },
    note: measured.length < clips.length ? `measured over ${measured.length} of ${clips.length} clips` : null
  };
}

/** MQ-14 from the report, else the candidate's runtime over its tier target. */
export function tierFitOf(candidate, entry, tierTargets = TIER_TARGET_SEC_PROPOSED) {
  const reported = entry?.veracity?.tierFit;
  if (reported && typeof reported === "object" && num(reported.ratio) !== null) {
    return { value: reported.ratio, source: "report", note: `report veracity.tierFit (${reported.tier ?? "tier ?"})` };
  }
  const runtimeSec = num(candidate?.runtimeSec);
  if (runtimeSec === null) return { value: null, note: "no runtime" };
  const tier = typeof entry?.duration === "string" ? entry.duration : typeof entry?.tier === "string" ? entry.tier : null;
  const recorded = num(entry?.tierTargetSec);
  if (recorded !== null && recorded > 0) return { value: runtimeSec / recorded, note: `entry.tierTargetSec ${recorded} s` };
  if (tier === null) return { value: null, note: `no tier recorded (runtime ${Math.round(runtimeSec)} s)` };
  const target = num(tierTargets?.[tier]);
  if (target === null || target <= 0) return { value: null, note: `no target for tier ${tier}` };
  return { value: runtimeSec / target, note: `${tier}: ${target} s, ${TIER_NOTE}` };
}

/* ------------------------------------------------------------------ */
/* The scorecard                                                        */
/* ------------------------------------------------------------------ */

/**
 * One Foray's scorecard. Every argument may be absent:
 *   candidate  — the candidate Foray (or a published one through asCandidate)
 *   entry      — its report entry; null for a published Foray
 *   pool       — Map of data/segments.json rows by id
 *   sources    — the segment-sources registry (Map, array or the file's shape)
 *   judged     — a judged.json object (GV-92)
 *   listen     — { meanOverall, lastListenedAt, cards } (listenByCandidate)
 *   tierTargets — MQ-14's fallback table
 */
export function scoreCandidate({ candidate = null, entry = null, pool = new Map(), sources = null, judged = null, listen = null, tierTargets = TIER_TARGET_SEC_PROPOSED } = {}) {
  const out = {};
  const v = entry && typeof entry.veracity === "object" && entry.veracity !== null ? entry.veracity : null;
  const noReport = entry ? null : "no report: a published Foray carries no run report (absent by construction, RQ-04)";
  const fromReport = (id, value, field) => {
    if (!entry) return cell(id, null, noReport);
    return cell(id, value, value === null ? `report does not carry ${field}` : null);
  };

  /* ---- report ---- */
  out["MQ-01"] = fromReport("MQ-01", v ? num(v.groundedQuoteRate) : null, "veracity.groundedQuoteRate");
  out["MQ-04"] = fromReport("MQ-04", v ? num(v.unverifiedPages) : null, "veracity.unverifiedPages");
  out["MQ-09"] = fromReport("MQ-09", v ? rateOf(v.tapeYield) : null, "veracity.tapeYield (GV-26)");
  out["MQ-11"] = fromReport("MQ-11", v ? rateOf(v.beatCoverage) : null, "veracity.beatCoverage (GV-26)");
  out["MQ-13"] = fromReport("MQ-13", v ? num(v.introRestates) : null, "veracity.introRestates");
  out["MQ-21"] = fromReport("MQ-21", entry && typeof entry.publishable === "boolean" ? entry.publishable : null, "publishable (GV-26)");

  /* ---- judged ---- */
  for (const [id, field] of Object.entries(JUDGED_FIELDS)) {
    const fromFile = judged ? judgedValueOf(judged[id] ?? judged[field]) : null;
    const fromVeracity = v ? judgedValueOf(v[field]) : null;
    if (fromFile !== null) out[id] = cell(id, fromFile, "judged file");
    else if (fromVeracity !== null) out[id] = cell(id, fromVeracity, `report veracity.${field}`);
    else out[id] = cell(id, null, judged ? `judged file has no ${id}` : "no judged file and no in-pipeline judge field");
  }

  /* ---- candidate ---- */
  const noCandidate = "no candidate Foray to measure";
  if (!candidate) {
    for (const id of ["MQ-06", "MQ-07", "MQ-08", "MQ-15", "MQ-16", "MQ-17", "MQ-18", "MQ-19"]) out[id] = cell(id, null, noCandidate);
  } else {
    const clips = clipsOf(candidate, pool);
    const mq06 = cleanCutShare(clips);
    out["MQ-06"] = cell("MQ-06", mq06.value, mq06.note);
    const variety = v?.showVariety;
    if (variety && typeof variety === "object" && num(variety.distinctShows) !== null) {
      out["MQ-07"] = {
        value: {
          distinctShows: variety.distinctShows,
          distinctEpisodes: num(variety.distinctEpisodes),
          largestShow: typeof variety.largestShowKey === "string" ? variety.largestShowKey : null,
          largestShowTapeShare: num(variety.largestShowTapeShare)
        },
        source: "report",
        note: "report veracity.showVariety (GV-83)"
      };
    } else {
      const mq07 = showVariety(clips, candidate, sources, pool);
      out["MQ-07"] = cell("MQ-07", mq07.value, mq07.note);
    }
    const mq08 = tapeShape(candidate, clips, pool);
    out["MQ-08"] = cell("MQ-08", mq08.value, mq08.note);

    const scripts = narrationScripts(candidate);
    if (scripts.length === 0) {
      for (const id of ["MQ-15", "MQ-16", "MQ-17", "MQ-18", "MQ-19"]) out[id] = cell(id, null, "no narration scripts (clip-only or redacted)");
    } else {
      const voice = scoreVoice(scripts);
      const n = `${voice.scripts} script(s), ${voice.words} words`;
      out["MQ-15"] = cell("MQ-15", voice.fkGrade, `${n}; band ${voice.gradeBand[0]}-${voice.gradeBand[1]}, ${voice.scriptsInBand} script(s) in band`);
      out["MQ-16"] = cell("MQ-16", { meanWords: voice.meanWords, maxWords: voice.maxWords, over25: voice.over25, shortShare: voice.shortShare }, `${voice.sentences} sentence(s)`);
      out["MQ-17"] = cell("MQ-17", voice.speakabilityPer100, `${n}; per 100 words`);
      out["MQ-18"] = cell("MQ-18", voice.fillerPer100, `${n}; per 100 words`);
      const leaks = scripts.reduce((sum, s) => sum + narratorStructureLeaks(s.script).length, 0);
      out["MQ-19"] = cell("MQ-19", leaks, `over ${voice.scripts} script(s)`);
    }
  }
  const mq14 = tierFitOf(candidate, entry, tierTargets);
  out["MQ-14"] = mq14.source ? { value: mq14.value, source: mq14.source, note: mq14.note } : cell("MQ-14", mq14.value, mq14.note);

  /* ---- listen ---- */
  out["MQ-20"] =
    listen && num(listen.meanOverall) !== null
      ? cell("MQ-20", listen.meanOverall, `${listen.cards ?? "?"} card(s), last ${typeof listen.lastListenedAt === "string" ? listen.lastListenedAt.slice(0, 10) : "?"}`)
      : cell("MQ-20", null, "no listening card unseals to this Foray here");

  return Object.fromEntries(MQ_IDS.map((id) => [id, out[id]]));
}

/* ------------------------------------------------------------------ */
/* Bench columns (run.mjs --scorecard --wide)                           */
/* ------------------------------------------------------------------ */

const pick = (id, field) => (card) => {
  const value = card?.[id]?.value;
  if (value === null || value === undefined) return null;
  return field ? value[field] ?? null : value;
};

/**
 * The scalar MQ columns run.mjs adds to its --wide table under --scorecard.
 * Detail group: the committed KPI table never shows them. MQ-08's tape over
 * runtime and MQ-20's listen are already bench columns (tape/rt, listen), so
 * they are not repeated.
 */
export const SCORECARD_COLUMNS = Object.freeze([
  { key: "mq01", header: "MQ01", digits: 3, value: pick("MQ-01"), targetNote: "MQ-01 grounded quote rate (report)" },
  { key: "mq02", header: "MQ02", digits: 3, value: pick("MQ-02"), targetNote: "MQ-02 supported-sentence rate (judged)" },
  { key: "mq03", header: "MQ03", digits: 3, value: pick("MQ-03"), targetNote: "MQ-03 attribution accuracy (judged)" },
  { key: "mq04", header: "MQ04", digits: 0, value: pick("MQ-04"), targetNote: "MQ-04 unverified pages (report)" },
  { key: "mq05", header: "MQ05", digits: 3, value: pick("MQ-05"), targetNote: "MQ-05 clip-on-subject rate (judged)" },
  { key: "mq06", header: "MQ06", digits: 3, value: pick("MQ-06"), targetNote: "MQ-06 clean-cut share: minted turn/sentence edges over every clip (candidate)" },
  { key: "mq07_shows", header: "MQ07sh", digits: 0, value: pick("MQ-07", "distinctShows"), targetNote: "MQ-07 distinct shows (report showVariety, else candidate)" },
  { key: "mq07_top", header: "MQ07top", digits: 3, value: pick("MQ-07", "largestShowTapeShare"), targetNote: "MQ-07 largest show's share of tape" },
  { key: "mq08_median", header: "MQ08med", digits: 1, value: pick("MQ-08", "medianClipSec"), targetNote: "MQ-08 median clip seconds (candidate)" },
  { key: "mq08_u60", header: "MQ08<60", digits: 3, value: pick("MQ-08", "shareUnder60"), targetNote: "MQ-08 share of clips under 60 s (candidate)" },
  { key: "mq09", header: "MQ09", digits: 3, value: pick("MQ-09"), targetNote: "MQ-09 tape yield (report, GV-26)" },
  { key: "mq10", header: "MQ10", digits: 2, value: pick("MQ-10"), targetNote: "MQ-10 prompt fit (judged)" },
  { key: "mq11", header: "MQ11", digits: 3, value: pick("MQ-11"), targetNote: "MQ-11 beat coverage (report, GV-26)" },
  { key: "mq12", header: "MQ12", digits: 2, value: pick("MQ-12"), targetNote: "MQ-12 seam coherence (judged)" },
  { key: "mq13", header: "MQ13", digits: 0, value: pick("MQ-13"), targetNote: "MQ-13 intro restates (report)" },
  { key: "mq14", header: "MQ14", digits: 2, value: pick("MQ-14"), targetNote: "MQ-14 tier fit, runtime / tier target (report tierFit, else candidate; table PROPOSED)" },
  { key: "mq15", header: "MQ15", digits: 1, value: pick("MQ-15"), targetNote: "MQ-15 Flesch-Kincaid grade of the narration (band 6-9, OQ-02)" },
  { key: "mq16_over25", header: "MQ16>25", digits: 0, value: pick("MQ-16", "over25"), targetNote: "MQ-16 narration sentences over 25 words" },
  { key: "mq17", header: "MQ17", digits: 2, value: pick("MQ-17"), targetNote: "MQ-17 speakability hits per 100 words" },
  { key: "mq18", header: "MQ18", digits: 2, value: pick("MQ-18"), targetNote: "MQ-18 filler hits per 100 words" },
  { key: "mq19", header: "MQ19", digits: 0, value: pick("MQ-19"), targetNote: "MQ-19 narrator structure leaks" },
  {
    key: "mq21",
    header: "MQ21",
    kind: "text",
    value: (card) => {
      const v = pick("MQ-21")(card);
      return v === null ? null : v ? "yes" : "no";
    },
    targetNote: "MQ-21 publishable: every gate passed (report, GV-26)"
  }
].map((col) => Object.freeze({ kind: "number", from: "scorecard", group: "detail", width: col.header.length, ...col })));

/** The scorecard's scalar column values, keyed by column key. */
export function scorecardValues(scorecard) {
  return Object.fromEntries(
    SCORECARD_COLUMNS.map((col) => {
      if (!scorecard) return [col.key, null];
      const value = col.value(scorecard);
      return [col.key, col.kind === "text" ? (typeof value === "string" ? value : null) : num(value)];
    })
  );
}

/* ------------------------------------------------------------------ */
/* Judged files and listening                                           */
/* ------------------------------------------------------------------ */

/** GV-92 writes `<candidate>.judged.json` beside the candidate. */
export function judgedPathFor(candidateFile) {
  if (!candidateFile) return null;
  const guess = candidateFile.replace(/\.json$/i, "") + ".judged.json";
  return fs.existsSync(guess) ? guess : null;
}

/**
 * A judged file: one judged.json object, or JSONL rows carrying `candidateId`.
 * Returns a lookup `(id) => judged | null`. A single object without a
 * `candidateId` applies to whichever candidate is scored with it.
 */
export function readJudged(file) {
  const text = fs.readFileSync(file, "utf8");
  let rows;
  try {
    const one = JSON.parse(text);
    rows = Array.isArray(one) ? one : [one];
  } catch {
    rows = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`${file}:${i + 1}: ${err.message}`);
      }
    });
  }
  if (rows.length === 1 && typeof rows[0]?.candidateId !== "string") return () => rows[0];
  const byId = new Map(rows.filter((r) => typeof r?.candidateId === "string").map((r) => [r.candidateId, r]));
  return (id) => byId.get(id) || null;
}

/** listenByCandidate over the store, or null when the keys are not here. */
function loadListen(cardsFile, keyDir) {
  if (!keyDir || !fs.existsSync(keyDir)) return null;
  return listenByCandidate(readCards(cardsFile || DEFAULT_LISTEN_CARDS), { keyDir });
}

/* ------------------------------------------------------------------ */
/* Published Forays and the reference scorecard                         */
/* ------------------------------------------------------------------ */

/** The label a published Foray's row carries: the 7 reference ids by name,
 * anything else by its shape. */
export function labelFor(foray) {
  if (REFERENCE_LABELS[foray.id]) return REFERENCE_LABELS[foray.id];
  if (foray.generated === true) return "generated";
  return narrationScripts(foray).length === 0 ? "curated clip-only" : "curated";
}

/** One published Foray -> one reference line (deterministic, no timestamp). */
export function referenceRow(foray, context = {}) {
  const candidate = asCandidate(foray);
  return {
    schema: SCORECARD_SCHEMA,
    id: foray.id,
    label: labelFor(foray),
    role: "reference, not target",
    runtimeSec: num(candidate.runtimeSec),
    scorecard: scoreCandidate({
      candidate,
      entry: null,
      pool: context.pool || new Map(),
      sources: context.sources || null,
      judged: context.judged ? context.judged(foray.id) : null,
      listen: context.listening ? context.listening.get(foray.id) || null : null
    })
  };
}

/** Every Foray in a forays.json (or the ones named), scored. */
export function scoreForays(doc, context = {}) {
  const all = Array.isArray(doc) ? doc : Array.isArray(doc?.forays) ? doc.forays : [];
  const ids = context.ids && context.ids.length ? context.ids : null;
  if (ids) {
    const missing = ids.filter((id) => !all.some((f) => f.id === id));
    if (missing.length) throw new Error(`no Foray with id ${missing.join(", ")}`);
  }
  return all.filter((f) => !ids || ids.includes(f.id)).map((f) => referenceRow(f, context));
}

/** The JSONL text of a set of rows (LF, trailing newline). */
export function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/**
 * Drift between freshly derived rows and a committed reference text: ids
 * added, ids missing, and per id the MQ cells (or row fields) that changed.
 * An empty array means no drift.
 */
export function referenceDrift(rows, committedText) {
  const committed = committedText
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
  const byId = new Map(committed.map((r) => [r.id, r]));
  const drift = [];
  for (const row of rows) {
    const old = byId.get(row.id);
    if (!old) {
      drift.push(`${row.id}: not in the committed reference`);
      continue;
    }
    for (const key of ["schema", "label", "role", "runtimeSec"]) {
      if (JSON.stringify(old[key]) !== JSON.stringify(row[key])) drift.push(`${row.id}: ${key} ${JSON.stringify(old[key])} -> ${JSON.stringify(row[key])}`);
    }
    for (const id of MQ_IDS) {
      const a = JSON.stringify(old.scorecard?.[id] ?? null);
      const b = JSON.stringify(row.scorecard[id]);
      if (a !== b) drift.push(`${row.id}: ${id} ${a} -> ${b}`);
    }
    byId.delete(row.id);
  }
  for (const id of byId.keys()) drift.push(`${id}: in the committed reference, no longer derived`);
  return drift;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = {
    candidate: null,
    report: null,
    entry: 1,
    forays: null,
    ids: [],
    write: false,
    check: false,
    out: null,
    judged: null,
    segments: null,
    segmentSources: null,
    cards: null,
    listenKeys: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      return value;
    };
    if (a === "--candidate") args.candidate = next();
    else if (a === "--report") args.report = next();
    else if (a === "--entry") args.entry = Number(next());
    else if (a === "--forays") args.forays = next();
    else if (a === "--ids") args.ids.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--write") args.write = true;
    else if (a === "--check") args.check = true;
    else if (a === "--out") args.out = next();
    else if (a === "--judged") args.judged = next();
    else if (a === "--segments") args.segments = next();
    else if (a === "--segment-sources") args.segmentSources = next();
    else if (a === "--cards") args.cards = next();
    else if (a === "--listen-keys") args.listenKeys = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (Boolean(args.candidate) === Boolean(args.forays)) {
    throw new Error("usage: node tools/generation-bench/score.mjs --candidate <foray.json> [--report <report.json>] | --forays <forays.json> [--ids a,b] [--write|--check]");
  }
  if ((args.write || args.check) && !args.forays) throw new Error("--write and --check apply to --forays");
  if (args.write && args.check) throw new Error("pass --write or --check, not both");
  if (args.report && !args.candidate) throw new Error("--report goes with --candidate");
  if (!Number.isInteger(args.entry) || args.entry < 1) throw new Error("--entry is a 1-based entry number");
  return args;
}

/** Runs the CLI. Returns the exit code (0, or 1 on reference drift). */
export function main(argv, out = console.log) {
  const args = parseArgs(argv);
  const pool = loadSegmentPool(args.segments ? path.resolve(args.segments) : path.join(REPO_ROOT, "data", "segments.json"));
  const sources = loadSegmentSources(args.segmentSources ? path.resolve(args.segmentSources) : path.join(REPO_ROOT, "data", "segment-sources.json"));
  const listening = args.listenKeys ? loadListen(args.cards ? path.resolve(args.cards) : null, path.resolve(args.listenKeys)) : null;

  if (args.forays) {
    const judged = args.judged ? readJudged(path.resolve(args.judged)) : null;
    const rows = scoreForays(readJson(path.resolve(args.forays)), { pool, sources, judged, listening, ids: args.ids });
    const file = args.out ? path.resolve(args.out) : REFERENCE_FILE;
    if (args.write) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toJsonl(rows));
      out(`wrote ${rows.length} scorecard row(s) to ${path.relative(REPO_ROOT, file).replace(/\\/g, "/")}`);
      return 0;
    }
    if (args.check) {
      if (!fs.existsSync(file)) {
        out(`reference-scorecard: ${file} is missing`);
        return 1;
      }
      const drift = referenceDrift(rows, fs.readFileSync(file, "utf8"));
      if (drift.length === 0) {
        out(`reference-scorecard: no drift (${rows.length} Foray(s))`);
        return 0;
      }
      out(`reference-scorecard: DRIFT in ${drift.length} cell(s)`);
      for (const line of drift) out(`  ${line}`);
      return 1;
    }
    for (const row of rows) out(JSON.stringify(row));
    return 0;
  }

  const candidateFile = path.resolve(args.candidate);
  const candidate = asCandidate(readJson(candidateFile));
  let entry = null;
  if (args.report) {
    const report = readJson(path.resolve(args.report));
    const entries = Array.isArray(report.entries) ? report.entries : [];
    entry = entries[args.entry - 1] || null;
    if (!entry) throw new Error(`${args.report} has no entry ${args.entry}`);
  }
  const id = typeof candidate?.id === "string" ? candidate.id : path.basename(candidateFile, ".json");
  const judgedFile = args.judged ? path.resolve(args.judged) : judgedPathFor(candidateFile);
  const judged = judgedFile ? readJudged(judgedFile)(path.basename(candidateFile, ".json")) : null;
  const listenId = path.basename(candidateFile, ".json");
  const scorecard = scoreCandidate({
    candidate,
    entry,
    pool,
    sources,
    judged,
    listen: listening ? listening.get(listenId) || listening.get(id) || null : null
  });
  out(JSON.stringify({ schema: SCORECARD_SCHEMA, id, runtimeSec: num(candidate?.runtimeSec), scorecard }));
  return 0;
}

if (isEntryScript(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }
}
