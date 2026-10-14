import * as fs from "fs";
import * as path from "path";
import { DeepenedActSchema, type DeepenedAct } from "../types/spine";
import type { SourceBeatsResult } from "../types/tapeSourcing";
import {
  createDigestAudioSourceResolver,
  type AudioSourceResolver,
} from "../generation/audioSourceLookup";
import { capArgumentBeats } from "../generation/deepenActs";
import { makeSupersedableCut } from "../generation/finalizeForay";
import {
  claimHash,
  compareReplays,
  parseGold,
  REPLAY_FORMAT,
  summarizeReplayBeats,
  type ReplayBeat,
  type ReplayCandidate,
  type ReplayComparison,
  type ReplayGate,
  type ReplayReport,
  type ReplayWinner,
} from "../generation/replayCompare";
import { loadTaxonomyNodes } from "../generation/resolveTopic";
import {
  HydratingCueProvider,
  PrecomputedTextIndex,
  RemoteRetrieval,
  type RetrievalFetch,
  type RetrievalMode,
  type RetrievalSearchRequest,
} from "../generation/retrievalClient";
import {
  loadSegmentPool,
  type SegmentRecord,
} from "../generation/segmentPoolLookup";
import { showKeyForItem } from "../generation/showIdentity";
import { sourceBeats } from "../generation/sourceBeats";
import {
  familyGateAllows,
  nodesForArchiveEntry,
} from "../generation/taxonomyFamily";
import {
  deriveItemId,
  FileTranscriptCueProvider,
  findTranscriptArchiveMatch,
  loadTranscriptArchive,
  type TranscriptCueProvider,
  type TranscriptDigestEntry,
} from "../generation/transcriptArchiveLookup";
import {
  FileTranscriptTextIndex,
  TRANSCRIPT_TEXT_CANDIDATES,
  type TranscriptTextCandidate,
  type TranscriptTextIndex,
  type TranscriptTextSearchOptions,
} from "../generation/transcriptTextIndex";
import { retrievalToken } from "./retrievalServer";

