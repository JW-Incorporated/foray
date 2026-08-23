/* Fetch the transcripts that are already free (epic #102, ADR-0004 step 1).

   WHY THIS EXISTS — `sweep-transcripts.mjs` deliberately never fetches a
   transcript body; it only indexes where they are. That was the right call for
   an index, and it left the actual acquisition step unwritten. This is that
   step, and it is the ONLY file in `tools/segments/` allowed to make a request
   for a transcript body.

   WHAT IT WILL AND WILL NOT FETCH. It reads `transcript_url` off the
   availability index and nothing else. `enclosure_url` is present on every
   episode row now (it is the join key) and is never requested: audio is a
   separate decision behind a gate (#108), and a transcript tool that quietly
   grew an audio path would be how that gate gets bypassed by accident.
   `assertTranscriptTarget` enforces this on every single fetch rather than
   trusting the call site, and the test suite pins it.

   WHY ONLY THE ANCHORABLE SHOWS BY DEFAULT. 7,571 timed transcripts exist in
   the index, and 6,625 of them belong to shows MEASURED injecting ads into the
   file we receive — 8-11 minutes on the worst of them
   (docs/curation/transcription-scale-plan.md §4). Their timestamps do not
   describe our audio, so a segment cut from them points at the wrong moment;
   fetching them is bandwidth spent on transcripts we cannot anchor. The default
   selection is therefore:

     non-DAI shows          assumed stable — see the caveat below
     + AD_FREE_SHOWS        measured delivering byte-identical (8 of the 14 are
                            DAI-flagged; the other 6 are non-DAI and measured)

   THE UNMEASURED POOL IS GONE, and it did not pay out. As of 2026-08-23 all 27
   transcript-shipping shows have been probed, so nothing here is waiting on a
   verdict any more. The 2,573 transcripts that were unmeasured resolved to 89
   anchorable, 2,183 injecting and 301 that still cannot be called — which moves
   this default from 587 to 676 (across 15 shows) and closes the "one cheap scan
   from an answer" line the scale plan had been carrying.

   THE CAVEAT, because the default is not "measured clean" and should not be
   read as it. 676 is 645 measured ad-free PLUS 31 that are measured INJECTING:
   Cider Chat is non-DAI, so the first clause admits it without ever consulting
   the measurement, and it came back at a median 1.013. "Stable by construction"
   is an assumption about hosts, and this is the first time it has been checked
   against one and been wrong.

   It is deliberately still admitted. ADR-0008 reversed exactly this gate: a >1%
   ratio used to REJECT a show as a source, eleven shows were dropped on that
   ground alone, and the ruling was that ad load stops being a sourcing gate and
   becomes a per-episode number deciding how a segment is anchored. Re-adding a
   1% rejection here would re-impose what that ADR removed, so it is an ADR-0008
   amendment to make, not a tweak to this file. The verdicts are recorded in
   data/dai-classification.json either way, so whoever makes that call has the
   numbers.

   `--all-timed` overrides the selection and reaches the remaining 6,594.

   WHERE THE BYTES GO — `data-local/transcripts/`, gitignored, same shape the
   research corpus settled on (#255): fetched third-party text lives outside the
   repo, and only a digest is committed. ~587 transcripts at ~50KB is ~30MB; the
   repo's `data/` is already 62MB of pipeline inputs and does not need a
   thirty-first. The committed `data/transcript-digests.json` records the hash,
   cue count and covered span of each one, which is what makes a later run able
   to say "this transcript changed" without keeping the text in git history.

   RESUMABLE. A transcript already on disk is not re-fetched. The politeness
   budget is the scarce resource here, not the disk.

   POLITENESS. Mirrors the sweep exactly: same honest User-Agent with a contact
   address, per-host minimum interval so shows sharing a CDN cannot burst it,
   `Retry-After` honoured on 429/5xx, hard timeout, bounded attempts.

   Usage:
     node tools/segments/fetch-transcripts.mjs
       [--limit N] [--concurrency 4] [--all-timed] [--show "Title"]
       [--dry-run] [--out DIR] [--digests PATH]                                */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { UA, awaitHostSlot, waitBeforeRetry } from "./politeness.mjs";
