#!/usr/bin/env node
/* tools/narration/asr-check.mjs — the Whisper round trip for rendered narration.
 *
 * GV-72 (docs/roadmap/generation-v2.md, from W6-12; covers R2-18). Kokoro can
 * mispronounce or garble a line, and nothing listened to the rendered file
 * before it was stamped. This step reads a render's manifest(s), the scripts
 * the lines were rendered from, and what an ASR model heard in each rendered
 * `.m4a` (`asr-transcribe.py` writes that as asr.jsonl {key, text, model}),
 * and per line:
 *
 *   - scores word error rate (WER) of the heard text against the script, both
 *     sides normalised by `normalizeForWer`: canonical() from
 *     tools/segments/merge-segments.mjs (the one transcript canonicaliser)
 *     after `spokenNumbers` turns digits, years and ordinals into words, so
 *     "1969" in a script and "nineteen sixty-nine" from Whisper agree;
 *   - FLAGS the line when WER > maxWer (default 0.05, "WER <= 5% per item") on
 *     a line of at least minRefWords (default 20) words. A shorter line is
 *     flagged only on 2 or more errors: one slip on a 10-word line is already
 *     10%, and Whisper's own error rate on clean TTS sits near that;
 *   - lists the SUSPECTS (the script words the ASR did not hear, with what it
 *     heard instead) and gathers LEXICON CANDIDATES for the hard-terms review:
 *     the suspect words of flagged lines, plus any suspect the script
 *     capitalises mid-sentence (a proper noun) on any line. Spelling variants
 *     of names inflate WER, so candidates are for a human, never written to
 *     hard-terms.json by this tool.
 *
 * It only REPORTS unless --hold-flagged is passed. With it, each flagged entry
 * in the manifest is rewritten to status "flagged" (with an `asr` record of
 * why). stamp-narration.mjs (stampForays) and upload-narration.mjs
 * (collectUploads) take only "rendered"/"unchanged" and "rendered" entries,
 * so a held line is neither uploaded nor stamped and the phone voice speaks it
 * from its script (NA-01). Holding never releases: a held line goes back only
 * by being re-rendered (a lexicon fix changes its key).
 *
 * Entries checked: status "rendered" or "flagged" (an "unchanged" line was
 * stamped by an earlier run and has no file in this render). A rendered line
 * with no ASR row is reported MISSING, a line whose script no longer matches
 * the manifest's text_sha256 is STALE; neither is scored or held.
 *
 * NO NETWORK, NO CREDENTIALS, and it never writes data/forays.json: it reads
 * the scripts from it (or from --source, a candidate document) and writes
 * only the manifest(s) (with --hold-flagged) and the --json report.
 *
 *     node tools/narration/asr-check.mjs data-local/narration-render --asr data-local/narration-render/asr.jsonl
 *     node tools/narration/asr-check.mjs out/ --asr asr.jsonl --source data-local/runs/<id>/partial.json --json asr-report.json
 *     node tools/narration/asr-check.mjs out/ --asr asr.jsonl --hold-flagged
 *
 * Exit 0: every checked line passed. 1: something flagged, missing or stale.
 * 2: a refusal (bad arguments, unreadable manifest or ASR file).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { canonical } from "../segments/merge-segments.mjs";
import { wordEditDistance } from "../transcribe/anchor-match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const MANIFEST_KIND = "foray-narration-render";
export const DEFAULT_MAX_WER = 0.05;
export const DEFAULT_MIN_REF_WORDS = 20;
/** A line shorter than minRefWords is flagged at this many errors. */
export const SHORT_LINE_MIN_ERRORS = 2;
export const HELD_STATUS = "flagged";
/** The entry statuses that have a file in this render to transcribe. */
const CHECKED_STATUSES = new Set(["rendered", HELD_STATUS]);

export class AsrCheckError extends Error {}

export const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/* ------------------------------------------------------------ spoken numbers */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1_000_000_000_000n, "trillion"],
  [1_000_000_000n, "billion"],
  [1_000_000n, "million"],
  [1_000n, "thousand"],
];
const IRREGULAR_ORDINALS = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