/**
 * THE RETRIEVAL REPLAY (GV-88; roadmap docs/roadmap/generation-v2.md, from
 * W3-15; covers R2-04, QK-22, R1-09).
 *
 *     node tools/passage-index/replay.mjs run --fixture FILE --topic NODE|none
 *       [--out FILE] [--mode bm25|hybrid] [--show-share off]
 *       [--root DIR] [--archive FILE] [--pool FILE]
 *       [--normalized-root DIR] [--index-root DIR]
 *     node tools/passage-index/replay.mjs compare BASE.json CAND.json
 *       [--gate default|hybrid] [--gold FILE] [--out FILE]
 *
 * `run` replays §4.5 sourcing ALONE over a banked deepen output: no spine, no
 * deepen, no writer, no model of any kind. The fixture is a deepen fixture
 * (`{acts: [...]}`, e.g. backend/test/fixtures/run2-deepen-2026-09-09.json), a
 * pipeline checkpoint file (its `deepen:<i>` stages) or a bare array of acts;
 * every act is parsed with `DeepenedActSchema` and given the argument cap
 * (`capArgumentBeats`, idempotent), exactly what `runPipeline.ts` hands
 * `sourceBeats`. Retrieval is
 *   - local (the default): `FileTranscriptCueProvider` + `FileTranscriptTextIndex`
 *     over `data-local/transcripts/` (or `--normalized-root` / `--index-root`),
 *     BM25 only, the pair `generateForays.ts` builds;
 *   - remote, when FORAY_RETRIEVAL_URL is set: `RemoteRetrieval` (GV-29), its
 *     two scopes registered for the topic, every claim and act-thesis search
 *     sourcing will ask PREPARED with the exact strings and limits the call
 *     sites pass, the candidates', seeds', title matches' and pool rows'
 *     bodies hydrated, then read synchronously through `PrecomputedTextIndex`
 *     and `HydratingCueProvider`. `--mode` (else FORAY_RETRIEVAL_MODE, else
 *     bm25) picks the server's arm; the token is FORAY_RETRIEVAL_TOKEN(_FILE).
 * Sourcing gets the pipeline's own options otherwise: the committed pool and
 * archive (or `--pool` / `--archive` JSON for a synthetic corpus), the topic
 * gate, the digest audio resolver and the supersedable-cut rule, both read
 * from `--root` (default: the repo).
 *
 * The report (`ReplayReport`, replayCompare.ts) is deterministic: no clock, no
 * host, no path beyond the fixture's basename. It holds the beats' claims, so
 * it is written under data-local/ and never committed.
 *
 * `compare` diffs two reports with `compareReplays` and exits 0 on 'pass', 1
 * on 'fail'. `--gold` adds candidate recall@8 against the id-only label file
 * (tools/passage-index/eval/gold.json).
 *
 * `--show-share` takes `off` only: the show-share rule is GV-115's
 * SourceBeatsOptions.showShare, not on this main yet, and a replay that
 * claimed a mode sourcing ignores would be a wrong number.
 *
 * Exit: 0 done / pass, 1 compare fail, 2 usage or input error.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface ReplayRunArgs {
  command: "run";
  fixture: string;
  topic: string | null;
  out: string | null;
  mode: RetrievalMode | null;
  showShare: "off";
  root: string;
  archive: string | null;
  pool: string | null;
  normalizedRoot: string | null;
  indexRoot: string | null;
}

export interface ReplayCompareArgs {
  command: "compare";
  base: string;
  cand: string;
  gate: ReplayGate;
  gold: string | null;
  out: string | null;
}

export type ReplayArgs = ReplayRunArgs | ReplayCompareArgs;

export class ReplayUsageError extends Error {}

const USAGE =
  "usage: replay run --fixture FILE --topic NODE|none [--out FILE] [--mode bm25|hybrid] [--show-share off] [--root DIR] [--archive FILE] [--pool FILE] [--normalized-root DIR] [--index-root DIR]\n" +
  "       replay compare BASE.json CAND.json [--gate default|hybrid] [--gold FILE] [--out FILE]";

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new ReplayUsageError(`${arg} needs a value\n${USAGE}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const allow = (names: string[]): void => {
    for (const name of flags.keys())
      if (!names.includes(name))
        throw new ReplayUsageError(`unknown flag --${name}\n${USAGE}`);
  };
  if (command === "run") {
    allow([
      "fixture",
      "topic",
      "out",
      "mode",
      "show-share",
      "root",
      "archive",
      "pool",
      "normalized-root",
      "index-root",
    ]);
    if (positional.length > 0)
      throw new ReplayUsageError(`run takes no positional arguments\n${USAGE}`);
    const fixture = flags.get("fixture");
    const topic = flags.get("topic");
    if (!fixture) throw new ReplayUsageError(`run needs --fixture\n${USAGE}`);
    if (!topic)
      throw new ReplayUsageError(
        `run needs --topic (a data/taxonomy.json node id, or none)\n${USAGE}`,
      );
    const mode = flags.get("mode") ?? null;
    if (mode !== null && mode !== "bm25" && mode !== "hybrid")
      throw new ReplayUsageError(`--mode must be bm25 or hybrid, not ${mode}`);
    const showShare = flags.get("show-share") ?? "off";
    if (showShare !== "off") {
      throw new ReplayUsageError(
        `--show-share ${showShare}: sourcing has no show-share rule on this main (GV-115 adds SourceBeatsOptions.showShare); only 'off' is replayable`,
      );
    }
    return {
      command,
      fixture,
      topic: topic === "none" ? null : topic,
      out: flags.get("out") ?? null,
      mode,
      showShare: "off",
      root: path.resolve(flags.get("root") ?? REPO_ROOT),
      archive: flags.get("archive") ?? null,
      pool: flags.get("pool") ?? null,
      normalizedRoot: flags.get("normalized-root") ?? null,
      indexRoot: flags.get("index-root") ?? null,
    };
  }
  if (command === "compare") {
    allow(["gate", "gold", "out"]);
    if (positional.length !== 2)
      throw new ReplayUsageError(`compare takes two report files\n${USAGE}`);
    const gate = flags.get("gate") ?? "default";
    if (gate !== "default" && gate !== "hybrid")
      throw new ReplayUsageError(
        `--gate must be default or hybrid, not ${gate}`,
      );
    return {
      command,
      base: positional[0]!,
      cand: positional[1]!,
      gate,
      gold: flags.get("gold") ?? null,
      out: flags.get("out") ?? null,
    };
  }
  throw new ReplayUsageError(USAGE);
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

function readJson(file: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-named input file.
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The deepened acts of a deepen fixture, a checkpoint file or a bare array,
 * parsed and argument-capped as runPipeline hands them to sourcing. */
