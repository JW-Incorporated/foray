#!/usr/bin/env node
/* Foray integrity + the tier-A ordering rules — issue #182, issue #134.
 *
 * WHY THIS EXISTS
 * `data/segments.json` is a POOL. `tools/segments/merge-segments.mjs` sorts it
 * by `item_id` then `start_sec`, which is episode order — and a Foray
 * deliberately moves between episodes, so episode order and listening order are
 * different orders. Until `data/forays.json` landed, the listening order lived
 * only in a markdown table in `docs/curation/grilling-foray.md` §2, which meant
 * the tier-A rules in `docs/curation/segment-length-rules.md` §9 — every one of
 * which is a property of an ORDERING, not of a pool — were honour-system only.
 * The first assembly of Foray #1 failed D1 and it was caught by hand.
 *
 * Now that the order is data, they are checkable. This module is where they are
 * checked, and `check-forays.test.mjs` beside it is what makes CI run it.
 *
 * WHY NOT INSIDE `merge-segments.mjs --check`
 * That script's whole contract is "the pool file, and only the pool file" — it
 * both writes and validates `data/segments.json`, and it deliberately refuses to
 * know about anything else. Ordering rules need three files (`forays.json`,
 * `segments.json`, `segment-sources.json`) and none of them is the pool. A
 * sibling keeps the merge validator narrow, which is the property that lets CI
 * run it as a schema gate on a file nobody may hand-edit.
 *
 * NO NETWORK, NO DEPENDENCIES. `tools/` has no package.json and no install
 * step, so this runs from a bare checkout in a keyless Action. The one URL
 * check here is lexical (scheme, tokens); the live 206 check is a separate,
 * manual script (`verify-source-audio.mjs`) precisely because CI must not
 * depend on nine third-party CDNs staying up.
 *
 * USAGE
 *   node tools/foray/check-forays.mjs                # check the committed data
 *   node tools/foray/check-forays.mjs --json         # same, machine-readable
 *   node tools/foray/check-forays.mjs --root <dir>   # check another checkout
 * Exit code 1 on any violation. Warnings never fail.
 *
 * `--root` exists for the suite beside this file: #182's acceptance asks that a
 * D1/D5 break be proven red by breaking one, not by reading the code, and the
 * honest version of that proof runs the real CLI against a deliberately broken
 * copy of the real data and asserts the exit code.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Shared with backend/test/copyRules.test.ts and tools/refresh/merge.mjs, which
 * imports it exactly this way. Imported, not re-declared: two independently
 * drifting copies of this list is the bug docs/DECISIONS.md 2026-07-24
 * consolidated away. It is plain CJS with no build step for this reason. */
import copyRules from "../../backend/src/copy/rules.js";

const { BANNED, wordCount, MAX_WHY_LINE_WORDS } = copyRules;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ------------------------------------------------------------------ rules */

/* D1's budget, from segment-length-rules.md §9: "<= N segment starts per
 * rolling 600 s (N = 8/6/5 by Foray duration)". The bands are the ones
 * grilling-foray.md §5 reads off it. */
export const D1_WINDOW_SEC = 600;
export function d1Budget(runtimeSec) {
  if (runtimeSec <= 45 * 60) return 8;
  if (runtimeSec <= 120 * 60) return 6;
  return 5;
}

/* L2 floors and L3 ceilings, per role, from segment-length-rules.md §9.
 * These are tier-P rules that merge-segments.mjs cannot enforce, because `role`
 * is not part of the schema it writes — grilling-foray.md §4 records that as an
 * open gap ("L2/L3/D4 cannot be re-checked from the committed file"). Recording
 * `role` on the Foray item closes it for every segment a Foray actually plays. */
export const ROLE_FLOOR_SEC = { quote: 30, explanation: 60, exchange: 75, narrative: 120 };
export const ROLE_MAX_SEC = { quote: 90, explanation: 360, exchange: 480, narrative: 480 };
export const L4_SOFT_MAX_SEC = 240;

/* D-tier constants. */
export const D3_MEAN_FLOOR_SEC = 90;
export const D4_QUOTE_SHARE_MAX = 0.2;
export const D4_ADJACENT_QUOTE_MAX = 2;
export const D5_IQR_FLOOR_SEC = 45;
export const D5_TOLERANCE = 0.2;
export const M4_SHARE_MAX = 0.25;