function under1000(n) {
  const out = [];
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)]);
    if (n % 10) out.push(ONES[n % 10]);
  } else if (n > 0) out.push(ONES[n]);
  return out;
}

/** A non-negative integer (digit string) in words, American style: no "and",
    no hyphens ("one hundred twenty three"). Past the trillions, and for a
    leading zero ("007"), the digits are read one by one. */
export function cardinalWords(digits) {
  const s = String(digits);
  if (!/^\d+$/.test(s)) throw new TypeError(`cardinalWords takes digits, got ${JSON.stringify(digits)}`);
  if ((s.length > 1 && s[0] === "0") || s.length > 15) return [...s].map((d) => ONES[Number(d)]).join(" ");
  let n = BigInt(s);
  if (n === 0n) return "zero";
  const out = [];
  for (const [scale, word] of SCALES) {
    if (n >= scale) {
      out.push(...under1000(Number(n / scale)), word);
      n %= scale;
    }
  }
  out.push(...under1000(Number(n)));
  return out.join(" ");
}

/** "twenty one" -> "twenty first", "twelve" -> "twelfth", "twenty" -> "twentieth". */
export function ordinalWords(cardinal) {
  const words = cardinal.split(" ");
  const last = words.pop();
  let o;
  if (IRREGULAR_ORDINALS[last]) o = IRREGULAR_ORDINALS[last];
  else if (last.endsWith("y")) o = last.slice(0, -1) + "ieth";
  else o = last + "th";
  return [...words, o].join(" ");
}

/** A year as it is said: 1969 "nineteen sixty nine", 1905 "nineteen oh five",
    1900 "nineteen hundred", 2024 "twenty twenty four"; 2000-2009 are said as
    numbers ("two thousand five"). Only 1100-2099 read as years. */
export function yearWords(n) {
  if (!(Number.isInteger(n) && n >= 1100 && n <= 2099) || (n >= 2000 && n <= 2009)) return null;
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return `${cardinalWords(String(hi))} hundred`;
  if (lo < 10) return `${cardinalWords(String(hi))} oh ${ONES[lo]}`;
  return `${cardinalWords(String(hi))} ${cardinalWords(String(lo))}`;
}

const plural = (words) => (words.endsWith("y") ? words.slice(0, -1) + "ies" : words + "s");
const spaced = (w) => ` ${w} `;

function numberWords(digits) {
  const n = Number(digits);
  if (/^[1-9]\d{3}$/.test(digits)) {
    const y = yearWords(n);
    if (y) return y;
  }
  return cardinalWords(digits);
}

/**
 * Digits, years, ordinals, decades, decimals, percentages and dollar amounts
 * into words, the way a narrator says them. Applied to BOTH the script and
 * the heard text, so a line agrees whichever side spelled a number out.
 */