export function loadDeepenedActs(raw: unknown): DeepenedAct[] {
  let acts: unknown[];
  if (Array.isArray(raw)) acts = raw;
  else if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { acts?: unknown }).acts)
  )
    acts = (raw as { acts: unknown[] }).acts;
  else if (
    raw &&
    typeof raw === "object" &&
    (raw as { stages?: unknown }).stages &&
    typeof (raw as { stages: unknown }).stages === "object"
  ) {
    const stages = (raw as { stages: Record<string, unknown> }).stages;
    acts = [];
    for (let i = 0; `deepen:${i}` in stages; i++)
      acts.push(stages[`deepen:${i}`]);
  } else acts = [];
  if (acts.length === 0)
    throw new ReplayUsageError(
      "fixture: no deepened acts (expected {acts}, a checkpoint with deepen:<i> stages, or an array)",
    );
  return acts.map((act, i) => {
    const parsed = DeepenedActSchema.safeParse(act);
    if (!parsed.success)
      throw new ReplayUsageError(
        `fixture: act ${i} is not a DeepenedAct: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    return capArgumentBeats(parsed.data);
  });
}

/** Records the candidates of every claim search sourcing asks (the tier-2
 * query: limit TRANSCRIPT_TEXT_CANDIDATES with the lineage predicate), by the
 * query text. The act-thesis query (limit 1) is not a candidate list. */
class RecordingTextIndex implements TranscriptTextIndex {
  readonly enabled: boolean;
  readonly byClaim = new Map<string, TranscriptTextCandidate[]>();
  constructor(private readonly inner: TranscriptTextIndex) {
    this.enabled = inner.enabled;
  }
  search(
    queryText: string,
    options: TranscriptTextSearchOptions = {},
  ): TranscriptTextCandidate[] {
    const found = this.inner.search(queryText, options);
    if (
      (options.limit ?? TRANSCRIPT_TEXT_CANDIDATES) ===
        TRANSCRIPT_TEXT_CANDIDATES &&
      options.isUsable
    )
      this.byClaim.set(queryText, found);
    return found;
  }
}

interface Retrieval {
  textIndex: TranscriptTextIndex;
  cueProvider: TranscriptCueProvider;
  source: "local" | "remote";
  mode: RetrievalMode;
  /** The `via` of a candidate of a claim search. */
  viaOf: (claim: string, entry: TranscriptDigestEntry) => string;
  stats?: () => Record<string, unknown>;
}

export interface ReplayDeps {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; the global fetch otherwise. */
  fetchFn?: RetrievalFetch;
  stdout?: (text: string) => void;
}

async function remoteRetrieval(
  baseUrl: string,
  mode: RetrievalMode,
  acts: DeepenedAct[],
  archive: TranscriptDigestEntry[],
  pool: SegmentRecord[],
  topic: string | null,
  root: string,
  deps: ReplayDeps,
): Promise<Retrieval> {
  const env = deps.env ?? process.env;
  const retrieval = new RemoteRetrieval({
    baseUrl,
    token: retrievalToken(env),
    mode,
    archive,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
  await retrieval.loadManifest();
  await retrieval.prepareScope(topic, root);
  /* The exact questions sourcing will ask (sourceBeats.ts): each searching
     beat's claim at TRANSCRIPT_TEXT_CANDIDATES and each act's thesis at 1,
     both with the lineage predicate. */
  const isUsable = (entry: TranscriptDigestEntry) =>
    familyGateAllows(topic, nodesForArchiveEntry(entry, root), root);
  const claims: string[] = [];
  const requests: RetrievalSearchRequest[] = [];
  for (const act of acts) {
    requests.push({ scope: "lineage", text: act.thesis, limit: 1 });
    for (const slot of act.slots)
      for (const beat of slot.beats) {
        if (beat.kind === "argument") continue;
        claims.push(beat.claim);
        requests.push({
          scope: "lineage",
          text: beat.claim,
          limit: TRANSCRIPT_TEXT_CANDIDATES,
        });
      }
  }
  await retrieval.prepare(requests);
  /* Every body sourcing could open: the candidates, the seeded episodes, the
     title-path match and the pool rows' episodes (tier 1 reads their text). */
  const wanted = new Set<TranscriptDigestEntry>();
  let denseOnlyPrepared = 0;
  for (const claim of claims) {
    for (const c of retrieval.answerFor(
      "lineage",
      TRANSCRIPT_TEXT_CANDIDATES,
      claim,
    )?.candidates ?? [])
      wanted.add(c.entry);
    for (const hint of retrieval
      .hintsFor("lineage", TRANSCRIPT_TEXT_CANDIDATES, claim)
      .values())
      if (hint.via === "dense") denseOnlyPrepared += 1;
    const byTitle = findTranscriptArchiveMatch(claim, archive, isUsable);
    if (byTitle) wanted.add(byTitle.entry);
  }
  const seedIds = new Set<string>();
  for (const act of acts)
    for (const slot of act.slots)
      for (const beat of slot.beats)
        if (beat.seed) seedIds.add(beat.seed.episodeId);
  const poolItems = new Set(pool.map((s) => s.item_id));
  for (const entry of archive) {
    const itemId = deriveItemId(entry);
    if (seedIds.has(itemId) || seedIds.has(entry.guid) || poolItems.has(itemId))
      wanted.add(entry);
  }
  await retrieval.hydrate([...wanted], { pin: true });
  return {
    textIndex: new PrecomputedTextIndex(retrieval),
    cueProvider: new HydratingCueProvider(retrieval),
    source: "remote",
    mode,
    viaOf: (claim, entry) =>
      retrieval
        .hintsFor("lineage", TRANSCRIPT_TEXT_CANDIDATES, claim)
        .get(entry)?.via ?? "bm25",
    stats: () => ({ ...retrieval.stats(), denseOnlyPrepared }),
  };
}

function localRetrieval(
  args: ReplayRunArgs,
  archive: TranscriptDigestEntry[],
): Retrieval {
  const cueProvider = args.normalizedRoot
    ? new FileTranscriptCueProvider(path.resolve(args.normalizedRoot))
    : new FileTranscriptCueProvider();
  const textIndex = new FileTranscriptTextIndex({
    archive,
    bodies: cueProvider,
    ...(args.indexRoot ? { indexRoot: path.resolve(args.indexRoot) } : {}),
  });
  return {
    textIndex,
    cueProvider,
    source: "local",
    mode: "bm25",
    viaOf: () => "bm25",
  };
}

/* ------------------------------------------------------------------ */
/* The report                                                           */
/* ------------------------------------------------------------------ */

const at = (a: number, s: number, b: number): string => `${a}.${s}.${b}`;

/** One `ReplayBeat` per beat of `acts`, from sourcing's own result. */
export function replayBeats(
  acts: DeepenedAct[],
  result: SourceBeatsResult,
  candidatesByClaim: ReadonlyMap<string, TranscriptTextCandidate[]>,
  viaOf: (claim: string, entry: TranscriptDigestEntry) => string,
  showKeyOf: (itemId: string) => string,
): ReplayBeat[] {
  const relevance = new Map(
    result.tapeRelevance.map((r) => [
      at(r.actIndex, r.slotIndex, r.beatIndex),
      r,
    ]),
  );
  const trace = new Map(
    result.sourcingTrace.map((t) => [
      at(t.actIndex, t.slotIndex, t.beatIndex),
      t,
    ]),
  );
  const beats: ReplayBeat[] = [];
  acts.forEach((act, a) =>
    act.slots.forEach((slot, s) =>
      slot.beats.forEach((beat, b) => {
        const key = at(a, s, b);
        const sourced = result.acts[a]?.slots[s]?.beats[b];
        if (!sourced)
          throw new Error(`replay: sourcing returned no beat ${key}`);
        const found = candidatesByClaim.get(beat.claim) ?? [];
        const candidates: ReplayCandidate[] = found.map((c) => ({
          showId: String(c.entry.show_id),
          guid: String(c.entry.guid),
          itemId: deriveItemId(c.entry),
          rank: c.rank,
          via: viaOf(beat.claim, c.entry),
        }));
        const seeded = beat.seed !== undefined;
        const kind = beat.kind ?? "account";
        const row = relevance.get(key);
        const t = trace.get(key);
        let winner: ReplayWinner | null = null;
        if (sourced.sourcing === "tape") {
          const p = sourced.tape;
          const named = candidates.find((c) => c.itemId === p.itemId);
          const via = named
            ? named.via
            : row?.seedWindowWon === true
              ? "seed"
              : p.tier === 1
                ? "pool"
                : "title";
          winner = {
            segmentId: p.segmentId,
            itemId: p.itemId,
            tier: p.tier,
            startSec: p.startSec,
            endSec: p.endSec,
            showKey: showKeyOf(p.itemId),
            via,
            merged: sourced.mergedInto !== undefined,
          };
        }
        const tier1Gate = t?.tier1?.gate ?? null;
        const tier2Gate = t?.tier2?.gate ?? null;
        let furthestVia: string | null = null;
        if (t?.tier2 && t.tier2.bestShowId !== null) {
          const hit = found.find(
            (c) =>
              String(c.entry.show_id) === t.tier2!.bestShowId &&
              c.entry.title === t.tier2!.bestEpisodeTitle,
          );
          furthestVia = hit ? viaOf(beat.claim, hit.entry) : null;
        }
        beats.push({
          key,
          actIndex: a,
          slotIndex: s,
          beatIndex: b,
          claimHash: claimHash(beat.claim),
          claim: beat.claim,
          kind,
          searched: t?.outcome !== "skipped:argument",
          seeded,
          sourcing: sourced.sourcing,
          tier: winner ? winner.tier : null,
          gate: winner
            ? "placed"
            : t?.outcome === "skipped:argument"
              ? "skipped:argument"
              : (tier2Gate ?? tier1Gate ?? "no-tape"),
          tier1Gate,
          tier2Gate,
          seedGate: t?.tier2?.seedGate ?? null,
          seedWindowWon: seeded
            ? (row?.seedWindowWon ?? t?.tier2?.seedWindowWon ?? false)
            : null,
          candidates,
          winner,
          furthestVia,
        });
      }),
    ),
  );
  return beats;
}

/** Runs the replay and returns its report. Never calls a model. */
export async function runReplay(
  args: ReplayRunArgs,
  deps: ReplayDeps = {},
): Promise<ReplayReport> {
  const env = deps.env ?? process.env;
  const acts = loadDeepenedActs(readJson(args.fixture));
  if (
    args.topic !== null &&
    !loadTaxonomyNodes(args.root).some((n) => n.id === args.topic)
  ) {
    throw new ReplayUsageError(
      `--topic ${args.topic} is not a node of ${path.join(args.root, "data", "taxonomy.json")}`,
    );
  }
  const archive = args.archive
    ? (readJson(args.archive) as TranscriptDigestEntry[])
    : loadTranscriptArchive();
  const pool = args.pool
    ? (readJson(args.pool) as SegmentRecord[])
    : loadSegmentPool();
  const baseUrl = env.FORAY_RETRIEVAL_URL?.trim();
  const envMode = env.FORAY_RETRIEVAL_MODE?.trim();
  if (envMode && envMode !== "bm25" && envMode !== "hybrid")
    throw new ReplayUsageError(
      `FORAY_RETRIEVAL_MODE must be bm25 or hybrid, not ${envMode}`,
    );
  const mode: RetrievalMode =
    args.mode ?? (envMode as RetrievalMode | undefined) ?? "bm25";
  if (!baseUrl && mode === "hybrid")
    throw new ReplayUsageError(
      "hybrid needs the retrieval server: set FORAY_RETRIEVAL_URL (the local index is BM25 only)",
    );

  const retrieval = baseUrl
    ? await remoteRetrieval(
        baseUrl,
        mode,
        acts,
        archive,
        pool,
        args.topic,
        args.root,
        deps,
      )
    : localRetrieval(args, archive);
  const recording = new RecordingTextIndex(retrieval.textIndex);
  const audioSourceFor: AudioSourceResolver = createDigestAudioSourceResolver({
    root: args.root,
  });
  const supersedableCut = makeSupersedableCut(args.root);
  const result = sourceBeats(acts, {
    cueProvider: retrieval.cueProvider,
    textIndex: recording,
    segmentPool: pool,
    transcriptArchive: archive,
    topic: args.topic,
    root: args.root,
    audioSourceFor,
    ...(supersedableCut ? { supersedableCut } : {}),
  });
  const showCtx = {
    archive,
    newSegmentSources: result.newSegmentSources,
    root: args.root,
  };
  const beats = replayBeats(
    acts,
    result,
    recording.byClaim,
    retrieval.viaOf,
    (itemId) => showKeyForItem(itemId, showCtx),
  );
  const report: ReplayReport = {
    format: REPLAY_FORMAT,
    fixture: path.basename(args.fixture),
    topic: args.topic,
    retrieval: { source: retrieval.source, mode: retrieval.mode },
    showShare: args.showShare,
    beats,
    summary: summarizeReplayBeats(beats),
  };
  if (retrieval.stats) report.retrievalStats = retrieval.stats();
  return report;
}

function writeOut(file: string, value: unknown): void {
  const full = path.resolve(file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-named output file.
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same.
  fs.writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

function summaryLine(report: ReplayReport): string {
  const s = report.summary;
  const y = s.unseededYield === null ? "n/a" : s.unseededYield.toFixed(3);
  return (
    `replay: ${report.fixture} ${report.retrieval.source}/${report.retrieval.mode} beats=${s.beats} searched=${s.searchedBeats} ` +
    `tape=${s.tapeBeats} unseededYield=${y} (${s.unseededTapeBeats}/${s.unseededBeats}) shows=${s.showVariety.distinctShows} ` +
    `denseOnly candidates=${s.denseOnlyCandidates} wins=${s.denseOnlyWins} windowOverlapRefusals=${s.denseOnlyWindowOverlapRefusals}`
  );
}

function verdictLine(c: ReplayComparison): string {
  return `replay compare (${c.gate}): ${c.verdict.toUpperCase()}${c.reasons.length ? ` - ${c.reasons.join("; ")}` : ""}`;
}

export interface ReplayMainResult {
  code: number;
  report?: ReplayReport;
  comparison?: ReplayComparison;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: ReplayDeps = {},
): Promise<ReplayMainResult> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv);
    if (args.command === "run") {
      const report = await runReplay(args, deps);
      if (args.out) {
        writeOut(args.out, report);
        out(`${summaryLine(report)}\n`);
      } else out(`${JSON.stringify(report, null, 2)}\n`);
      return { code: 0, report };
    }
    const base = readJson(args.base) as ReplayReport;
    const cand = readJson(args.cand) as ReplayReport;
    for (const [name, r] of [
      ["base", base],
      ["cand", cand],
    ] as const) {
      if (r?.format !== REPLAY_FORMAT)
        throw new ReplayUsageError(`${name}: not a ${REPLAY_FORMAT} report`);
    }
    const gold = args.gold ? parseGold(readJson(args.gold)) : undefined;
    const comparison = compareReplays(base, cand, {
      gate: args.gate,
      ...(gold ? { gold } : {}),
    });
    if (args.out) writeOut(args.out, comparison);
    out(`${verdictLine(comparison)}\n`);
    return { code: comparison.verdict === "pass" ? 0 : 1, comparison };
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { code: 2 };
  }
}

if (require.main === module) {
  void main().then((r) => {
    process.exitCode = r.code;
  });
}