/**
 * D5, first clause: "no 3 consecutive durations within +/-20 % of each other".
 *
 * THE DOC RECORDS THIS AS AMBIGUOUS AND DOES NOT CHOOSE. Two readings:
 *
 *   pairwise      a triple violates if max/min <= 1.2
 *   mean-deviation  a triple violates if all three sit within +/-20 % of the
 *                   triple's own mean
 *
 * THE GATE IMPLEMENTS PAIRWISE. Two reasons, in order of weight:
 *
 *   1. It is what the sentence says. "within +/-20 % of EACH OTHER" is a
 *      statement about the members of the triple, pairwise. The mean is a
 *      fourth quantity the rule never mentions, and reading it in makes the
 *      rule strictly stronger than its own text — 1.2x max/min is ~18 % either
 *      side of the mean, so mean-deviation fires on triples the words do not
 *      reach.
 *   2. Pairwise is the reading the rule's purpose supports. D5 exists to stop a
 *      Foray sounding metronomic. Three segments at 97.9 / 126.7 / 101.8 s do
 *      not sound uniform — the longest is 29 % longer than the shortest — and
 *      that triple is a mean-deviation violation. Gating on it would fail a
 *      Foray that has the variation the rule wants.
 *
 * The mean-deviation reading is NOT discarded: it is computed and reported as a
 * warning, so the three triples grilling-foray.md §5 names stay visible instead
 * of being quietly resolved in our favour.
 */
export function d5Triples(durations, { reading = "pairwise" } = {}) {
  const hits = [];
  for (let i = 0; i + 2 < durations.length; i++) {
    const t = durations.slice(i, i + 3);
    let worst;
    if (reading === "pairwise") {
      const ratio = Math.max(...t) / Math.min(...t);
      if (ratio > 1 + D5_TOLERANCE) continue;
      worst = ratio;
    } else {
      const mean = t.reduce((a, b) => a + b, 0) / 3;
      worst = Math.max(...t.map((d) => Math.abs(d - mean) / mean));
      if (worst > D5_TOLERANCE) continue;
    }
    hits.push({ index: i, durations: t, worst });
  }
  return hits;
}

/** Interquartile range, R-7 / linear interpolation — NumPy's and R's default,
 * and Excel's QUARTILE.INC. D5 names no definition and batch 1 reported the
 * ambiguity rather than picking; R-7 is picked here because it is the default
 * everywhere the number would be independently recomputed. */
export function iqr(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return s[lo] + (h - lo) * (s[hi] - s[lo]);
  };
  return q(0.75) - q(0.25);
}

/**
 * D1: the most segment starts that fall inside any rolling 600 s window.
 *
 * A window is half-open, [t, t+600). The maximum is always attained by a window
 * whose left edge sits on a start, so it is enough to anchor one window per
 * start rather than sweep continuously.
 *
 * Note for anyone reconciling this with grilling-foray.md §5, which says "the
 * tightest run of six spanning 620.5 s": that span is start[i] -> start[i+6],
 * i.e. SEVEN starts and six gaps. The prose counts gaps; this counts starts.
 * Both produce the same verdict on the committed order (max 6 starts in any
 * window, budget 6 — met exactly).
 */
export function maxStartsInWindow(starts, windowSec = D1_WINDOW_SEC) {
  let worst = { count: 0, from: 0, span: 0 };
  for (let i = 0; i < starts.length; i++) {
    let k = 0;
    while (i + k < starts.length && starts[i + k] - starts[i] < windowSec) k++;
    if (k > worst.count) worst = { count: k, from: i, span: starts[i + k - 1] - starts[i] };
  }
  return worst;
}

/* ------------------------------------------------------------------ check */

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check one loaded set of files.
 *
 * @param {{forays: object, segments: object, sources: object, taxonomy: object}} files
 * @returns {{errors: string[], warnings: string[], report: object}}
 */
