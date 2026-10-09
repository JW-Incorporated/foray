#!/usr/bin/env node
/* Locate-step feasibility harness (DAI-12, docs/roadmap/dai.md; G-41 "measurable
   first step", docs/curation/foray-to-spec-roadmap.md).

   A THROWAWAY MEASUREMENT TOOL, not product code and not a test suite. Its name
   is deliberately not `*.test.mjs` (or any other pattern tools/ci/run-suites.mjs
   discovers): it shells out to ffmpeg and whisper-cli, which CI does not have.
   Results go in docs/curation/locate-step-feasibility-2026-09.md.

   It answers, for one episode and a few hand-authored ADR-0007 anchors (8-12
   verbatim words each), the three numbers ADR-0008 OQ1 / D5 needs: bytes
   fetched, time-to-locate, and hit/miss with its score. The arithmetic is not
   reimplemented here: the window is player/locate-window.js (DAI-10) and the
   match is tools/transcribe/anchor-match.mjs (DAI-11), so what this measures is
   exactly what a native port would be checked against.

   Each anchor is treated as the START anchor of a 2-minute authored segment:
     locateWindow({ start_sec, end_sec: start_sec + 120, delta_max_sec: 534,
                    spread_sec: 80 })
   534 s is SYSK's worst implied delta (dai-playback-brief-2026-09-10.md §3
   table); 80 s is the margin the brief's SYSK example uses (DAI-10 test).
   Both can be overridden (--delta-max-sec, --spread-sec, --segment-sec) for a
   sensitivity row.

   MODES
     --plan     No audio, no network. Per anchor: the fetch window, its span and
                windowBytes(span, bitrate) at each --bitrate-bps given. The
                bitrate is ALWAYS an explicit assumption: the availability row
                has no byte length, and this tool never issues a request to
                learn one (the DAI-08 probes own the politeness budget: one
                request at a time per host).
     --check    No audio. Verifies the anchors against the publisher transcript
                (--cues): each is 8-12 words, occurs exactly once verbatim
                (findAnchorOccurrences), starts at its recorded start_sec, and
                anchorMatch() finds it with score 1 inside its own search range.
                Exit 1 on any failure. Run before spending ASR time.
                With --simulate-shift-sec N it also feeds a SIMULATED cut (the
                publisher cues inside the window of a copy N s late, written as
                whisper-cli JSON) through the --audio path's normalise-and-match
                step: plumbing only, not recognition.
     --audio    The measurement. Requires --cues (the check runs first),
                --model (one or more ggml-*.bin, run one after another, never
                at once), and ffmpeg + whisper-cli (on PATH or --ffmpeg /
                --whisper-cli). Per anchor: cut [fetch_start, fetch_end] with
                `ffmpeg -ss S -to E -i AUDIO -c copy` (the cut's size on disk is
                the measured byte count), decode the cut to 16 kHz mono WAV,
                run whisper-cli -oj, normalise its JSON to cues shifted by the
                cut's origin, and anchorMatch() within search_start. Records
                wall time per stage. Cuts are deleted unless --keep-cuts; the
                input audio is never touched (delete it yourself afterwards).

   ANCHORS (--anchors-json) is a JSON file, or a Markdown file holding one
   fenced ```json block between `<!-- locate-anchors:begin -->` and
   `<!-- locate-anchors:end -->` (the feasibility doc is the source of truth):
     { "episode": { "show_id", "guid", "title", "program_end_sec", ... },
       "window":  { "segment_sec": 120, "delta_max_sec": 534, "spread_sec": 80 },
       "anchors": [ { "id", "at_pct", "start_sec", "text" }, ... ] }

   EXAMPLES
     node tools/transcribe/locate-feasibility.mjs --plan \
       --anchors-json docs/curation/locate-step-feasibility-2026-09.md \
       --bitrate-bps 64000 --bitrate-bps 128000
     node tools/transcribe/locate-feasibility.mjs --check \
       --anchors-json docs/curation/locate-step-feasibility-2026-09.md \
       --cues data-local/transcripts/normalized/<show>/<guid>-<hash>.json
     node tools/transcribe/locate-feasibility.mjs --audio data-local/audio/x.mp3 \
       --cues <same> --anchors-json <same> \
       --model models/ggml-tiny.en.bin --model models/ggml-base.en.bin */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isEntryScript } from "../ci/entry.mjs";