export function spokenNumbers(text) {
  return String(text == null ? "" : text)
    // $5 -> five dollars; $5 million -> five million dollars
    .replace(/\$(\d{1,3}(?:,\d{3})+(?![\d,])|\d+(?:\.\d+)?)(\s+(?:thousand|million|billion|trillion))?/gi, (_, n, scale) => `${n}${scale ?? ""} dollars`)
    // 40% -> 40 percent
    .replace(/(\d)\s*%/g, "$1 percent")
    // 1,200 -> one thousand two hundred: a grouped number is a count, never a year
    .replace(/\b\d{1,3}(?:,\d{3})+(?![\d,])/g, (m) => spaced(cardinalWords(m.replace(/,/g, ""))))
    // 21st -> twenty first
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, d) => spaced(ordinalWords(cardinalWords(d))))
    // the 1960s -> nineteen sixties; the '90s / 90s -> nineties
    .replace(/\b(\d{4})s\b/g, (m, d) => spaced(plural(numberWords(d))))
    .replace(/(^|[^\d])['‘’]?([1-9]0)s\b/g, (_, pre, d) => `${pre}${spaced(plural(cardinalWords(d)))}`)
    // 3.5 -> three point five
    .replace(/\b(\d+)\.(\d+)\b/g, (_, i, f) => spaced(`${cardinalWords(i)} point ${[...f].map((c) => ONES[Number(c)]).join(" ")}`))
    // every remaining run of digits
    .replace(/\d+/g, (d) => spaced(numberWords(d)));
}

/** The one WER normaliser: spoken numbers, then the transcript canonicaliser. */
export function normalizeForWer(text) {
  return canonical(spokenNumbers(text));
}

const words = (text) => {
  const c = normalizeForWer(text);
  return c ? c.split(" ") : [];
};

/* ------------------------------------------------------------------- scoring */

/** The edit script turning `ref` into `hyp`, one op per word:
    ok / sub (ref, hyp) / del (ref) / ins (hyp). Same cost model as
    wordEditDistance, so the non-ok ops number exactly that distance. */
export function alignWords(ref, hyp) {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      d[i][j] = Math.min(d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push(ref[i - 1] === hyp[j - 1] ? { op: "ok", ref: ref[i - 1], hyp: hyp[j - 1] } : { op: "sub", ref: ref[i - 1], hyp: hyp[j - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: "del", ref: ref[i - 1] });
      i -= 1;
    } else {
      ops.push({ op: "ins", hyp: hyp[j - 1] });
      j -= 1;
    }
  }
  return ops.reverse();
}

/**
 * One line: WER of the heard text against the script.
 * @returns {{wer: number, refWords: number, errors: number, suspects: Array<{ref: string, heard: string}>}}
 *   `suspects` are the runs of script words the ASR got wrong (or missed),
 *   each with what it heard there; a run of pure insertions has ref "".
 */
export function scoreItem(script, asrText) {
  const ref = words(script);
  const hyp = words(asrText);
  const errors = wordEditDistance(ref, hyp);
  const suspects = [];
  let run = null;
  for (const op of alignWords(ref, hyp)) {
    if (op.op === "ok") {
      if (run) suspects.push({ ref: run.ref.join(" "), heard: run.hyp.join(" ") });
      run = null;
      continue;
    }
    run ??= { ref: [], hyp: [] };
    if (op.ref !== undefined) run.ref.push(op.ref);
    if (op.hyp !== undefined) run.hyp.push(op.hyp);
  }
  if (run) suspects.push({ ref: run.ref.join(" "), heard: run.hyp.join(" ") });
  const wer = ref.length ? errors / ref.length : errors ? 1 : 0;
  return { wer, refWords: ref.length, errors, suspects };
}

/** The flag rule: WER over maxWer on a long line, 2+ errors on a short one. */
export function isFlagged(score, { maxWer = DEFAULT_MAX_WER, minRefWords = DEFAULT_MIN_REF_WORDS } = {}) {
  if (score.refWords >= minRefWords) return score.wer > maxWer;
  return score.errors >= SHORT_LINE_MIN_ERRORS;
}

/** The script's words that it capitalises somewhere other than a sentence
    start, canonicalised: the proper nouns a lexicon entry is most likely for. */
export function properNouns(script) {
  const out = new Set();
  const text = String(script ?? "");
  for (const m of text.matchAll(/[\p{L}\p{N}'’]+/gu)) {
    if (!/^\p{Lu}/u.test(m[0])) continue;
    const before = text.slice(0, m.index).trimEnd();
    if (before === "" || /[.!?:"“]$/.test(before)) continue;
    for (const w of normalizeForWer(m[0]).split(" ").filter(Boolean)) out.add(w);
  }
  return out;
}

const entryTag = (e) => `${e.foray_id} / ${e.item_id} / ${e.voice}`;
const scriptKey = (forayId, itemId) => `${forayId}\u0000${itemId}`;

/**
 * Every checkable entry of one manifest against the ASR rows.
 *
 * @param {object} manifest   a foray-narration-render manifest
 * @param {Map<string, {text: string, model?: string}>} asrByKey   asr.jsonl rows by entry key
 * @param {{maxWer?: number, minRefWords?: number, scripts: Map<string, string>}} opts
 *   `scripts` maps scriptKey(foray_id, item_id) to the narration script.
 * @returns {{results: object[], flagged: object[], missing: object[], stale: object[], skipped: number,
 *            lexiconCandidates: object[]}}
 */
export function checkManifest(manifest, asrByKey, { maxWer = DEFAULT_MAX_WER, minRefWords = DEFAULT_MIN_REF_WORDS, scripts } = {}) {
  if (!(scripts instanceof Map)) throw new TypeError("checkManifest needs opts.scripts, a Map of the narration scripts");
  const results = [];
  const missing = [];
  const stale = [];
  let skipped = 0;
  const candidates = new Map();
  for (const e of manifest.items ?? []) {
    if (!CHECKED_STATUSES.has(e.status)) {
      skipped += 1;
      continue;
    }
    const where = { foray_id: e.foray_id, item_id: e.item_id, voice: e.voice, key: e.key };
    const script = scripts.get(scriptKey(e.foray_id, e.item_id));
    if (typeof script !== "string") {
      stale.push({ ...where, reason: "no such narration line in the source" });
      continue;
    }
    if (sha256(script) !== e.text_sha256) {
      stale.push({ ...where, reason: "the script changed since it was rendered" });
      continue;
    }
    const asr = asrByKey.get(e.key);
    if (!asr || typeof asr.text !== "string") {
      missing.push(where);
      continue;
    }
    const score = scoreItem(script, asr.text);
    const flagged = isFlagged(score, { maxWer, minRefWords });
    const result = { ...where, ...score, flagged, model: asr.model ?? null };
    results.push(result);
    const proper = properNouns(script);
    for (const s of score.suspects) {
      for (const w of s.ref ? s.ref.split(" ") : []) {
        const isProper = proper.has(w);
        if (!flagged && !isProper) continue;
        if (!candidates.has(w)) candidates.set(w, { word: w, count: 0, proper: isProper, heard: [], lines: [] });
        const c = candidates.get(w);
        c.count += 1;
        c.proper ||= isProper;
        if (s.heard && !c.heard.includes(s.heard)) c.heard.push(s.heard);
        const line = `${e.foray_id}/${e.item_id}`;
        if (!c.lines.includes(line)) c.lines.push(line);
      }
    }
  }
  const lexiconCandidates = [...candidates.values()].sort(
    (a, b) => Number(b.proper) - Number(a.proper) || b.count - a.count || a.word.localeCompare(b.word)
  );
  return { results, flagged: results.filter((r) => r.flagged), missing, stale, skipped, lexiconCandidates };
}

/**
 * The manifest with every flagged entry HELD: status "flagged" and an `asr`
 * record, totals restated. Pure: returns a copy. A held entry is never
 * released here, and nothing else in the manifest moves.
 */
export function holdFlagged(manifest, flagged) {
  const byKey = new Map(flagged.map((r) => [`${r.key}\u0000${r.foray_id}\u0000${r.item_id}`, r]));
  const out = structuredClone(manifest);
  let held = 0;
  for (const e of out.items ?? []) {
    const r = byKey.get(`${e.key}\u0000${e.foray_id}\u0000${e.item_id}`);
    if (!r || !CHECKED_STATUSES.has(e.status)) continue;
    e.status = HELD_STATUS;
    e.asr = { wer: round4(r.wer), errors: r.errors, ref_words: r.refWords, model: r.model, suspects: r.suspects };
    held += 1;
  }
  if (out.totals && typeof out.totals === "object") {
    const rendered = (out.items ?? []).filter((e) => e.status === "rendered");
    out.totals.rendered = rendered.length;
    out.totals.bytes = rendered.reduce((a, e) => a + (e.bytes || 0), 0);
    out.totals.flagged = (out.items ?? []).filter((e) => e.status === HELD_STATUS).length;
  }
  return { manifest: out, held };
}

const round4 = (x) => Math.round(x * 10000) / 10000;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/* ----------------------------------------------------------------------- I/O */

/** Every manifest named: a file, or a directory's `manifest*.json`. */
export function readManifests(target) {
  let files;
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) throw new AsrCheckError(`no render output at ${target}`);
  if (st.isDirectory()) {
    files = fs.readdirSync(target).filter((f) => /^manifest.*\.json$/.test(f)).sort().map((f) => path.join(target, f));
  } else files = [target];
  if (!files.length) throw new AsrCheckError(`no manifest*.json in ${target}`);
  return files.map((file) => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new AsrCheckError(`${file} is not readable JSON: ${err.message}`);
    }
    if (manifest?.kind !== MANIFEST_KIND) throw new AsrCheckError(`${file} is not a ${MANIFEST_KIND} manifest`);
    return { file, manifest };
  });
}

/** asr.jsonl -> Map(key -> {key, text, model}); a later row for a key wins. */
export function readAsr(file) {
  if (!fs.existsSync(file)) throw new AsrCheckError(`no ASR file at ${file} (run asr-transcribe.py first)`);
  const out = new Map();
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new AsrCheckError(`${file}:${i + 1} is not JSON`);
    }
    if (typeof row?.key !== "string" || typeof row?.text !== "string") {
      throw new AsrCheckError(`${file}:${i + 1} needs a string key and text`);
    }
    out.set(row.key, row);
  });
  return out;
}

