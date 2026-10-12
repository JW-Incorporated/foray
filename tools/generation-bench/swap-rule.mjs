/* swap-rule.mjs — the model-swap decision rule as a function (GV-35, W7-01).
 *
 * WHAT IT IS FOR (docs/roadmap/generation-v2.md, card GV-35; #1286)
 * A stage swap (deepen on the P40 instead of the Spark) or a quality lever
 * (writer exemplars on, spine best-of-2) is decided from two arms of the same
 * golden prompts: arm A, the adopted stack (swaps/adopted-stack.json), and arm
 * B, which changes exactly ONE stage assignment or ONE lever. The protocol is
 * written out in docs/curation/model-swaps.md; this module is the part a tool
 * can apply, so the verdict on a ledger row is computed, not argued.
 *
 *   decideSwap(evidence, { bands, slackMs, minListened })
 *     -> { decision, pairwise, axisMeans, scorecardDelta, timingDelta,
 *          checks, failing, unmeasured }
 *
 * The module never calls a model and never reads the network: it reads the
 * evidence object it is handed. tools/generation-bench/swap-experiment.mjs
 * (GV-75) builds that object from the two arms' reports and the founder's
 * unsealed cards.
 *
 * THE EVIDENCE (one object per experiment)
 *   {
 *     kind: "stage" | "lever" | "measure",
 *     stage?: "deepen",                 // the stage that changed, or the stage the lever acts on
 *     lever?: "spineBestOf",            // set on a lever experiment
 *     corpusFingerprint: "<fp>" | "unfrozen",
 *     prompts: [{
 *       promptId: "g-01",
 *       preference: "A" | "B" | "tie" | null,  // UNSEALED arm, not the blind pack label; null = not listened
 *       scores: { A: { onSubject, ... }, B: { ... } } | null,   // listen-card/1 axes, act 1
 *       mq: { A: { "MQ-01": 1, "MQ-02": 0.91, "MQ-04": 0, "MQ-05": 0.88, "MQ-21": true },
 *             B: { ... } }              // per metric: a finite number, a boolean, null (absent),
 *                                       // or a scorecard (score.mjs) cell { value, source, note }
 *                                       // whose `value` is one of those; anything else throws
 *     }],
 *     timing: [{ stage, A: p50Ms | null, B: p50Ms | null, resumed?: true }]   // pipeline order
 *   }
 *
 * THE RULE (model-swaps.md §"The decision rule"; every constant is below)
 * ADOPT needs every check to pass or be unmeasured:
 *   listened        at least MIN_LISTENED (10) prompts carry a preference
 *   pairwise        wins(B) + ties >= wins(A)
 *   axis:<axis>     B's card mean is not more than AXIS_DROP_MAX (0.5) below A's
 *   MQ-01+MQ-04     MQ-01 == 1 and MQ-04 == 0 hold on at least as many prompts for B as for A
 *   MQ-21           B's run successes >= A's minus 1 per 10 prompts
 *   MQ-02, MQ-05    B's mean is not below A's by more than the band passed in (GEN-05)
 *   timing:<stage>  the changed stage, and every later one, is not slower in B by more than its slack
 *   corpus-frozen   the evidence names a frozen corpus fingerprint (R2-02), not 'unfrozen'
 * REJECT when wins(A) > wins(B) + ties.
 * HOLD when the pairwise result is even or better but a check fails.
 * MEASURED for kind 'measure' (E0): the gap is recorded, nothing is adopted.
 *
 * ABSENT IS NOT PASS (rule 1 of the bench, run.mjs)
 * A metric absent in BOTH arms is 'unmeasured' and does not block. A metric
 * present in A but absent in B FAILS: arm B lost a measurement the adopted
 * stack had, and a swap must not win by not being measured. Present in B but
 * absent in A is 'unmeasured' (there is nothing to compare against). With no
 * band supplied for MQ-02 or MQ-05 the check is 'unmeasured', never 'pass':
 * GEN-05's bands (GV-64) are PROPOSED until the noise floor is measured.
 */