import { locateWindow, windowBytes } from "../../player/locate-window.js";
import {
  buildTranscriptIndex,
  findAnchorOccurrences,
} from "../segments/merge-segments.mjs";
import { anchorMatch, MIN_MATCH_SCORE } from "./anchor-match.mjs";

/** ADR-0007 asks for 8-12 verbatim words; the check holds the anchors to it. */
export const ANCHOR_WORDS_MIN = 8;
export const ANCHOR_WORDS_MAX = 12;

/** The brief's SYSK window parameters (DAI-12 step 3). */
export const DEFAULT_WINDOW = Object.freeze({
  segment_sec: 120,
  delta_max_sec: 534,
  spread_sec: 80,
});

const BEGIN = "<!-- locate-anchors:begin -->";
const END = "<!-- locate-anchors:end -->";

/** Parse the anchors document: plain JSON, or the fenced block in a Markdown file. */
export function parseAnchorsText(text, { markdown = false } = {}) {
  let json = text;
  if (markdown) {
    const b = text.indexOf(BEGIN);
    const e = text.indexOf(END, b + 1);
    if (b < 0 || e < 0) throw new Error(`no ${BEGIN} … ${END} block`);
    const fenced = /```json\s*\n([\s\S]*?)\n\s*```/.exec(text.slice(b, e));
    if (!fenced)
      throw new Error("the locate-anchors block holds no ```json fence");
    json = fenced[1];
  }
  const doc = JSON.parse(json);
  if (!doc || !Array.isArray(doc.anchors) || doc.anchors.length === 0) {
    throw new Error("anchors document has no anchors[]");
  }
  for (const a of doc.anchors) {
    if (
      typeof a.id !== "string" ||
      typeof a.text !== "string" ||
      !Number.isFinite(a.start_sec)
    ) {
      throw new Error(
        `anchor ${JSON.stringify(a.id)} needs id, text and a finite start_sec`,
      );
    }
  }
  return doc;
}

export function readAnchors(file) {
  return parseAnchorsText(fs.readFileSync(file, "utf8"), {
    markdown: /\.md$/i.test(file),
  });
}

/** The window parameters: the document's, then any CLI override, then the brief's defaults. */
export function windowParams(doc, overrides = {}) {
  const w = { ...DEFAULT_WINDOW, ...(doc.window || {}) };
  for (const k of Object.keys(DEFAULT_WINDOW)) {
    if (overrides[k] !== undefined) w[k] = overrides[k];
  }
  return w;
}

/** The locateWindow() for one anchor treated as a segment's start anchor. */
export function anchorWindow(anchor, w) {
  return locateWindow({
    start_sec: anchor.start_sec,
    end_sec: anchor.start_sec + w.segment_sec,
    delta_max_sec: w.delta_max_sec,
    spread_sec: w.spread_sec,
  });
}

/** --plan rows: one per anchor, bytes at each assumed bitrate. */
export function planRows(doc, w, bitrates) {
  const programEnd = doc.episode?.program_end_sec;
  return doc.anchors.map((a) => {
    const win = anchorWindow(a, w);
    return {
      id: a.id,
      at_pct: a.at_pct,
      start_sec: a.start_sec,
      fetch_start_sec: win.fetch_start_sec,
      fetch_end_sec: win.fetch_end_sec,
      span_sec: win.span_sec,
      search_start: win.search_start,
      past_program_end: Number.isFinite(programEnd)
        ? win.fetch_end_sec > programEnd
        : null,
      bytes: Object.fromEntries(
        bitrates.map((bps) => [bps, windowBytes(win.span_sec, bps)]),
      ),
    };
  });
}

/**
 * A stand-in for whisper-cli's `-oj` output on one cut: the publisher cues that
 * would sit inside [fetch_start, fetch_end] of a copy whose content runs
 * `shift_sec` LATER than authored (ads inserted before the anchor), with
 * offsets in milliseconds relative to the cut, as whisper-cli writes them. It
 * exercises the --audio path's plumbing (origin, offsets, search range)
 * without ffmpeg or a model; it says nothing about recognition quality.
 */
export function simulateWhisperJson(cues, win, shift_sec) {
  const transcription = [];
  for (const c of cues) {
    const s = c.start_sec + shift_sec;
    const e = c.end_sec + shift_sec;
    if (s < win.fetch_start_sec || e > win.fetch_end_sec) continue;
    transcription.push({
      offsets: {
        from: Math.round((s - win.fetch_start_sec) * 1000),
        to: Math.round((e - win.fetch_start_sec) * 1000),
      },
      text: ` ${c.text}`,
    });
  }
  return { transcription };
}

