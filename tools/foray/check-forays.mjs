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

/* Same discipline, same reason: a narration item's duration is resolved by ONE
 * rule, and the player owns it because the player is what spends it. Imported
 * rather than re-derived — a second copy of the precedence here is how the
 * checker would come to bless a runtime the player does not agree with.
 * `player/foray-queue.js` is pure ESM with one pure import, so a keyless Action
 * can load it from a bare checkout exactly like `copyRules`. */
import {
  narrationDuration,
  NARRATION_CHARS_PER_SEC,
  DURATION_MEASURED,
  JINGLE_DURATION_SEC,
} from "../../player/foray-queue.js";

/* The six narration modes, imported from check-narration.mjs rather than
 * re-declared. That file already carries the enum (and the char bands each
 * mode budgets to) as `MODE_CHAR_BANDS`; a second copy of the six keys here
 * is exactly the kind of drift `copyRules` above exists to prevent — two
 * lists of "the modes" that could disagree about a seventh. */
import { MODE_CHAR_BANDS } from "./check-narration.mjs";
const NARRATION_MODES = new Set(Object.keys(MODE_CHAR_BANDS));

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

/* Narration ceilings, from docs/curation/narration-craft.md §0.
 *
 * The soft max warns and the hard max fails. Both are that document's own
 * numbers for its longest mode: "Carry soft max 150 s -> needs_review, must
 * state what the extra minute does" and "Carry hard max 180 s. The narrator is
 * never the longest item in the Foray."
 *
 * They are here rather than in `player/foray-queue.js` because the player must
 * play whatever shipped — refusing an over-long bridge at playback would turn an
 * authoring mistake into a silent gap in a listener's ear. A ceiling belongs on
 * the gate, and the gate is this file. */
export const NARRATION_SOFT_MAX_SEC = 150;
export const NARRATION_HARD_MAX_SEC = 180;

/* The shortest legal narration item, from narration-craft §0's Hinge row. A
 * "script" below it is not a short bridge, it is a placeholder — and a
 * placeholder that estimates to a fraction of a second reintroduces the bug this
 * check exists to close, just with a smaller number than zero.
 *
 * DERIVED FROM THE CHARACTER FIGURE, NOT THE SECONDS FIGURE, because the row's
 * own two numbers disagree: it says "3-8 s, 50-135 characters", and 50
 * characters at that document's own 17 chars/s is 2.94 s, not 3. Hard-coding 3
 * rejected a 50-character Hinge — the documented minimum. narration-craft's
 * preamble settles which to trust: "the word budgets are the primitive". Rounded
 * the same way an estimate is, so the boundary is exact in both directions. */
export const NARRATION_MIN_CHARS = 50;
export const NARRATION_MIN_SEC = Math.round((NARRATION_MIN_CHARS / NARRATION_CHARS_PER_SEC) * 1000) / 1000;

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

/* §7 item 5 / §4.7's "impossible to publish without it" disclosure gate.
 *
 * WHAT FLAGS A FORAY AS GENERATED. §3's input schema stamps `author_id` and
 * `visibility` on every generation REQUEST, but neither survives onto the
 * published `data/forays.json` record today, and inferring "generated" from
 * shape (e.g. "has any narration item") would misclassify the admin-authored
 * backdoor §1.2 explicitly keeps legal: a curated Foray may carry narration
 * too. So this checker requires an explicit, additive marker — `generated:
 * true` on the Foray object — rather than guessing from other fields. None of
 * the four committed Forays carry it, so none of the checks below can fire on
 * them; the day the pipeline in §4 lands, its publish step (§4.9) is what sets
 * this bit, on purpose, once.
 *
 * WHY THIS GATE IS NARROWER THAN "any narration item exists": the admin
 * backdoor (§1.2) is real narration, on a foray nobody generated, and must
 * not be held to §4.7's disclosure requirement or §2.1's mode enum — an
 * admin's own pre-rendered voice line has no "mode" in the generation sense.
 */
const isGeneratedForay = (foray) => foray?.generated === true;