import fs from "node:fs";
import path from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { AXES } from "../listening/card.mjs";

export const DECISIONS = Object.freeze(["adopt", "hold", "reject", "measured"]);
export const KINDS = Object.freeze(["stage", "lever", "measure"]);
export const CHECK_RESULTS = Object.freeze(["pass", "fail", "unmeasured"]);

/** The listened golden prompts a stage swap needs (R2-21: 2 x 10 runs). */
export const MIN_LISTENED = 10;

/** How far below A a card axis mean of B may fall before the swap holds. */
export const AXIS_DROP_MAX = 0.5;

/** Run success (MQ-21): B may lose this many successes per 10 prompts. */
export const RUN_SUCCESS_ALLOWANCE_PER_10 = 1;

/** The judged rates whose means must stay inside the GEN-05 band. */
export const BANDED_METRICS = Object.freeze(["MQ-02", "MQ-05"]);

/** Metrics the scorecard delta reports, in this order. */
export const SCORECARD_METRICS = Object.freeze(["MQ-01", "MQ-02", "MQ-04", "MQ-05", "MQ-21"]);

/**
 * Timing slack per changed stage or lever, in ms. The spine best-of-2 figure
 * is the card's (a second spine draw costs about one spine call). Every other
 * change falls back to DEFAULT_SLACK_RELATIVE of A's p50 for that stage: the
 * GEN-05 time band (GV-64, +-15% relative), PROPOSED until the noise floor of
 * two back-to-back runs of one build is measured. `options.slackMs` overrides.
 */
export const SLACK_MS = Object.freeze({ spineBestOf: 3000 });
export const DEFAULT_SLACK_RELATIVE = 0.15;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const has = (v) => v !== null && v !== undefined;

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** pass | fail | unmeasured from presence alone: null when both arms have it. */
function presence(inA, inB, what) {
  if (!inA && !inB) return { result: "unmeasured", note: `${what} absent in both arms` };
  if (inA && !inB) return { result: "fail", note: `${what} measured in arm A but absent in arm B` };
  if (!inA && inB) return { result: "unmeasured", note: `${what} absent in arm A, nothing to compare against` };
  return null;
}

/**
 * One arm's values of one metric, one per prompt: a finite number, a boolean,
 * or null (absent). A score.mjs cell ({ value, source, note }) is unwrapped to
 * its `value`. Any other value throws, naming the prompt and the metric: an
 * object counted as "present" but never equal to 1, 0 or true would let both
 * arms score zero clean prompts and pass 0 >= 0.
 */
function metricValues(prompts, arm, metric) {
  return prompts.map((p) => {
    if (!isPlainObject(p.mq) || !isPlainObject(p.mq[arm])) return null;
    let v = p.mq[arm][metric];
    if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, "value")) v = v.value;
    if (v === null || v === undefined) return null;
    if (isNum(v) || typeof v === "boolean") return v;
    throw new Error(`prompt ${p.promptId}: arm ${arm} ${metric} must be a finite number, a boolean, null or a score.mjs cell carrying one, got ${JSON.stringify(v)}`);
  });
}

/** The changed stage's slack in ms, for a stage whose A p50 is `aMs`. */
export function slackFor(evidence, aMs, options = {}) {
  if (isNum(options.slackMs)) return options.slackMs;
  const key = evidence.kind === "lever" ? evidence.lever : evidence.stage;
  if (key && isNum(SLACK_MS[key])) return SLACK_MS[key];
  return Math.round(DEFAULT_SLACK_RELATIVE * aMs);
}

/**
 * Apply the rule. Never throws on missing metrics (they become 'unmeasured' or
 * 'fail' per the presence rule); throws only on evidence that is not evidence
 * (an unknown kind, prompts that are not a list, a preference that is not
 * A/B/tie/null, a scorecard metric that is not a number, a boolean, null or a
 * score.mjs cell carrying one), because a malformed object would otherwise read
 * as a run with nothing measured.
 *
 * @param {object} evidence  see the header
 * @param {{ bands?: Record<string, number>, slackMs?: number, minListened?: number }} options
 */