/** The narration scripts of a source document: data/forays.json ({forays}) or
    a candidate / PartialCandidate / job snapshot (top-level id + items). */
export function scriptsFrom(doc) {
  const forays = Array.isArray(doc?.forays) ? doc.forays : doc && typeof doc.id === "string" && Array.isArray(doc.items) ? [doc] : null;
  if (!forays) throw new AsrCheckError("the source is neither {forays: [...]} nor a candidate with a top-level id and items");
  const out = new Map();
  for (const f of forays) {
    for (const item of f.items ?? []) {
      if (item?.type === "narration" && typeof item.script === "string") out.set(scriptKey(f.id, item.id), item.script);
    }
  }
  return out;
}

export function reportText(checks, { maxWer, minRefWords, held = null } = {}) {
  const all = checks.flatMap((c) => c.results);
  const flagged = checks.flatMap((c) => c.flagged);
  const missing = checks.flatMap((c) => c.missing);
  const stale = checks.flatMap((c) => c.stale);
  const models = [...new Set(all.map((r) => r.model).filter(Boolean))];
  const lines = [
    `asr-check: ${all.length} line(s) checked${models.length ? ` (${models.join(", ")})` : ""}; ${flagged.length} flagged ` +
      `(WER > ${pct(maxWer)} on >= ${minRefWords} words, or >= ${SHORT_LINE_MIN_ERRORS} errors on a shorter line), ` +
      `${missing.length} missing ASR, ${stale.length} stale`,
  ];
  for (const r of flagged) {
    const sus = r.suspects.map((s) => `"${s.ref}" heard "${s.heard}"`).join("; ");
    lines.push(`FLAGGED ${entryTag(r)}  WER ${pct(r.wer)} (${r.errors}/${r.refWords})  ${sus}`);
  }
  for (const m of missing) lines.push(`MISSING ${entryTag(m)}: no ASR row for ${m.key}`);
  for (const s of stale) lines.push(`STALE ${entryTag(s)}: ${s.reason}`);
  const cands = mergeCandidates(checks.map((c) => c.lexiconCandidates));
  if (cands.length) {
    lines.push("Lexicon candidates (review before anything enters hard-terms.json):");
    for (const c of cands) {
      lines.push(`  ${c.word}  x${c.count}${c.proper ? "  proper noun" : ""}  heard: ${c.heard.map((h) => `"${h}"`).join(", ") || "(nothing)"}`);
    }
  }
  if (held) for (const h of held) lines.push(`held ${h.held} line(s) in ${h.file}: status -> ${HELD_STATUS}`);
  return lines.join("\n") + "\n";
}