/** --check: the anchors against the publisher transcript. Returns rows with `ok` and `problems`.
    With `simulate_shift_sec`, also runs the --audio path's cue plumbing on a simulated cut. */
export function checkAnchors(doc, cues, w, { simulate_shift_sec } = {}) {
  const index = buildTranscriptIndex(cues);
  return doc.anchors.map((a) => {
    const problems = [];
    const { words, occurrences } = findAnchorOccurrences(index, a.text);
    if (words.length < ANCHOR_WORDS_MIN || words.length > ANCHOR_WORDS_MAX) {
      problems.push(
        `${words.length} words, ADR-0007 asks for ${ANCHOR_WORDS_MIN}-${ANCHOR_WORDS_MAX}`,
      );
    }
    if (occurrences.length !== 1)
      problems.push(
        `${occurrences.length} verbatim occurrences, need exactly 1`,
      );
    else if (occurrences[0].start_sec !== a.start_sec) {
      problems.push(
        `occurs at ${occurrences[0].start_sec} s, recorded ${a.start_sec} s`,
      );
    }
    const win = anchorWindow(a, w);
    const m = anchorMatch(cues, a.text, win.search_start);
    if (!m.hit || m.score !== 1)
      problems.push(
        `anchorMatch in its search range: hit=${m.hit} score=${m.score}`,
      );
    else if (m.start_sec !== a.start_sec)
      problems.push(`anchorMatch found it at ${m.start_sec} s`);
    let simulated = null;
    if (Number.isFinite(simulate_shift_sec)) {
      const sim = anchorMatch(
        whisperJsonToCues(
          simulateWhisperJson(cues, win, simulate_shift_sec),
          win.fetch_start_sec,
        ),
        a.text,
        win.search_start,
      );
      const shift = Number.isFinite(sim.start_sec)
        ? Math.round((sim.start_sec - a.start_sec) * 1000) / 1000
        : null;
      simulated = { hit: sim.hit, score: sim.score ?? null, shift_sec: shift };
      if (!sim.hit || Math.abs(shift - simulate_shift_sec) > 0.001) {
        problems.push(
          `simulated cut (+${simulate_shift_sec} s): hit=${sim.hit} shift=${shift}`,
        );
      }
    }
    return {
      id: a.id,
      words: words.length,
      occurrences: occurrences.length,
      score: m.score ?? null,
      simulated,
      ok: problems.length === 0,
      problems,
    };
  });
}

/** whisper-cli `-oj` JSON → `{ text, start_sec, end_sec }` cues on the episode timeline. */
export function whisperJsonToCues(raw, origin_sec = 0) {
  const segs = Array.isArray(raw?.transcription) ? raw.transcription : [];
  return segs
    .filter(
      (s) =>
        s &&
        s.offsets &&
        Number.isFinite(s.offsets.from) &&
        Number.isFinite(s.offsets.to),
    )
    .map((s) => ({
      text: String(s.text ?? "").trim(),
      start_sec: origin_sec + s.offsets.from / 1000,
      end_sec: origin_sec + s.offsets.to / 1000,
    }));
}

/* ------------------------------------------------------------------ output */

const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const fmtMB = (n) => (n == null ? "—" : (n / 1e6).toFixed(2));

export function planTable(rows, bitrates) {
  const head = [
    "anchor",
    "at",
    "start s",
    "fetch s",
    "span s",
    ...bitrates.map((b) => `bytes @ ${b / 1000} kbps (ASSUMED)`),
  ];
  const lines = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
  ];
  for (const r of rows) {
    const pe = r.past_program_end ? " ⚠ past program end" : "";
    lines.push(
      `| ${r.id} | ${r.at_pct ?? "?"} % | ${r.start_sec} | ${r.fetch_start_sec}–${r.fetch_end_sec.toFixed(2)}${pe} | ${r.span_sec.toFixed(0)} | ${bitrates
        .map((b) => `${fmtInt(r.bytes[b])} (${fmtMB(r.bytes[b])} MB)`)
        .join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------- --audio run */

function run(cmd, args) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = performance.now() - t0;
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} exited ${r.status}: ${(r.stderr || "").slice(-800)}`,
    );
  return { ms, stdout: r.stdout, stderr: r.stderr };
}