export function decideSwap(evidence, options = {}) {
  if (!isPlainObject(evidence)) throw new Error("evidence must be an object");
  if (!KINDS.includes(evidence.kind)) throw new Error(`evidence.kind must be one of ${KINDS.join(", ")}`);
  if (!Array.isArray(evidence.prompts)) throw new Error("evidence.prompts must be a list");
  const bands = isPlainObject(options.bands) ? options.bands : {};
  const minListened = Number.isInteger(options.minListened) ? options.minListened : MIN_LISTENED;
  const prompts = evidence.prompts;
  const checks = [];
  const add = (name, result, note) => checks.push(note ? { name, result, note } : { name, result });

  /* -- pairwise, over the listened prompts -------------------------------- */
  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (const p of prompts) {
    if (p.preference === null || p.preference === undefined) continue;
    if (p.preference === "B") wins += 1;
    else if (p.preference === "tie") ties += 1;
    else if (p.preference === "A") losses += 1;
    else throw new Error(`prompt ${p.promptId}: preference must be A, B, tie or null, got ${JSON.stringify(p.preference)}`);
  }
  const pairs = wins + ties + losses;
  const pairwise = { wins, ties, losses, pairs };
  add("listened", pairs >= minListened ? "pass" : "fail", `${pairs} of ${minListened} required prompts carry a preference`);
  add("pairwise", wins + ties >= losses ? "pass" : "fail", `B wins ${wins}, ties ${ties}, A wins ${losses}`);

  /* -- card axes ----------------------------------------------------------- */
  const axisMeans = { A: {}, B: {} };
  for (const axis of AXES) {
    const a = [];
    const b = [];
    for (const p of prompts) {
      if (!isPlainObject(p.scores)) continue;
      if (isPlainObject(p.scores.A) && isNum(p.scores.A[axis])) a.push(p.scores.A[axis]);
      if (isPlainObject(p.scores.B) && isNum(p.scores.B[axis])) b.push(p.scores.B[axis]);
    }
    axisMeans.A[axis] = mean(a);
    axisMeans.B[axis] = mean(b);
    const name = `axis:${axis}`;
    const absent = presence(a.length > 0, b.length > 0, `card axis ${axis}`);
    if (absent) add(name, absent.result, absent.note);
    else {
      const drop = axisMeans.A[axis] - axisMeans.B[axis];
      add(name, drop > AXIS_DROP_MAX ? "fail" : "pass", `A ${axisMeans.A[axis].toFixed(2)}, B ${axisMeans.B[axis].toFixed(2)}`);
    }
  }

  /* -- MQ-01 == 1 and MQ-04 == 0 ------------------------------------------- */
  {
    const holds = (arm) => {
      const g = metricValues(prompts, arm, "MQ-01");
      const u = metricValues(prompts, arm, "MQ-04");
      const present = g.some(has) || u.some(has);
      const count = g.filter((v, i) => v === 1 && u[i] === 0).length;
      return { present, count };
    };
    const a = holds("A");
    const b = holds("B");
    const absent = presence(a.present, b.present, "MQ-01/MQ-04");
    if (absent) add("MQ-01+MQ-04", absent.result, absent.note);
    else add("MQ-01+MQ-04", b.count >= a.count ? "pass" : "fail", `clean on ${b.count} prompts for B, ${a.count} for A`);
  }

  /* -- MQ-21 run success --------------------------------------------------- */
  {
    const a = metricValues(prompts, "A", "MQ-21");
    const b = metricValues(prompts, "B", "MQ-21");
    const absent = presence(a.some(has), b.some(has), "MQ-21");
    if (absent) add("MQ-21", absent.result, absent.note);
    else {
      const okA = a.filter((v) => v === true).length;
      const okB = b.filter((v) => v === true).length;
      const allowance = (RUN_SUCCESS_ALLOWANCE_PER_10 * prompts.length) / 10;
      add("MQ-21", okB >= okA - allowance ? "pass" : "fail", `${okB} successes for B, ${okA} for A, allowance ${allowance}`);
    }
  }

  /* -- scorecard means, and the banded judged rates ------------------------ */
  const scorecardDelta = {};
  for (const metric of SCORECARD_METRICS) {
    const numeric = (arm) =>
      metricValues(prompts, arm, metric)
        .filter((v) => isNum(v) || typeof v === "boolean")
        .map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
    const A = mean(numeric("A"));
    const B = mean(numeric("B"));
    scorecardDelta[metric] = { A, B, delta: A !== null && B !== null ? B - A : null };
  }
  for (const metric of BANDED_METRICS) {
    const { A, B } = scorecardDelta[metric];
    const absent = presence(A !== null, B !== null, metric);
    if (absent) add(metric, absent.result, absent.note);
    else if (!isNum(bands[metric])) add(metric, "unmeasured", `no band supplied for ${metric} (GEN-05, PROPOSED)`);
    else add(metric, B >= A - bands[metric] ? "pass" : "fail", `A ${A.toFixed(3)}, B ${B.toFixed(3)}, band ${bands[metric]}`);
  }

  /* -- timing: the changed stage and later stages only --------------------- */
  const timingDelta = [];
  {
    const rows = Array.isArray(evidence.timing) ? evidence.timing : [];
    const from = evidence.stage ? rows.findIndex((r) => r && r.stage === evidence.stage) : 0;
    const compared = (from === -1 ? [] : rows.slice(from)).filter((r) => isPlainObject(r) && !r.resumed);
    for (const r of compared) {
      const aMs = isNum(r.A) ? r.A : null;
      const bMs = isNum(r.B) ? r.B : null;
      const slack = aMs !== null ? slackFor(evidence, aMs, options) : null;
      timingDelta.push({ stage: r.stage, A: aMs, B: bMs, deltaMs: aMs !== null && bMs !== null ? bMs - aMs : null, slackMs: slack });
      const name = `timing:${r.stage}`;
      const absent = presence(aMs !== null, bMs !== null, `${r.stage} p50`);
      if (absent) add(name, absent.result, absent.note);
      else add(name, bMs - aMs > slack ? "fail" : "pass", `B ${bMs} ms vs A ${aMs} ms, slack ${slack} ms`);
    }
    if (compared.length === 0) add("timing", "unmeasured", from === -1 ? `no timing row for stage ${evidence.stage}` : "no timing rows");
  }

  /* -- frozen evidence ------------------------------------------------------ */
  const fp = evidence.corpusFingerprint;
  add(
    "corpus-frozen",
    typeof fp === "string" && fp !== "" && fp !== "unfrozen" ? "pass" : "fail",
    typeof fp === "string" && fp !== "" && fp !== "unfrozen" ? `corpus ${fp}` : "evidence is on an unfrozen corpus (R2-02 not landed)"
  );

  const failing = checks.filter((c) => c.result === "fail").map((c) => c.name);
  const unmeasured = checks.filter((c) => c.result === "unmeasured").map((c) => c.name);
  let decision;
  if (evidence.kind === "measure") decision = "measured";
  else if (losses > wins + ties) decision = "reject";
  else if (failing.length > 0) decision = "hold";
  else decision = "adopt";

  return { decision, pairwise, axisMeans, scorecardDelta, timingDelta, checks, failing, unmeasured };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/** node tools/generation-bench/swap-rule.mjs <evidence.json> [--bands <bands.json>] [--slack-ms n] */
export function main(argv, out = console.log) {
  let file = null;
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bands") options.bands = JSON.parse(fs.readFileSync(path.resolve(argv[++i]), "utf8"));
    else if (argv[i] === "--slack-ms") options.slackMs = Number(argv[++i]);
    else if (argv[i].startsWith("--")) throw new Error(`unknown flag ${argv[i]}`);
    else file = argv[i];
  }
  if (!file) throw new Error("usage: node tools/generation-bench/swap-rule.mjs <evidence.json> [--bands <bands.json>] [--slack-ms n]");
  const verdict = decideSwap(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")), options);
  out(JSON.stringify(verdict, null, 2));
  return verdict;
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