import { normalize } from "./transcript-normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BODY_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
/** A transcript larger than this is not a transcript. Guards against a CDN
    handing back a video on a mislabelled URL. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** How far past the feed's declared duration a transcript's last cue may sit
    before the timeline is treated as junk rather than long.

    This is not hypothetical tidiness. Inside Winemaking episode 210 ships a
    single cue ending at 359,999.999s — 100 hours, the `99:59:59.999` a writer
    emits when it means "no end time" — against a 4,231s episode. Summed
    naively that ONE file added 100 hours to a 527-hour corpus total, i.e. the
    headline number for the whole acquisition was 24% wrong because of one
    degenerate transcript.

    1.5 is deliberately loose: a transcript legitimately runs slightly past the
    feed's rounded `itunes:duration`, and on a DAI show it can run shorter than
    the delivered file. Nothing legitimate runs 85x. */
export const MAX_SPAN_RATIO = 1.5;

/** True when a transcript's timeline cannot describe this episode. Flagged on
    the digest rather than dropped: the cues may still be individually fine,
    and segment extraction needs to know the span is untrustworthy, not to
    have the evidence deleted. */
export function spanImplausible(lastCueSec, feedDurationSec) {
  if (!Number.isFinite(lastCueSec) || !Number.isFinite(feedDurationSec) || feedDurationSec <= 0) return false;
  return lastCueSec > feedDurationSec * MAX_SPAN_RATIO;
}

/** Shows whose delivered audio was MEASURED to match the feed declaration, so
    publisher timestamps anchor. Not an opinion, and not maintained by hand:
    this is a transcription of every ad_inflation.verdict === "ad-free" in
    data/dai-classification.json, and tools/transcribe/ad-inflation.test.mjs
    fails if the two ever disagree. To change it, re-run the scan:

      node tools/transcribe/ad-inflation.mjs

    Measured 2026-08-23 across all 27 transcript-shipping shows, 5 episodes
    each by 2-byte ranged GET. Note what is NOT here: Around the House with
    Eric G came back at a median 0.758 -- delivering a QUARTER FEWER bytes
    than its feed declares -- which is "could not tell", not "clean". */
export const AD_FREE_SHOWS = [
  "Being an Engineer",
  "Causality",
  "Geology Bites",
  "Inside Winemaking - the art and science of growing grapes and crafting wine",
  "Just Fly Performance Podcast",
  "Lab to Market Leadership",
  "Piano Tech Radio Hour",
  "Practical AI",
  "Sigma Nutrition Radio",
  "TechSurge: Deep Tech Podcast",
  "The BBQ Central Show",
  "The Enormocast: the climbing podcast",
  "The Violin Chronicles Podcast",
  "Tuned In",
];

export class FetchError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "FetchError";
    this.code = code;
  }
}

/* --------------------------------------------------------------- selection */

/** Which shows' transcripts can actually anchor a segment today. */
export function isAnchorableShow(show, { allTimed = false } = {}) {
  if ((show.episodes_with_timed_transcript || 0) === 0) return false;
  if (allTimed) return true;
  return show.dai_suspected !== true || AD_FREE_SHOWS.includes(show.title);
}

/** Flattens the index into the fetch queue. Only timed transcripts: a prose
    transcript cannot produce a boundary (ADR-0007), so fetching one spends a
    publisher's bandwidth on something no downstream lane can use. */