/* §4.7's exact required template, verbatim, with the one variable slot
 * (`<subject>`) as a wildcard. Matched as a whole line so a generated Foray
 * cannot ship a paraphrase that drifts from what legal signed off on — "It
 * should be impossible to publish without it" is a statement about the exact
 * words, not the gist. */
const DISCLOSURE_RX =
  /^This is a Foray about .+\. Much of what you'll hear is written by AI\. We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source\.$/;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Same predicate `player/foray-queue.js` uses to decide an asset is present, so
    the two cannot disagree about whether an item will play. */
const nonEmptyString = (s) => typeof s === "string" && s.trim().length > 0;

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

    /* §7 item 5, clause 3 / §4.7: "a generated Foray whose first item is not
     * the disclosure fails validation. It should be impossible to publish
     * without it." Checked on the raw first item, ahead of and independent
     * of the resolve loop below — a malformed disclosure item must not be
     * able to hide behind `itemsOk` reporting a different failure first, and
     * this is cheap enough to always run before anything else touches
     * `foray.items`. */
    if (isGeneratedForay(foray)) {
      const first = foray.items[0];
      if (!isPlainObject(first) || first.type !== "narration" || typeof first.script !== "string" || !DISCLOSURE_RX.test(first.script.trim())) {
        E("items[0] is not the required disclosure — generation-architecture.md §4.7's exact template must be the first narration item's `script` in every generated Foray");
      }
    }

    const slotIds = Array.isArray(foray.slots) ? foray.slots.map((s) => s?.id) : [];
    if (new Set(slotIds).size !== slotIds.length) E("`slots` has duplicate ids");

    /* ---- resolve items */
    const played = [];
    /* Every item that occupies the listener's clock, in authored order — tape
     * AND narration. `played` is the tape-only list every per-segment rule reads
     * (D2, D3, D5, L2/L3/L4, M3, M4 are all about segments); `timeline` is what
     * D1 measures its 600 s windows on, because §5c says "600-second window of
     * Foray PLAYBACK" and a bridge is playback. */
    const timeline = [];
    const narrations = [];
    /** Every jingle, tallied the same shallow way `narrations` is — its own
        list rather than folded into `narrations`, because a jingle is not
        narration (§7 item 4's whole point) and `narrations.length` feeds
        directly into `report.forays[].narration_items`, which must keep
        meaning "narrator lines", not "narrator lines and brand marks". */
    let jingleCount = 0;
    let jingleRuntime = 0;
    /** Authored bridges that have no audio yet, so the player drops them and they
        are excluded from the clock. Counted so the "did not resolve" tally below
        does not blame the ordinary pre-audio state for a failure. */
    let unvoiced = 0;
    const seenLabels = new Set();
    const seenSegmentIds = new Set();
    const seenNarrationIds = new Set();
    let itemsOk = true;
    for (const [i, item] of foray.items.entries()) {
      const at = `items[${i}]`;
      if (!isPlainObject(item)) { E(`${at} is not an object`); itemsOk = false; continue; }
      /* Narration bridges are the other member of #134's typed list. None are
       * authored yet (grilling-foray.md §5: "no bridge records exist yet"), so a
       * Foray that grows one must not have to change this file to stay valid —
       * but it must not be able to grow one that CONTRIBUTES NOTHING either.
       *
       * An item whose length is unknowable is the defect that produced this
       * block: it was accepted with an id and nothing else, so it played for
       * eight seconds and cost zero everywhere — in `runtime_sec`, in D1's
       * clock, in `progressSegments`, and therefore in a listener's resume.
       * `narrationDuration` in `player/foray-queue.js` resolves a length from
       * `duration_sec` (measured) or the `script` (estimated at
       * narration-craft's 17 chars/s); "neither" is what is rejected here. */
      if (item.type === "narration") {
        /* `name` already carries `at` when there is no id, so prefixing it again
         * printed `items[1]: items[1] has neither…`. */
        const named = typeof item.id === "string" && item.id;
        const name = named ? `narration "${item.id}"` : at;
        const where = named ? `${at}: ${name}` : at;
        if (!named) {
          /* Bailing out, like the three sibling rejections below, rather than
           * carrying on with `id: null`. Nothing downstream can name this item in
           * a message, and `progressSegments` cannot anchor a resume to it. */
          E(`${at}: a narration item needs an id`);
          itemsOk = false;
          continue;
        }
        /* Ids are checked for uniqueness rather than trusted, exactly as
         * segment ids and labels are above. `buildForayQueue` silently rewrites
         * a collision to `${forayId}#${index}` with a warning nobody reads —
         * which is a safe failure and a confusing one. */
        if (seenNarrationIds.has(item.id)) E(`${at}: narration id "${item.id}" appears twice in one Foray`);
        seenNarrationIds.add(item.id);
        if (item.duration_sec !== undefined && !(typeof item.duration_sec === "number" && item.duration_sec > 0 && Number.isFinite(item.duration_sec))) {
          E(`${where} has a \`duration_sec\` of ${JSON.stringify(item.duration_sec)} — it must be a positive finite number of seconds, or absent`);
          itemsOk = false;
          continue;
        }
        const hasScript = typeof item.script === "string" && item.script.trim().length > 0;
        /* §7 item 5, clause 1: "A narration item has either script or asset
         * (never neither)." Gated as a hard failure ONLY for a generated
         * Foray (`isGeneratedForay`, defined above) — an admin-authored
         * bridge with neither yet is the ordinary in-progress state the
         * `unvoiced` warning below already covers, and #134/§1.2 never asked
         * for that path to get stricter. A generated Foray has no such
         * in-progress state: §4.9 is its only route to `data/forays.json`,
         * and by the time an item reaches this file the pipeline has either
         * written a script, attached a rendered asset, or the item should
         * not have been emitted at all. */
        const hasAsset = nonEmptyString(item.audio_url) || nonEmptyString(item.asset);
        if (isGeneratedForay(foray) && !hasScript && !hasAsset) {
          E(`${where} has neither a \`script\` nor an \`asset\` — a generated Foray's narrator must always say something`);
          itemsOk = false;
          continue;
        }
        /* §7 item 5, clause 2: a `mode` is checked against the six-mode enum
         * whenever it is PRESENT, on any Foray — this cannot retroactively
         * fail the four admin-authored Forays because none of them sets the
         * field, and a typo'd mode is a real defect worth catching wherever
         * it shows up. Requiring the field to EXIST is narrower and applies
         * only to a generated Foray (`docs/curation/narration-craft.md`'s
         * six modes are how the pipeline picks a budget for every narration
         * beat it writes — §2.1 — so a generated item missing one is a
         * pipeline defect, not an admin's choice not to use the concept). */
        if (item.mode !== undefined && !NARRATION_MODES.has(item.mode)) {
          E(`${where} has \`mode\` ${JSON.stringify(item.mode)}, not one of the six modes in narration-craft.md §0 (${[...NARRATION_MODES].join(", ")})`);
        } else if (isGeneratedForay(foray) && item.mode === undefined) {
          E(`${where} has no \`mode\` — every narration item in a generated Foray must declare one of the six modes (narration-craft.md §0)`);
        }
        if (item.duration_sec === undefined && !hasScript) {
          E(
            `${where} has neither a \`duration_sec\` nor a \`script\`, so nothing can say how ` +
              `long it is. It would run for real seconds and be counted as zero in \`runtime_sec\`, ` +
              `in D1's window and in a listener's resume. Give it the script, or let ` +
              `tools/narrate/ stamp \`duration_sec\` from the audio it generated.`
          );
          itemsOk = false;
          continue;
        }
        if (item.slot !== undefined && slotIds.length && !slotIds.includes(item.slot)) {
          E(`${where} declares slot "${item.slot}", which is not in \`slots\``);
        } else if (item.slot === undefined && slotIds.length && played.length === 0) {
          /* `hydrateForayItems` gives a slotless bridge the slot of the item
           * BEFORE it, which is what keeps it in the running order rather than in
           * a trailing untitled section. A bridge that OPENS a Foray has nothing
           * to inherit, so it has to carry its own — and the invariant is
           * enforced here rather than left to a comment, because the failure is
           * silent: the Foray renders, with its first item at the bottom. */
          E(`${where} opens the Foray, so it has no preceding item to inherit a \`slot\` from and must declare one`);
        }
        const dur = narrationDuration(item);
        /* THE FLOOR IS ON THE SCRIPT, NOT ON THE AUDIO, and that distinction is
         * the whole point of it: what it detects is a PLACEHOLDER — "Two million
         * years later." standing in for a bridge nobody has written. Applied to
         * `dur.sec` it also rejected a MEASURED duration, and a real 50-character
         * Hinge voices anywhere in roughly 2.5-3.5 s, so once `tools/narrate/`
         * stamps durations that would have been a routine false positive on a
         * legal item. narration-craft.md is explicit about which unit is the
         * primitive: "the word budgets are the primitive". A measured duration
         * with no script has no placeholder to detect and gets no floor — it is a
         * measurement of a file, and the ceiling above is what bounds it. */
        if (hasScript && item.script.trim().length < NARRATION_MIN_CHARS) {
          E(
            `${where} has a ${item.script.trim().length}-character script, under narration-craft.md §0's ` +
              `${NARRATION_MIN_CHARS}-character Hinge floor (${NARRATION_MIN_SEC.toFixed(3)} s at ` +
              `${NARRATION_CHARS_PER_SEC} chars/s) — a script this short is a placeholder, not a bridge`
          );
        }
        if (dur.sec > NARRATION_HARD_MAX_SEC) {
          E(
            `${where} is ${dur.sec.toFixed(1)} s (${dur.source}), over the ${NARRATION_HARD_MAX_SEC} s Carry ` +
              `hard max in narration-craft.md §0 — "the narrator is never the longest item in the Foray"`
          );
          /* Dropped from the clock as well as reported, like the sibling
           * rejections above. Left in, a `duration_sec: 1e6` bridge drags
           * `runtime` up, flips the D1 band, and buries the one real error under
           * a spurious `runtime_sec` drift and a D1 failure that is an artefact
           * of the first mistake. */
          itemsOk = false;
          continue;
        }
        if (dur.sec > NARRATION_SOFT_MAX_SEC) {
          W(`${name} is ${dur.sec.toFixed(1)} s (${dur.source}), past narration-craft.md §0's ${NARRATION_SOFT_MAX_SEC} s Carry soft max — it should state what the extra minute does`);
        }
        /* ---- WHETHER IT WILL ACTUALLY PLAY, which decides whether it counts
         *
         * `buildForayQueue` DROPS a narration item with no `audio_url`/`asset`
         * AND no `script` (generation-architecture.md §7 item 1 inverted the
         * old all-audio assumption: on-device narration's common case is
         * SCRIPT, NO ASSET, and the queue now treats a script as playable via
         * the on-device TTS plugin rather than dropping it). So an item that
         * carries NEITHER contributes nothing to the player's `totalSec` — and
         * if it were counted here, the two gates would demand different
         * `runtime_sec` values and one of them would always be red. That is not
         * hypothetical: `player/foray-playback.test.js` asserts `totalSec` agrees
         * with the committed `runtime_sec` to within a second.
         *
         * `runtime_sec` must describe what a listener hears, so the checker
         * follows the player: an item with nothing to play at all is excluded
         * from the clock and WARNED about, not rejected — the item still has to
         * be well-formed to get this far, and this only fires for the case
         * neither an asset nor a script exists.
         *
         * Note what this does NOT weaken: the rejection above is about an item
         * that PLAYS and costs nothing. One that plays nothing and costs nothing
         * is consistent. */
        /* `audio_url ?? asset ?? null`, NOT "either one is non-empty". This is
         * `buildForayQueue`'s expression copied verbatim, and the difference is
         * not cosmetic: `??` falls through only on null and undefined, so a
         * PRESENT BUT USELESS `audio_url` — `""`, `"   "`, `0`, `false` — shadows
         * a perfectly good `asset` and the player drops the item. Restating the
         * rule as two independent predicates saw the good `asset` and counted
         * something the player will not play, which is the same gate divergence
         * this block exists to prevent, on a narrower trigger. Mirror the player;
         * do not paraphrase it. */
        const url = item.audio_url ?? item.asset ?? null;
        // `hasScript` above is `player/foray-queue.js`'s own script check: a
        // non-empty STRING, trimmed — the exact predicate that decides
        // whether the queue speaks the line.
        if (!nonEmptyString(url) && !hasScript) {
          unvoiced += 1;
          W(
            `${name} has no usable \`audio_url\`/\`asset\`/\`script\`, so the player drops it and it is ` +
              `excluded from \`runtime_sec\` and D1's clock (${dur.sec.toFixed(1)} s, ${dur.source}). ` +
              `Restate \`runtime_sec\` when the audio or the script lands.`
          );
          continue;
        }
        /* The same two lexical checks every `segment-sources` audio_url gets —
         * but only when an asset/audio_url actually exists to check. A
         * script-only item has no URL at all (it is spoken on-device, not
         * fetched), so these checks would be meaningless applied to it; the
         * https/tokened rules are about a FILE this app fetches over the
         * network, and a script is neither. */
        if (nonEmptyString(url)) {
          if (!/^https:\/\//.test(url)) E(`${where} asset must be https, got ${JSON.stringify(url)}`);
          if (/[?&](token|auth|api_?key|secret|password|session)=/i.test(url)) {
            E(`${where} asset looks tokened (secret leak)`);
          }
        }
        narrations.push({ at, id: item.id ?? null, sec: dur.sec, source: dur.source });
        timeline.push({ kind: "narration", duration: dur.sec });
        continue;
      }
      if (item.type === "jingle") {
        /* §7 item 4: the jingle is a fixed, always-valid asset (see
         * `player/foray-queue.js`'s `JINGLE_ASSET_URL`/`JINGLE_DURATION_SEC`)
         * — there is no script, mode or per-item audio to validate, so this
         * gate is intentionally thin. It still occupies the listener's
         * clock exactly like a narration bridge (§4.8: "the jingle marks a
         * change of tape", the same job narration's silence-vs-marker rule
         * describes), so it joins `timeline` for D1's 600 s window but is
         * NOT a segment start — the same reasoning §7 item 5's narration
         * block gives at length below for why a bridge isn't a cut. */
        if (item.id !== undefined) {
          if (typeof item.id !== "string" || !item.id) { E(`${at}: a jingle's \`id\`, if present, must be a non-empty string`); itemsOk = false; continue; }
          if (seenNarrationIds.has(item.id)) E(`${at}: id "${item.id}" appears twice in one Foray`);
          seenNarrationIds.add(item.id);
        }
        timeline.push({ kind: "jingle", duration: JINGLE_DURATION_SEC });
        jingleCount += 1;
        jingleRuntime += JINGLE_DURATION_SEC;
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
      timeline.push({ kind: "segment", duration: seg.end_sec - seg.start_sec });
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
      /* `played` is tape only, so subtracting it from the whole item list
       * counted every perfectly good narration item as a failure — including an
       * unvoiced one, which is the state this file goes out of its way to bless. */
      W(`${foray.items.length - played.length - narrations.length - unvoiced - jingleCount} item(s) did not resolve; every rule below is judged on the ${played.length} that did, so these verdicts are partial`);
    }

    /* ---- derived: TWO clocks, and keeping them apart is the whole fix
     *
     * `tapeRuntime` is the sum of the segments. Every per-segment rule below
     * measures against it, because they are rules about tape: D3's mean is
     * "mean SEGMENT duration", D5's IQR is a spread of segment durations, M4's
     * share is one episode's seconds over all episodes' seconds, and narration
     * belongs to no episode.
     *
     * `runtime` is the listener's clock — tape plus narration plus jingles —
     * and it is what the Foray IS. It sets D1's budget band (§5c bands are by
     * "total Foray duration"), it is what `runtime_sec` in the data file must
     * agree with, and it is the number the player's `forayRuntimeSec` now
     * returns (`itemRuntimeSec` reads `duration_sec` for a jingle exactly as
     * it does for narration — see `foray-queue.js`).
     *
     * With zero narration or jingles authored the three are identical, which
     * is why nothing in the committed data moves. */
    const durations = played.map((p) => p.duration);
    const tapeRuntime = durations.reduce((a, b) => a + b, 0);
    const narrationRuntime = narrations.reduce((a, n) => a + n.sec, 0);
    const runtime = tapeRuntime + narrationRuntime + jingleRuntime;
    const mean = tapeRuntime / durations.length;

    /* ---- D1's start list, on the listener's clock ------------------------
     *
     * IS A NARRATION ITEM A SEGMENT START? NO — and this is a ruling, so here is
     * the argument rather than the behaviour alone.
     *
     *   - §5c caps "the number of SEGMENT STARTS". A narration item is not a
     *     segment; #134 types them separately, and every companion rule in the
     *     same box ("at most 2 consecutive SEGMENTS under 60 s", "mean SEGMENT
     *     duration >= 90 s") is unambiguously about tape.
     *   - The rule's mechanism is §2a's non-habituating re-orientation cost: a
     *     new voice, a new room, a new level, with no warning. A bridge is the
     *     opposite of unwarned — §6b makes narration the MARKER of the move, and
     *     `player/seam-gap.js` already spends 0 s of silence at a bridged seam
     *     for exactly that reason ("narration is a better marker than silence").
     *     Counting the bridge as a cut charges D1 twice for one move: once for
     *     the bridge, once for the segment it introduces.
     *   - It is the same voice at the same level every time, in every Foray. The
     *     cost §2a measures is the cost of an UNFAMILIAR voice. The narrator is
     *     the cheapest transition available, not another instance of the
     *     expensive one.
     *   - Narration is already budgeted, separately and more tightly, by
     *     narration-craft.md §0: whole-Foray share <= 25 % (ceiling 35 %), at
     *     most 2 consecutive narration items, and its own +/-20 % anti-uniformity
     *     rule. If a bridge were also a D1 start, those would be a second budget
     *     on the same quantity, disagreeing with the first.
     *
     * BUT THE CLOCK IS THE LISTENER'S. §5c: "in any rolling 600-second window of
     * Foray PLAYBACK". So a bridge's DURATION advances the window even though the
     * bridge is not a start — which is the half that was actually wrong, and the
     * half the TODO that used to sit here anticipated.
     *
     * Net effect on a narrated Foray, stated plainly because it cuts both ways:
     * the same starts spread over a longer clock, so D1 gets EASIER to pass
     * within a band — and harder at a band edge, since a Foray with 44 min of
     * tape and 8 min of narration is a 52-minute Foray and drops from N=8 to
     * N=6. Both movements are §5c's own text.
     *
     * If the founders want a bridge to cost a cut, the change is one line —
     * push `clock` for a narration item too. Cheap to reverse on purpose. */
    const starts = [];
    let clock = 0;
    for (const entry of timeline) {
      if (entry.kind === "segment") starts.push(clock);
      clock += entry.duration;
    }

    /* A stated runtime is a drift detector: swap a segment for one of a
     * different length and this is what notices. It is compared against the
     * LISTENER'S clock, so a Foray that gains a bridge has to restate it — the
     * alternative is a `runtime_sec` that no surface can render honestly. */
    if (typeof foray.runtime_sec === "number" && Math.abs(foray.runtime_sec - runtime) > 0.5) {
      E(
        `\`runtime_sec\` says ${foray.runtime_sec.toFixed(2)} but the items sum to ${runtime.toFixed(2)}` +
          (narrationRuntime > 0 ? ` (${tapeRuntime.toFixed(2)} of tape + ${narrationRuntime.toFixed(2)} of narration)` : "")
      );
    }

    /* ---- slots appear as contiguous blocks, in the declared order */
    if (slotIds.length) {
      const seq = played.map((p) => p.slot);
      const blocks = seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
      if (new Set(blocks).size !== blocks.length) E(`slots are interleaved rather than contiguous: ${blocks.join(" -> ")}`);
      const declared = slotIds.filter((s) => blocks.includes(s));
      if (blocks.join("|") !== declared.join("|")) E(`slot blocks play as ${blocks.join(" -> ")} but \`slots\` declares ${declared.join(" -> ")}`);
    }

    /* ---- D1: rolling cut budget, on the clock built above.
     *
     * The old TODO here said `starts` was the tape timeline and that narration
     * contributed 0 s, so the budget was "measured against a shorter clock than
     * the listener's". It is not any more. What remains worth saying out loud is
     * when part of that clock is a PROJECTION rather than a measurement: an
     * estimated bridge is a character count divided by 17, and a D1 verdict that
     * leans on one is only as good as the speaking rate nobody has measured yet
     * (narrator-pipeline.md §6). */
    const estimated = narrations.filter((n) => n.source !== DURATION_MEASURED);
    if (estimated.length) {
      W(
        `D1's clock includes ${estimated.length} narration item(s) whose length is estimated from the script at ` +
          `${NARRATION_CHARS_PER_SEC} chars/s, not measured from audio: ` +
          `${estimated.map((n) => n.id ?? n.at).join(", ")}. tools/narrate/ should stamp \`duration_sec\` at generation time.`
      );
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

    /* ---- M4: no one episode over 25 % of segments or runtime
     *
     * TAPE runtime, deliberately. M4 asks whether one episode dominates the
     * sourcing, so the denominator has to be the thing episodes are competing
     * for. Dividing by the listener's clock would let a Foray buy its way under
     * the cap by adding narration — the share would fall without a single
     * segment changing, and the imbalance the rule is about would be untouched. */
    const byEpisode = new Map();
    for (const p of played) {
      const e = byEpisode.get(p.seg.item_id) ?? { n: 0, sec: 0 };
      e.n++; e.sec += p.duration;
      byEpisode.set(p.seg.item_id, e);
    }
    for (const [itemId, e] of byEpisode) {
      const nShare = e.n / played.length;
      const secShare = e.sec / tapeRuntime;
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
      /* `runtime_sec` is the listener's clock and always has been the field
         everything reads; the tape sum is reported BESIDE it rather than instead
         of it, so the two can be compared without recomputing either. On a Foray
         with no narration they are equal, `narration_sec` is 0, and every
         existing assertion on this shape holds. */
      runtime_sec: +runtime.toFixed(2),
      tape_runtime_sec: +tapeRuntime.toFixed(2),
      narration_items: narrations.length,
      /* Reported separately rather than folded into `narration_items`, which
         counts what will PLAY. A report that said `narration_items: 0` for a
         Foray with three authored-but-unvoiced bridges would be saying they do
         not exist. */
      narration_unvoiced: unvoiced,
      narration_sec: +narrationRuntime.toFixed(2),
      /* §7 item 4: reported alongside narration for the same reason —
         a report that omits jingles entirely would understate what the
         listener hears, and callers already read `narration_items` /
         `narration_sec` as "the non-tape items", which a jingle also is. */
      jingle_items: jingleCount,
      jingle_sec: +jingleRuntime.toFixed(2),
      /* narration-craft.md §0's whole-Foray share. Reported, not gated: the
         target (25 %) and ceiling (35 %) are that document's own invention and
         it says the ratio is "a symptom, not a budget" — a Foray over it is
         under-sourced, which is an editorial verdict and not a schema one. */
      narration_share: runtime > 0 ? +(narrationRuntime / runtime).toFixed(4) : 0,
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
        `${f.id} (${f.status}): ${f.segments} segments, ${(f.runtime_sec / 60).toFixed(1)} min, mean ${f.mean_sec} s` +
          (f.narration_items
            ? `\n  ${f.narration_items} narration item(s), ${(f.narration_sec / 60).toFixed(1)} min ` +
              `(${(f.narration_share * 100).toFixed(1)} % of the Foray; ${(f.tape_runtime_sec / 60).toFixed(1)} min is tape)`
            : "") +
          (f.narration_unvoiced ? `\n  ${f.narration_unvoiced} narration item(s) authored but not yet voiced — excluded from the clock` : "") +
          "\n" +
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