function toolVersion(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`
    .split(/\r?\n/)
    .find((l) => l.trim());
  return out ? out.trim() : null;
}

export function measure({
  audio,
  doc,
  cues,
  w,
  models,
  ffmpeg,
  whisperCli,
  threads,
  keepCuts,
  workDir,
}) {
  const device = {
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? null,
    cores: os.cpus().length,
    ffmpeg: toolVersion(ffmpeg, ["-version"]),
    whisper_cli: whisperCli,
  };
  const results = [];
  for (const a of doc.anchors) {
    const win = anchorWindow(a, w);
    const cut = path.join(workDir, `${a.id}.mp3`);
    const wav = path.join(workDir, `${a.id}.wav`);
    // The cut command recorded in the doc. -ss/-to are both INPUT options, so
    // -to is absolute in the source's timeline.
    const cutRun = run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(win.fetch_start_sec),
      "-to",
      String(win.fetch_end_sec),
      "-i",
      audio,
      "-c",
      "copy",
      cut,
    ]);
    const cutBytes = fs.statSync(cut).size;
    const decodeRun = run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      cut,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    for (const model of models) {
      const stem = path.join(
        workDir,
        `${a.id}-${path.basename(model).replace(/\.bin$/, "")}`,
      );
      const asrRun = run(whisperCli, [
        "-m",
        model,
        "-f",
        wav,
        "-l",
        "en",
        "-t",
        String(threads),
        "-oj",
        "-of",
        stem,
        "-np",
      ]);
      const raw = JSON.parse(fs.readFileSync(`${stem}.json`, "utf8"));
      const t0 = performance.now();
      const asrCues = whisperJsonToCues(raw, win.fetch_start_sec);
      const m = anchorMatch(asrCues, a.text, win.search_start);
      const matchMs = performance.now() - t0;
      results.push({
        anchor: a.id,
        model: path.basename(model),
        model_bytes: fs.statSync(model).size,
        span_sec: win.span_sec,
        cut_bytes: cutBytes,
        cut_ms: Math.round(cutRun.ms),
        decode_ms: Math.round(decodeRun.ms),
        asr_ms: Math.round(asrRun.ms),
        match_ms: Math.round(matchMs),
        time_to_locate_ms: Math.round(
          cutRun.ms + decodeRun.ms + asrRun.ms + matchMs,
        ),
        hit: m.hit,
        score: m.score ?? null,
        located_start_sec: m.start_sec ?? null,
        shift_sec: Number.isFinite(m.start_sec)
          ? m.start_sec - a.start_sec
          : null,
        reason: m.reason ?? null,
      });
      if (!keepCuts) fs.rmSync(`${stem}.json`, { force: true });
    }
    if (!keepCuts) {
      fs.rmSync(cut, { force: true });
      fs.rmSync(wav, { force: true });
    }
  }
  return { device, results };
}

/* --------------------------------------------------------------------- CLI */

const USAGE = `usage: locate-feasibility.mjs (--plan | --check | --audio FILE) --anchors-json FILE
  --plan                 window + bytes per anchor (no audio, no network); needs --bitrate-bps
  --check                verify anchors against the publisher transcript; needs --cues
  --simulate-shift-sec N with --check: also run the cut/ASR-cue plumbing on a simulated copy N s late
  --audio FILE           cut + whisper-cli + anchorMatch; needs --cues and --model
  --cues FILE            publisher transcript, normalized { cues: [...] } JSON
  --bitrate-bps N        assumed bitrate (repeatable or comma-separated)
  --model FILE           ggml model (repeatable; run in order, one at a time)
  --ffmpeg / --whisper-cli PATH, --threads N, --keep-cuts, --work-dir DIR
  --delta-max-sec / --spread-sec / --segment-sec N   override the window
  --json                 machine-readable output`;

function numList(values) {
  return (values || [])
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(v.trim()));
}

function readCues(file) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  const cues = Array.isArray(t) ? t : t.cues;
  if (!Array.isArray(cues) || cues.length === 0)
    throw new Error(`${file}: no cues`);
  return cues;
}

export function main(argv = process.argv.slice(2), out = console) {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "boolean" },
      check: { type: "boolean" },
      audio: { type: "string" },
      cues: { type: "string" },
      "anchors-json": { type: "string" },
      "bitrate-bps": { type: "string", multiple: true },
      model: { type: "string", multiple: true },
      ffmpeg: { type: "string" },
      "whisper-cli": { type: "string" },
      threads: { type: "string" },
      "keep-cuts": { type: "boolean" },
      "work-dir": { type: "string" },
      "delta-max-sec": { type: "string" },
      "spread-sec": { type: "string" },
      "segment-sec": { type: "string" },
      "simulate-shift-sec": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const modes = [values.plan, values.check, values.audio !== undefined].filter(
    Boolean,
  ).length;
  if (values.help || modes !== 1 || !values["anchors-json"]) {
    out.error(USAGE);
    return values.help ? 0 : 2;
  }
  const doc = readAnchors(values["anchors-json"]);
  const num = (k) => (values[k] === undefined ? undefined : Number(values[k]));
  const w = windowParams(doc, {
    delta_max_sec: num("delta-max-sec"),
    spread_sec: num("spread-sec"),
    segment_sec: num("segment-sec"),
  });

  if (values.plan) {
    const bitrates = numList(values["bitrate-bps"]);
    if (
      bitrates.length === 0 ||
      bitrates.some((b) => !Number.isFinite(b) || b <= 0)
    ) {
      out.error(
        "--plan needs --bitrate-bps (an explicit, assumed bitrate; this tool never probes one)",
      );
      return 2;
    }
    const rows = planRows(doc, w, bitrates);
    if (values.json)
      out.log(
        JSON.stringify(
          { window: w, bitrates_assumed: bitrates, rows },
          null,
          2,
        ),
      );
    else {
      out.log(
        `window: segment ${w.segment_sec} s, delta_max ${w.delta_max_sec} s, spread/margin ${w.spread_sec} s — bitrates are ASSUMPTIONS`,
      );
      out.log(planTable(rows, bitrates));
    }
    return 0;
  }

  if (!values.cues) {
    out.error("--check and --audio need --cues (the publisher transcript)");
    return 2;
  }
  const cues = readCues(values.cues);
  const checks = checkAnchors(doc, cues, w, {
    simulate_shift_sec: num("simulate-shift-sec"),
  });
  if (values.check || values.json) {
    if (values.json && values.check) out.log(JSON.stringify(checks, null, 2));
    else
      for (const c of checks)
        out.log(
          `${c.ok ? "ok  " : "FAIL"} ${c.id}: ${c.words} words, ${c.occurrences} occurrence(s), score ${c.score}${c.simulated ? `, simulated cut: ${c.simulated.hit ? "hit" : "miss"} shift ${c.simulated.shift_sec} s` : ""}${c.problems.length ? ` — ${c.problems.join("; ")}` : ""}`,
        );
  }
  if (checks.some((c) => !c.ok)) return 1;
  if (values.check) return 0;

  const models = values.model || [];
  if (models.length === 0) {
    out.error("--audio needs at least one --model (ggml-*.bin)");
    return 2;
  }
  const workDir =
    values["work-dir"] ||
    fs.mkdtempSync(path.join(os.tmpdir(), "locate-feasibility-"));
  let report;
  try {
    report = measure({
      audio: values.audio,
      doc,
      cues,
      w,
      models,
      ffmpeg: values.ffmpeg || "ffmpeg",
      whisperCli:
        values["whisper-cli"] || process.env.WHISPER_CLI || "whisper-cli",
      threads: Number(values.threads) || Math.max(1, os.cpus().length - 1),
      keepCuts: Boolean(values["keep-cuts"]),
      workDir,
    });
  } finally {
    // Cuts are audio: never leave them behind, even when a tool fails mid-run.
    if (!values["keep-cuts"] && !values["work-dir"])
      fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (values.json)
    out.log(
      JSON.stringify(
        { window: w, min_match_score: MIN_MATCH_SCORE, ...report },
        null,
        2,
      ),
    );
  else {
    out.log(JSON.stringify(report.device));
    out.log(
      "| anchor | model | cut bytes | cut ms | decode ms | asr ms | time-to-locate ms | hit | score | shift s |",
    );
    out.log("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of report.results) {
      out.log(
        `| ${r.anchor} | ${r.model} | ${fmtInt(r.cut_bytes)} | ${r.cut_ms} | ${r.decode_ms} | ${r.asr_ms} | ${r.time_to_locate_ms} | ${r.hit ? "hit" : `miss${r.reason ? ` (${r.reason})` : ""}`} | ${r.score == null ? "—" : r.score.toFixed(3)} | ${r.shift_sec == null ? "—" : r.shift_sec.toFixed(1)} |`,
      );
    }
  }
  return 0;
}

const invoked = isEntryScript(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