export function selectTargets(availability, { allTimed = false, showFilter = null } = {}) {
  const out = [];
  for (const show of availability?.shows || []) {
    if (showFilter && show.title !== showFilter) continue;
    if (!isAnchorableShow(show, { allTimed })) continue;
    for (const ep of show.episodes || []) {
      if (!ep.transcript_url || !ep.has_timestamps) continue;
      out.push({
        show_id: show.show_id,
        show_title: show.title,
        dai_suspected: show.dai_suspected ?? null,
        guid: ep.guid,
        title: ep.title,
        transcript_url: ep.transcript_url,
        transcript_type: ep.transcript_type,
        enclosure_url: ep.enclosure_url ?? null,
        duration_sec: ep.duration_sec ?? null,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ paths */

/** A feed guid is third-party text: it can be a URL, contain separators, or try
    to walk out of the tree. Slug for legibility, hash for uniqueness. */
export function safeKey(guid) {
  const slug = String(guid || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha1").update(String(guid || "")).digest("hex").slice(0, 10);
  return slug ? `${slug}-${hash}` : hash;
}

/** Builds the on-disk path. `safeKey` is what makes escape impossible — it
    slugs traversal and separators out of every component — and the assertion
    below is belt-and-braces that cannot currently fire through this signature.
    Kept anyway, at zero cost, for a future caller that assembles a path from
    something `safeKey` never saw; same posture as the corpus's `paths.mjs`.
    The test suite pins `safeKey`, not this check, because that is the guard
    doing the work. */
export function transcriptPath(baseDir, kind, showId, guid, ext) {
  const base = resolvePath(baseDir);
  const full = resolvePath(base, kind, safeKey(showId), `${safeKey(guid)}.${ext}`);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new FetchError("PATH_ESCAPE", `refusing to write outside ${base}: ${full}`);
  }
  return full;
}

/* -------------------------------------------------------------- politeness */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The second half of the audio interlock, on the way back rather than out.

    `assertTranscriptTarget` can only compare the two URLs a feed declared. A
    publisher that puts `type="text/vtt"` on an `.mp3` defeats it, and with
    `redirect: "follow"` and a permissive `Accept` the body would be buffered
    and written to disk as a transcript. The response's own Content-Type closes
    that: it is checked BEFORE `res.text()`, so an audio response is abandoned
    rather than downloaded. #108 is a gate; this tool does not get to open it
    because a feed was wrong. */
export function assertNotAudio(url, contentType) {
  const base = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (base.startsWith("audio/") || base.startsWith("video/")) {
    throw new FetchError("AUDIO_RESPONSE", `${url} returned ${base}; this tool never downloads audio (#108 is a gate)`);
  }
  return base;
}

/** The audio interlock. Called before every request; throws rather than
    fetching if the URL being requested is the episode's enclosure. */
export function assertTranscriptTarget(target) {
  if (!target.transcript_url) throw new FetchError("NO_TRANSCRIPT_URL", `${target.guid} has no transcript_url`);
  if (target.enclosure_url && target.transcript_url === target.enclosure_url) {
    throw new FetchError(
      "AUDIO_TARGET",
      `${target.guid}: transcript_url equals enclosure_url; this tool never fetches audio (#108 is a gate)`,
    );
  }
  return target.transcript_url;
}

export async function fetchBody(url, { fetchImpl = fetch, attempts = MAX_ATTEMPTS, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await awaitHostSlot(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": UA, Accept: "text/vtt, application/json;q=0.9, text/plain;q=0.8, */*;q=0.5" },
        redirect: "follow",
        signal: ctl.signal,
      });
      if (res.ok) {
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          throw new FetchError("TOO_LARGE", `${declared} bytes declared for ${url}`);
        }
        const contentType = res.headers.get("content-type");
        assertNotAudio(url, contentType);
        const text = await res.text();
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > MAX_BODY_BYTES) throw new FetchError("TOO_LARGE", `${bytes} bytes from ${url}`);
        return { text, content_type: contentType };
      }
      const err = new FetchError(`HTTP_${res.status}`, `${res.statusText || "request failed"} for ${url}`);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
      if (attempt < attempts) await sleep(waitBeforeRetry(url, res, attempt));
    } catch (e) {
      if (e instanceof FetchError && !e.code.startsWith("HTTP_5") && e.code !== "HTTP_429") throw e;
      lastError =
        e.name === "AbortError"
          ? new FetchError("TIMEOUT", `no response in ${timeoutMs}ms from ${url}`)
          : e instanceof FetchError
            ? e
            : new FetchError("NETWORK", `${e.message}${e?.cause?.code ? ` (${e.cause.code})` : ""} for ${url}`);
      if (attempt < attempts) await sleep(waitBeforeRetry(url, null, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/* --------------------------------------------------------------- digesting */

/** The committed record of a transcript whose text lives outside the repo.
    Everything here is small, stable, and enough to detect that a publisher
    silently rewrote a transcript we already cut segments from. */
export function digestOf(target, body, normalized) {
  const cues = normalized.cues;
  const lastCueSec = cues.length ? cues[cues.length - 1].end_sec : null;
  return {
    show_id: target.show_id,
    show_title: target.show_title,
    guid: target.guid,
    title: target.title,
    transcript_url: target.transcript_url,
    transcript_type: target.transcript_type,
    enclosure_url: target.enclosure_url,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    cues: cues.length,
    first_cue_sec: cues.length ? cues[0].start_sec : null,
    last_cue_sec: lastCueSec,
    span_implausible: spanImplausible(lastCueSec, target.duration_sec),
    feed_duration_sec: target.duration_sec,
    speakers: cues.some((c) => c.speaker) ? [...new Set(cues.map((c) => c.speaker).filter(Boolean))].length : 0,
    warnings: normalized.warnings,
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

const extFor = (type) =>
  ({ "text/vtt": "vtt", "application/srt": "srt", "application/x-subrip": "srt", "application/json": "json" })[type] || "txt";

/* -------------------------------------------------------------------- main */

/** A NaN here is not a harmless default: `--concurrency abc` produced zero
    workers and the run then reported ALL_FAILED, naming the wrong cause. */
export function numericArg(flag, raw, { min = 1 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) && raw !== "Infinity") throw new FetchError("BAD_ARG", `${flag} expects a number, got ${JSON.stringify(raw)}`);
  if (n < min) throw new FetchError("BAD_ARG", `${flag} must be at least ${min}, got ${n}`);
  return n;
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    limit: numericArg("--limit", get("--limit", "Infinity")),
    concurrency: numericArg("--concurrency", get("--concurrency", "4")),
    allTimed: argv.includes("--all-timed"),
    showFilter: get("--show", null),
    dryRun: argv.includes("--dry-run"),
    out: get("--out", null),
    digests: get("--digests", null),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const availabilityPath = process.env.AVAILABILITY_PATH
    ? resolvePath(process.cwd(), process.env.AVAILABILITY_PATH)
    : join(ROOT, "data", "transcript-availability.json");
  const outDir = args.out ? resolvePath(process.cwd(), args.out) : join(ROOT, "data-local", "transcripts");
  const digestsPath = args.digests ? resolvePath(process.cwd(), args.digests) : join(ROOT, "data", "transcript-digests.json");

  const availability = JSON.parse(readFileSync(availabilityPath, "utf8"));
  const all = selectTargets(availability, { allTimed: args.allTimed, showFilter: args.showFilter });
  const queue = all.slice(0, args.limit);
  if (queue.length === 0) throw new FetchError("NO_TARGETS", `no anchorable timed transcripts selected from ${availabilityPath}`);

  const shows = new Set(queue.map((t) => t.show_title));
  console.log(`${queue.length} timed transcript(s) across ${shows.size} show(s)${args.allTimed ? " (--all-timed)" : " (anchorable only)"}`);
  if (args.dryRun) {
    for (const s of shows) console.log(`  ${s}: ${queue.filter((t) => t.show_title === s).length}`);
    console.log("DRY_RUN: nothing fetched");
    return;
  }

  const digests = [];
  const errors = {};
  let done = 0, fetched = 0, cached = 0, empty = 0;

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      done++;
      const ext = extFor(target.transcript_type);
      const rawPath = transcriptPath(outDir, "raw", target.show_id, target.guid, ext);
      const normPath = transcriptPath(outDir, "normalized", target.show_id, target.guid, "json");
      try {
        let body;
        if (existsSync(rawPath)) {
          body = readFileSync(rawPath, "utf8");
          cached++;
        } else {
          const url = assertTranscriptTarget(target);
          const res = await fetchBody(url);
          body = res.text;
          mkdirSync(dirname(rawPath), { recursive: true });
          writeFileSync(rawPath, body);
          fetched++;
        }
        const normalized = normalize(body, target.transcript_type);
        if (normalized.cues.length === 0) empty++;
        writeJsonAtomic(normPath, {
          show_id: target.show_id,
          guid: target.guid,
          source_url: target.transcript_url,
          cues: normalized.cues,
          warnings: normalized.warnings,
        });
        digests.push(digestOf(target, body, normalized));
      } catch (e) {
        const code = e instanceof FetchError ? e.code : "UNEXPECTED";
        errors[code] = (errors[code] || 0) + 1;
        digests.push({
          show_id: target.show_id,
          show_title: target.show_title,
          guid: target.guid,
          transcript_url: target.transcript_url,
          error_code: code,
          error: e.message,
        });
      }
      if (done % 25 === 0) console.log(`  [${done}] fetched ${fetched}, cached ${cached}, errors ${Object.values(errors).reduce((a, b) => a + b, 0)}`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  digests.sort((a, b) => (a.show_id || "").localeCompare(b.show_id || "") || (a.guid || "").localeCompare(b.guid || ""));
  const ok = digests.filter((d) => !d.error_code);
  if (ok.length === 0) throw new FetchError("ALL_FAILED", `${digests.length} target(s), none succeeded (${JSON.stringify(errors)})`);

  const totalCues = ok.reduce((n, d) => n + d.cues, 0);
  // Implausible spans contribute their feed duration, not their claimed one.
  const usableSpanSec = (d) => (d.span_implausible ? d.feed_duration_sec || 0 : d.last_cue_sec || 0);
  const hours = Math.round((ok.reduce((n, d) => n + usableSpanSec(d), 0) / 3600) * 10) / 10;
  const implausible = ok.filter((d) => d.span_implausible).length;
  writeJsonAtomic(digestsPath, {
    version: 1,
    generated_at: new Date().toISOString(),
    policy:
      "digest only — transcript text lives in data-local/transcripts/ (gitignored), never in git. Audio is never fetched (#108).",
    selection: args.allTimed ? "all timed transcripts" : "anchorable only (non-DAI + measured ad-free)",
    summary: {
      transcripts: ok.length,
      shows: new Set(ok.map((d) => d.show_title)).size,
      cues_total: totalCues,
      hours_of_speech: hours,
      span_implausible: implausible,
      empty_after_normalise: empty,
      failed: digests.length - ok.length,
      error_codes: errors,
    },
    transcripts: digests,
  });

  console.log(`\n${ok.length} transcript(s) ok (${fetched} fetched, ${cached} cached), ${digests.length - ok.length} failed`);
  console.log(`  ${totalCues} cues, ~${hours} hours of anchored speech`);
  if (implausible) console.log(`  ${implausible} transcript(s) claim a span the episode cannot hold; counted at feed duration`);
  if (empty) console.log(`  ${empty} normalised to zero cues (format the normaliser could not read)`);
  if (Object.keys(errors).length) console.log(`  errors: ${JSON.stringify(errors)}`);
  console.log(`  text: ${outDir} (gitignored)`);
  console.log(`FETCH_COMPLETE: ${digestsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e instanceof FetchError ? e.message : e);
    process.exit(1);
  });
}