export function mergeCandidates(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const c of list) {
      if (!m.has(c.word)) m.set(c.word, { ...c, heard: [...c.heard], lines: [...c.lines] });
      else {
        const t = m.get(c.word);
        t.count += c.count;
        t.proper ||= c.proper;
        for (const h of c.heard) if (!t.heard.includes(h)) t.heard.push(h);
        for (const l of c.lines) if (!t.lines.includes(l)) t.lines.push(l);
      }
    }
  }
  return [...m.values()].sort((a, b) => Number(b.proper) - Number(a.proper) || b.count - a.count || a.word.localeCompare(b.word));
}

export function parseArgs(argv) {
  const a = { target: null, asr: null, source: null, json: null, hold: false, maxWer: DEFAULT_MAX_WER, minRefWords: DEFAULT_MIN_REF_WORDS };
  const value = (i, k) => {
    if (i >= argv.length) throw new AsrCheckError(`${k} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--asr") a.asr = value(++i, k);
    else if (k === "--source") a.source = value(++i, k);
    else if (k === "--json") a.json = value(++i, k);
    else if (k === "--hold-flagged") a.hold = true;
    else if (k === "--max-wer") a.maxWer = Number(value(++i, k));
    else if (k === "--min-ref-words") a.minRefWords = Number(value(++i, k));
    else if (k === "--help" || k === "-h") a.help = true;
    else if (k.startsWith("--")) throw new AsrCheckError(`unknown argument ${k}`);
    else if (a.target === null) a.target = k;
    else throw new AsrCheckError(`one render output only, got ${a.target} and ${k}`);
  }
  if (!(a.maxWer >= 0 && a.maxWer < 1)) throw new AsrCheckError("--max-wer is a fraction in [0, 1)");
  if (!(Number.isInteger(a.minRefWords) && a.minRefWords >= 1)) throw new AsrCheckError("--min-ref-words is a positive integer");
  return a;
}

export function main(argv, { log = (s) => process.stdout.write(s) } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.target) {
    log(
      "Usage: node tools/narration/asr-check.mjs <render-out|manifest.json> [--asr asr.jsonl] [--source data/forays.json|candidate.json] " +
        "[--hold-flagged] [--json out.json] [--max-wer 0.05] [--min-ref-words 20]\n"
    );
    return args.help ? 0 : 2;
  }
  const target = path.resolve(args.target);
  const manifests = readManifests(target);
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const asrByKey = readAsr(path.resolve(args.asr ?? path.join(dir, "asr.jsonl")));
  const sourcePath = path.resolve(args.source ?? path.join(REPO_ROOT, "data", "forays.json"));
  if (!fs.existsSync(sourcePath)) throw new AsrCheckError(`no source document at ${sourcePath}`);
  const scripts = scriptsFrom(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
  const opts = { maxWer: args.maxWer, minRefWords: args.minRefWords, scripts };
  const checks = manifests.map(({ file, manifest }) => ({ file, manifest, ...checkManifest(manifest, asrByKey, opts) }));
  let held = null;
  if (args.hold) {
    held = [];
    for (const c of checks) {
      if (!c.flagged.length) continue;
      const res = holdFlagged(c.manifest, c.flagged);
      fs.writeFileSync(c.file, JSON.stringify(res.manifest, null, 2) + "\n");
      held.push({ file: path.basename(c.file), held: res.held });
    }
  }
  log(reportText(checks, { maxWer: args.maxWer, minRefWords: args.minRefWords, held }));
  if (args.json) {
    const report = {
      kind: "foray-narration-asr-check",
      version: 1,
      max_wer: args.maxWer,
      min_ref_words: args.minRefWords,
      manifests: checks.map((c) => ({
        file: path.basename(c.file),
        checked: c.results.length,
        flagged: c.flagged.length,
        missing: c.missing,
        stale: c.stale,
        skipped: c.skipped,
      })),
      items: checks.flatMap((c) => c.results.map((r) => ({ ...r, wer: round4(r.wer) }))),
      lexiconCandidates: mergeCandidates(checks.map((c) => c.lexiconCandidates)),
      held: held ?? [],
    };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2) + "\n");
  }
  const bad = checks.some((c) => c.flagged.length || c.missing.length || c.stale.length);
  return bad ? 1 : 0;
}

if (isEntryScript(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`asr-check: ${err instanceof AsrCheckError ? err.message : err.stack}`);
    process.exitCode = err instanceof AsrCheckError ? 2 : 1;
  }
}