export function checkForays(files) {
  const errors = [];
  const warnings = [];
  const report = { forays: [], sources: 0 };
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  const { forays: foraysFile, segments: segmentsFile, sources: sourcesFile, taxonomy } = files;

  /* ---- shape */
  if (foraysFile?.version !== 1) return { errors: ["data/forays.json: version must be 1"], warnings, report };
  if (!Array.isArray(foraysFile.forays)) return { errors: ["data/forays.json: `forays` must be an array"], warnings, report };
  if (sourcesFile?.version !== 1) return { errors: ["data/segment-sources.json: version must be 1"], warnings, report };
  if (!Array.isArray(sourcesFile.sources)) return { errors: ["data/segment-sources.json: `sources` must be an array"], warnings, report };

  const segments = new Map((segmentsFile.segments || []).map((s) => [s.id, s]));
  const taxonomyNodes = new Set((taxonomy?.nodes || []).map((n) => n.id));

  /* ---- the source registry -------------------------------------------- */
  const sources = new Map();
  for (const s of sourcesFile.sources) {
    if (!isPlainObject(s) || typeof s.id !== "string" || !s.id) { err("segment-sources: a source has no id"); continue; }
    if (sources.has(s.id)) err(`segment-sources: duplicate source id "${s.id}"`);
    sources.set(s.id, s);

    for (const f of ["show", "title", "audio_url", "audio_type"]) {
      if (typeof s[f] !== "string" || !s[f]) err(`segment-sources "${s.id}": \`${f}\` must be a non-empty string`);
    }
    if (typeof s.duration_sec !== "number" || !(s.duration_sec > 0)) {
      err(`segment-sources "${s.id}": \`duration_sec\` must be a positive number`);
    }
    /* Mirrors ci.yml's data invariants 4 and 5 for discover.json/session.json.
     * They run on those two files by name and this registry is neither, so the
     * same guarantees are re-asserted here rather than assumed. */
    if (typeof s.audio_url === "string") {
      if (!/^https:\/\//.test(s.audio_url)) err(`segment-sources "${s.id}": audio_url must be https`);
      if (/[?&](token|auth|api_?key|secret|password|session)=/i.test(s.audio_url)) {
        err(`segment-sources "${s.id}": audio_url looks tokened (secret leak)`);
      }
    }
    if (typeof s.dai_suspected !== "boolean") {
      err(`segment-sources "${s.id}": \`dai_suspected\` must be a boolean — it gates seek precision (#30), and a missing flag reads as falsy`);
    }
  }
  report.sources = sources.size;

  /* Every episode the pool refers to must be resolvable, or its segments can
   * never be played. This is the whole point of the registry. */
  const poolItemIds = new Set([...segments.values()].map((s) => s.item_id));
  for (const itemId of [...poolItemIds].sort()) {
    if (!sources.has(itemId)) err(`segments reference item_id "${itemId}" with no entry in data/segment-sources.json — nothing can resolve its audio`);
  }
  for (const [id, s] of sources) {
    if (!poolItemIds.has(id)) warn(`segment-sources "${id}" has no segments in the pool`);
    /* Two independent measurements of the same episode: the feed's
     * itunes:duration and the duration the anchors were authored against.
     * They should agree to a second or two; a real disagreement means the
     * wrong episode is registered. */
    for (const seg of segments.values()) {
      if (seg.item_id !== id) continue;
      if (typeof seg.reference_duration_sec === "number" && Math.abs(seg.reference_duration_sec - s.duration_sec) > 2) {
        err(
          `segment-sources "${id}": duration_sec ${s.duration_sec} disagrees with ` +
            `${seg.id}'s reference_duration_sec ${seg.reference_duration_sec} by more than 2 s — wrong episode registered?`
        );
        break;
      }
    }
  }

  /* ---- each Foray ------------------------------------------------------ */
  const seenForayIds = new Set();
  for (const foray of foraysFile.forays) {
    const fid = foray?.id;
    if (typeof fid !== "string" || !fid) { err("forays: a foray has no id"); continue; }
    if (seenForayIds.has(fid)) err(`forays: duplicate foray id "${fid}"`);
    seenForayIds.add(fid);
    const E = (m) => err(`foray "${fid}": ${m}`);
    const W = (m) => warn(`foray "${fid}": ${m}`);

    if (foray.kind !== "deep-dive") E(`\`kind\` must be "deep-dive" (#134); got ${JSON.stringify(foray.kind)}`);
    if (foray.status !== "draft" && foray.status !== "published") E('`status` must be "draft" or "published"');
    /* `title` is deliberately not checked here — the copy loop below already
     * rejects a missing one, and checking it twice reported it twice. */
    if (typeof foray.topic !== "string" || !foray.topic) E("`topic` must be a non-empty string");
    else if (taxonomyNodes.size && !taxonomyNodes.has(foray.topic)) E(`\`topic\` "${foray.topic}" is not a data/taxonomy.json node`);

    /* Copy rules on the fields a UI renders as our own prose. Publisher episode
     * titles in segment-sources.json are quoted fact, not our copy, and are
     * deliberately NOT gated here. */
    for (const [field, text] of [["title", foray.title], ["summary", foray.summary], ...(Array.isArray(foray.slots) ? foray.slots.map((s) => [`slot "${s?.id}" title`, s?.title]) : [])]) {
      if (typeof text !== "string" || !text) { E(`${field} must be a non-empty string`); continue; }
      if (wordCount(text) > MAX_WHY_LINE_WORDS) E(`${field} is ${wordCount(text)} words, over the ${MAX_WHY_LINE_WORDS}-word limit: "${text}"`);
      for (const rx of BANNED) if (rx.test(text)) E(`${field} contains banned phrase ${rx}: "${text}"`);
    }

    if (!Array.isArray(foray.items) || foray.items.length === 0) { E("`items` must be a non-empty ordered array"); continue; }

    const slotIds = Array.isArray(foray.slots) ? foray.slots.map((s) => s?.id) : [];
    if (new Set(slotIds).size !== slotIds.length) E("`slots` has duplicate ids");

    /* ---- resolve items */
    const played = [];
    const seenLabels = new Set();
    const seenSegmentIds = new Set();
    let itemsOk = true;
    for (const [i, item] of foray.items.entries()) {
      const at = `items[${i}]`;
      if (!isPlainObject(item)) { E(`${at} is not an object`); itemsOk = false; continue; }
      /* Narration bridges are the other member of #134's typed list. None are
       * authored yet (grilling-foray.md §5: "no bridge records exist yet"), so
       * they are accepted and skipped rather than rejected — a Foray that grows
       * bridges must not have to change this file to stay valid. */
      if (item.type === "narration") {
        if (typeof item.id !== "string" || !item.id) E(`${at}: a narration item needs an id`);
        continue;
      }
      if (item.type !== "segment") { E(`${at}: unknown item type ${JSON.stringify(item.type)}`); itemsOk = false; continue; }

      const seg = segments.get(item.segment_id);
      if (!seg) { E(`${at}: unknown segment_id "${item.segment_id}" — not in data/segments.json`); itemsOk = false; continue; }
      if (seenSegmentIds.has(item.segment_id)) E(`${at}: segment "${item.segment_id}" appears twice in one Foray`);
      seenSegmentIds.add(item.segment_id);

      if (slotIds.length && !slotIds.includes(item.slot)) E(`${at}: slot "${item.slot}" is not declared in \`slots\``);

      /* The label is the recorded ORI-1 / GRID-3 mapping from
       * grilling-foray.md §2. It exists so nobody has to re-derive the mapping
       * from (episode, duration) again — and `label_prefixes` is what makes it
       * checkable rather than decorative. */
      if (typeof item.label === "string" && item.label) {
        if (seenLabels.has(item.label)) E(`${at}: duplicate label "${item.label}"`);
        seenLabels.add(item.label);
        const prefixes = isPlainObject(foray.label_prefixes) ? foray.label_prefixes : null;
        if (prefixes) {
          const prefix = item.label.split("-")[0];
          const expected = prefixes[prefix];
          if (!expected) E(`${at}: label "${item.label}" has no prefix entry in \`label_prefixes\``);
          else if (expected !== seg.item_id) {
            E(`${at}: label "${item.label}" maps to episode "${expected}" but segment "${seg.id}" is from "${seg.item_id}"`);
          }
        }
      }

      /* `role` is proposed in segment-length-rules.md §9 but is not part of the
       * schema merge-segments.mjs writes, so today it can only live here.
       * Prefer the segment's own copy the day it gains one — this is a
       * temporary home, not a second source of truth. */
      const role = seg.role ?? item.role ?? null;
      if (role !== null && !["quote", "explanation", "exchange", "narrative"].includes(role)) {
        E(`${at}: role "${role}" is not in the L6 enum`);
      }
      if (seg.role && item.role && seg.role !== item.role) {
        E(`${at}: role "${item.role}" disagrees with segment "${seg.id}"'s role "${seg.role}" — the segment wins; drop the copy here`);
      }

      played.push({ ...item, seg, role, duration: seg.end_sec - seg.start_sec });
    }
    /* An unresolvable item used to skip every ordering rule for the whole
     * Foray and leave `report.forays` empty, so one bad segment_id hid D1, D5,
     * M3, M4 and the audio check behind it — and any caller reading
     * `report.forays[0]` got `undefined`. CI was still red, but the output was
     * useless for fixing anything. Now the unresolvable items are dropped, the
     * rest is judged, and the fact that the verdicts are partial is said out
     * loud rather than inferred from a missing line. */
    if (played.length === 0) { E("no resolvable segment items"); continue; }
    if (!itemsOk) {
      W(`${foray.items.length - played.length} item(s) did not resolve; every rule below is judged on the ${played.length} that did, so these verdicts are partial`);
    }

    /* ---- derived */
    const durations = played.map((p) => p.duration);
    const runtime = durations.reduce((a, b) => a + b, 0);
    const starts = [];
    let t = 0;
    for (const d of durations) { starts.push(t); t += d; }
    const mean = runtime / durations.length;

    /* A stated runtime is a drift detector: swap a segment for one of a
     * different length and this is what notices. */
    if (typeof foray.runtime_sec === "number" && Math.abs(foray.runtime_sec - runtime) > 0.5) {
      E(`\`runtime_sec\` says ${foray.runtime_sec.toFixed(2)} but the items sum to ${runtime.toFixed(2)}`);
    }

    /* ---- slots appear as contiguous blocks, in the declared order */
    if (slotIds.length) {
      const seq = played.map((p) => p.slot);
      const blocks = seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
      if (new Set(blocks).size !== blocks.length) E(`slots are interleaved rather than contiguous: ${blocks.join(" -> ")}`);
      const declared = slotIds.filter((s) => blocks.includes(s));
      if (blocks.join("|") !== declared.join("|")) E(`slot blocks play as ${blocks.join(" -> ")} but \`slots\` declares ${declared.join(" -> ")}`);
    }

    /* ---- D1: rolling cut budget
     *
     * TODO(bridges): `starts` is the TAPE timeline — the cumulative sum of
     * segment durations. The rule is about the listener's 600 s window, and
     * today the two are the same thing because narration items contribute 0 s
     * and none exist. The moment a bridge is authored with a duration, every
     * start after it shifts later in playback and this becomes strictly
     * conservative: it will report more starts per window than the listener
     * hears, so it can fail a Foray that is actually fine. Fix it by summing
     * bridge durations into `starts` when the narration record gains one; the
     * warning below is here so that day is noticed rather than discovered. */
    if (foray.items.some((i) => i?.type === "narration")) {
      W("D1 is computed on the tape timeline; narration items contribute 0 s, so the budget is measured against a shorter clock than the listener's");
    }
    const budget = d1Budget(runtime);
    const worst = maxStartsInWindow(starts);
    if (worst.count > budget) {
      E(
        `D1 FAIL: ${worst.count} segment starts inside a ${D1_WINDOW_SEC} s window ` +
          `(budget ${budget} for a ${(runtime / 60).toFixed(1)}-minute Foray). ` +
          `Tightest run begins at ${played[worst.from].label ?? played[worst.from].segment_id} ` +
          `and spans ${worst.span.toFixed(1)} s.`
      );
    }

    /* ---- D2: at most 2 consecutive segments under 60 s, and the next >= 150 s
     *
     * Walked as RUNS, not as a sliding pair. A pair-wise loop reports a run of
     * three twice (once from each overlapping pair) and — the real bug — cannot
     * fire at all when the two short segments are the LAST two, because it
     * reaches for a recovery segment that does not exist. A Foray that ends on
     * two 50-second segments breaks the rule exactly as much as one that
     * continues into a third; there is simply no segment left to recover. */
    for (let i = 0; i < durations.length; ) {
      if (durations[i] >= 60) { i++; continue; }
      let j = i;
      while (j < durations.length && durations[j] < 60) j++;
      const runLength = j - i;
      const name = played[i].label ?? played[i].segment_id;
      if (runLength > 2) {
        E(`D2 FAIL: ${runLength} consecutive segments under 60 s starting at ${name}`);
      } else if (runLength === 2) {
        if (j >= durations.length) {
          E(`D2 FAIL: the Foray ends on two consecutive segments under 60 s (${name} onward); the rule requires a following segment of at least 150 s, and there is none`);
        } else if (durations[j] < 150) {
          E(`D2 FAIL: two consecutive segments under 60 s at ${name} are followed by ${durations[j].toFixed(1)} s, under the 150 s recovery floor`);
        }
      }
      i = j;
    }

    /* ---- L2/L3/L4: per-role duration bounds, checkable at last (see above) */
    for (const p of played) {
      if (!p.role) continue;
      const name = p.label ?? p.segment_id;
      if (p.duration < ROLE_FLOOR_SEC[p.role]) E(`L2 FAIL: ${name} is ${p.duration.toFixed(1)} s, under the ${ROLE_FLOOR_SEC[p.role]} s floor for \`${p.role}\``);
      if (p.duration > ROLE_MAX_SEC[p.role]) E(`L3 FAIL: ${name} is ${p.duration.toFixed(1)} s, over the ${ROLE_MAX_SEC[p.role]} s maximum for \`${p.role}\``);
      /* L4 is a burden-of-proof flip, not a ceiling: past 240 s a segment must
       * say WHY. The escape hatch has to be reachable or the rule is silently a
       * hard reject — and `long_reason` is one of §9's *proposed* additive
       * fields, so `merge-segments.mjs` does not write it today. It is
       * therefore accepted from the Foray item as well, the same interim home
       * `role` uses, and the segment's own value wins the day it exists. */
      const longReason = p.seg.long_reason ?? p.long_reason ?? null;
      const flagged = p.seg.needs_review === true || p.needs_review === true;
      if (p.duration > L4_SOFT_MAX_SEC && !(flagged && longReason)) {
        E(
          `L4 FAIL: ${name} is ${p.duration.toFixed(1)} s, past the ${L4_SOFT_MAX_SEC} s soft maximum, ` +
            `without \`needs_review: true\` and a \`long_reason\`. Neither field is in the segment schema yet ` +
            `(§9 proposes them), so set both on the Foray item until it is.`
        );
      }
    }

    /* ---- D3: mean duration floor */
    if (mean < D3_MEAN_FLOOR_SEC) E(`D3 FAIL: mean segment duration ${mean.toFixed(1)} s is under the ${D3_MEAN_FLOOR_SEC} s floor`);

    /* ---- D4: quote share and adjacency (skipped when no roles are recorded) */
    const roles = played.map((p) => p.role);
    if (roles.every((r) => r !== null)) {
      const quotes = roles.filter((r) => r === "quote").length;
      if (quotes / roles.length > D4_QUOTE_SHARE_MAX) {
        E(`D4 FAIL: ${quotes}/${roles.length} segments are \`quote\`, over the ${D4_QUOTE_SHARE_MAX * 100} % cap`);
      }
      let run = 0;
      for (const [i, r] of roles.entries()) {
        run = r === "quote" ? run + 1 : 0;
        if (run > D4_ADJACENT_QUOTE_MAX) { E(`D4 FAIL: ${run} adjacent \`quote\` segments ending at ${played[i].label ?? played[i].segment_id}`); break; }
      }
    } else {
      W("D4 not evaluated — not every item records a `role`");
    }

    /* ---- D5: anti-uniformity */
    const d5 = d5Triples(durations, { reading: "pairwise" });
    for (const hit of d5) {
      const names = played.slice(hit.index, hit.index + 3).map((p) => p.label ?? p.segment_id);
      E(
        `D5 FAIL: ${names.join(" / ")} are ${hit.durations.map((d) => d.toFixed(1)).join(" / ")} s — ` +
          `three consecutive durations within +/-${D5_TOLERANCE * 100} % of each other (max/min ${hit.worst.toFixed(3)})`
      );
    }
    for (const hit of d5Triples(durations, { reading: "mean-deviation" })) {
      const names = played.slice(hit.index, hit.index + 3).map((p) => p.label ?? p.segment_id);
      W(`D5 (mean-deviation reading, not gated): ${names.join(" / ")} worst deviation ${(hit.worst * 100).toFixed(1)} %`);
    }
    const spread = iqr(durations);
    if (spread < D5_IQR_FLOOR_SEC) E(`D5 FAIL: interquartile range ${spread.toFixed(1)} s is under the ${D5_IQR_FLOOR_SEC} s floor (R-7)`);

    /* ---- M3: same-episode segments never out of chronological order */
    const lastStart = new Map();
    for (const p of played) {
      const prev = lastStart.get(p.seg.item_id);
      if (prev !== undefined && p.seg.start_sec < prev) {
        E(`M3 FAIL: ${p.label ?? p.segment_id} plays at ${p.seg.start_sec} s of "${p.seg.item_id}" after a later segment from the same episode`);
      }
      lastStart.set(p.seg.item_id, p.seg.start_sec);
    }

    /* ---- M4: no one episode over 25 % of segments or runtime */
    const byEpisode = new Map();
    for (const p of played) {
      const e = byEpisode.get(p.seg.item_id) ?? { n: 0, sec: 0 };
      e.n++; e.sec += p.duration;
      byEpisode.set(p.seg.item_id, e);
    }
    for (const [itemId, e] of byEpisode) {
      const nShare = e.n / played.length;
      const secShare = e.sec / runtime;
      if (nShare > M4_SHARE_MAX || secShare > M4_SHARE_MAX) {
        E(`M4 FAIL: "${itemId}" is ${(nShare * 100).toFixed(1)} % of segments and ${(secShare * 100).toFixed(1)} % of runtime, over the ${M4_SHARE_MAX * 100} % cap`);
      }
    }

    /* ---- every played segment resolves to playable audio */
    for (const p of played) {
      const src = sources.get(p.seg.item_id);
      if (!src) continue; // already reported above
      /* #65 §2: an authored timestamp is a foreign copy, and seek precision on
       * a DAI-stitched feed is approximate — which cannot anchor an out-point. */
      if (src.dai_suspected === true) E(`${p.label ?? p.segment_id}: source "${src.id}" is dai_suspected, so its out-point cannot be anchored (#65)`);
      if (typeof src.duration_sec === "number" && p.seg.end_sec > src.duration_sec + 2) {
        E(`${p.label ?? p.segment_id}: end_sec ${p.seg.end_sec} is past the episode's ${src.duration_sec} s`);
      }
    }

    report.forays.push({
      id: fid,
      status: foray.status,
      segments: played.length,
      runtime_sec: +runtime.toFixed(2),
      mean_sec: +mean.toFixed(1),
      d1_budget: budget,
      d1_max_starts_in_window: worst.count,
      d5_iqr_sec: +spread.toFixed(2),
      d5_pairwise_violations: d5.length,
    });
  }

  return { errors, warnings, report };
}

/** Read the four files this checker needs from a checkout. */
export function loadFiles(root = REPO_ROOT) {
  const read = (rel, optional = false) => {
    const p = path.join(root, rel);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- rel is one of four hardcoded repo-relative paths.
    if (optional && !fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  return {
    forays: read("data/forays.json"),
    segments: read("data/segments.json"),
    sources: read("data/segment-sources.json"),
    taxonomy: read("data/taxonomy.json", true),
  };
}

/* --------------------------------------------------------------------- cli */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const rootFlag = process.argv.indexOf("--root");
  if (rootFlag >= 0 && !process.argv[rootFlag + 1]) {
    console.error("--root needs a directory");
    process.exit(2);
  }
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : REPO_ROOT;
  const { errors, warnings, report } = checkForays(loadFiles(root));
  if (json) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, report }, null, 2));
  } else {
    for (const f of report.forays) {
      console.log(
        `${f.id} (${f.status}): ${f.segments} segments, ${(f.runtime_sec / 60).toFixed(1)} min, mean ${f.mean_sec} s\n` +
          `  D1 ${f.d1_max_starts_in_window}/${f.d1_budget} starts per ${D1_WINDOW_SEC} s   ` +
          `D5 ${f.d5_pairwise_violations} triples, IQR ${f.d5_iqr_sec} s`
      );
    }
    console.log(`${report.sources} source episodes registered`);
    for (const w of warnings) console.warn(`WARN ${w}`);
    for (const e of errors) console.error(`FAIL ${e}`);
    console.log(errors.length === 0 ? "forays ok" : `${errors.length} violation(s)`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
