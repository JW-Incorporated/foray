import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  main,
  parseReplayArgs,
  ReplayUsageError,
} from "../src/cli/replaySourcing";
import { RetrievalService } from "../src/cli/retrievalServer";
import {
  compareReplays,
  summarizeReplayBeats,
  type ReplayReport,
} from "../src/generation/replayCompare";
import type {
  RetrievalFetch,
  RetrievalFetchInit,
} from "../src/generation/retrievalClient";
import {
  deriveItemId,
  FileTranscriptCueProvider,
  type TranscriptCue,
  type TranscriptDigestEntry,
} from "../src/generation/transcriptArchiveLookup";
import type { DeepenedAct } from "../src/types/spine";

/**
 * GV-88 (docs/roadmap/generation-v2.md, W3-15): the replay CLI, end to end and
 * offline. `main()` replays sourcing alone over a SYNTHETIC two-show corpus in
 * a tmpdir, shaped by the run-2 attempt-6 fixture
 * (`fixtures/run2-attempt6-deepen-2026-09-09.json`: 4 acts, 32 beats, 14
 * seeded, 4 argument) with every claim REWRITTEN to a synthetic vocabulary of
 * made-up words, so no podcast text and no Opus-era claim reaches the corpus.
 *
 * THE CORPUS. Two shows (synth-alpha, synth-beta), six episodes each. Each
 * searching beat's own words are spoken over four 20 s cues, dealt round-robin
 * onto the twelve episodes between filler; a seeded beat's seed names the
 * episode and seconds its words are spoken at. Three unseeded beats are spoken
 * nowhere (`UNSPOKEN`), so the unseeded yield is under 1. One unseeded beat
 * (`DENSE`) is spoken alone in a thirteenth episode, which the remote cases
 * use to stand in for a dense-only rescue. `root` is a repo stand-in: an empty
 * catalogue and a transcript-availability row per show (so the REAL digest
 * audio resolver mints), no data/forays.json (nothing supersedable). Topic
 * none: the lineage gate is inert.
 *
 * The remote cases route RemoteRetrieval's injected fetch into an in-process
 * `RetrievalService` (the server's own logic, no HTTP) over the same files.
 * No model, no network.
 */

const FIXTURE = path.join(
  __dirname,
  "fixtures",
  "run2-attempt6-deepen-2026-09-09.json",
);
const SHOWS = [
  { id: "synth-alpha", title: "Synth Alpha Hour" },
  { id: "synth-beta", title: "Synth Beta Weekly" },
];
const PER_SHOW = 6;
/** Unseeded searching beats spoken nowhere, by Foray ordinal. */
const UNSPOKEN = new Set(["0.0.4", "1.0.3", "3.0.4"]);
/** The unseeded beat spoken alone in its own episode. */
const DENSE = "2.0.3";
const FILLER = [
  "anyway let us take a short break for a word from the people who pay for this show",
  "and we are back so thanks again to everybody who wrote in last week with questions",
  "my cousin keeps bees on a rooftop in the city which is a whole other conversation",
  "the weather here has been strange all month with rain every single afternoon",
];

const SYL = ["ka", "lo", "mi", "tu", "re", "sa", "vo", "ne", "pi", "du"];
/** A made-up word, unique per (beat ordinal, position): letters only. */
function synthWord(beat: number, j: number): string {
  const k = beat * 10 + j;
  return `${SYL[Math.floor(k / 100) % 10]}${SYL[Math.floor(k / 10) % 10]}${SYL[k % 10]}rn`;
}
const synthClaim = (beat: number): string =>
  Array.from({ length: 10 }, (_, j) => synthWord(beat, j)).join(" ");

function claimCues(claim: string, startSec: number): TranscriptCue[] {
  const words = claim.split(" ");
  const per = Math.ceil(words.length / 4);
  return [0, 1, 2, 3].map((i) => ({
    text: words.slice(i * per, (i + 1) * per).join(" ") || "right",
    start_sec: startSec + i * 20,
    end_sec: startSec + (i + 1) * 20,
  }));
}

interface Corpus {
  acts: DeepenedAct[];
  archive: TranscriptDigestEntry[];
  cuesByGuid: Map<string, TranscriptCue[]>;
  denseEntry: TranscriptDigestEntry;
  denseClaim: string;
  /** Every claim spoken in each episode, by guid. */
  claimsByGuid: Map<string, string[]>;
  /** The seeded beats, with the episode guid their seed names. */
  seeded: Array<{ key: string; guid: string }>;
}

function buildCorpus(): Corpus {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
    acts: DeepenedAct[];
  };
  const episodes: TranscriptDigestEntry[] = [];
  for (const show of SHOWS)
    for (let e = 0; e < PER_SHOW; e++)
      episodes.push({
        show_id: show.id,
        show_title: show.title,
        guid: `${show.id}-ep-${e}`,
        title: `Episode ${100 + e}`,
        cues: 0,
      });
  const denseEntry: TranscriptDigestEntry = {
    show_id: "synth-beta",
    show_title: "Synth Beta Weekly",
    guid: "synth-beta-ep-solo",
    title: "Episode 199",
    cues: 0,
  };
  const spoken = new Map<TranscriptDigestEntry, string[]>();
  let ordinal = 0;
  let dealt = 0;
  let denseClaim = "";
  const seeded: Array<{ key: string; guid: string }> = [];
  const acts = raw.acts.map((act, a) => ({
    ...act,
    slots: act.slots.map((slot, s) => ({
      ...slot,
      beats: slot.beats.map((beat, b) => {
        const key = `${a}.${s}.${b}`;
        const claim = synthClaim(ordinal++);
        const rest = { ...beat };
        delete rest.seed;
        if (beat.kind === "argument" || UNSPOKEN.has(key))
          return { ...rest, claim };
        if (key === DENSE) {
          denseClaim = claim;
          spoken.set(denseEntry, [claim]);
          return { ...rest, claim };
        }
        const entry = episodes[dealt++ % episodes.length]!;
        const mine = spoken.get(entry) ?? [];
        mine.push(claim);
        spoken.set(entry, mine);
        /* Each claim sits after 60 s of filler and 160 s past the previous one. */
        const startSec = 60 + (mine.length - 1) * 240;
        if (beat.seed) seeded.push({ key, guid: entry.guid });
        return beat.seed
          ? {
              ...rest,
              claim,
              seed: {
                episodeId: deriveItemId(entry),
                startSec,
                endSec: startSec + 80,
              },
            }
          : { ...rest, claim };
      }),
    })),
  }));
  const cuesByGuid = new Map<string, TranscriptCue[]>();
  const archive: TranscriptDigestEntry[] = [];
  for (const entry of [...episodes, denseEntry]) {
    const cues: TranscriptCue[] = [];
    let t = 0;
    const filler = (n: number) => {
      for (let k = 0; k < n; k++, t += 20)
        cues.push({
          text: FILLER[(t / 20) % FILLER.length]!,
          start_sec: t,
          end_sec: t + 20,
        });
    };
    filler(3);
    for (const claim of spoken.get(entry) ?? []) {
      cues.push(...claimCues(claim, t));
      t += 80;
      filler(8);
    }
    cuesByGuid.set(entry.guid, cues);
    archive.push({
      ...entry,
      cues: cues.length,
      feed_duration_sec: Math.max(3600, t + 60),
      enclosure_url: `https://cdn.example/${entry.guid}.mp3`,
    });
  }
  return {
    acts,
    archive,
    cuesByGuid,
    denseEntry: archive.find((e) => e.guid === denseEntry.guid)!,
    denseClaim,
    claimsByGuid: new Map(
      [...spoken].map(([entry, claims]) => [entry.guid, claims]),
    ),
    seeded,
  };
}

let tmp = "";
let corpus: Corpus;
let files: {
  fixture: string;
  archive: string;
  pool: string;
  root: string;
  normalized: string;
  index: string;
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gv88-replay-"));
  corpus = buildCorpus();
  const normalized = path.join(tmp, "normalized");
  for (const entry of corpus.archive) {
    const dir = path.join(normalized, entry.show_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${entry.guid}.json`),
      JSON.stringify({
        show_id: entry.show_id,
        guid: entry.guid,
        cues: corpus.cuesByGuid.get(entry.guid),
      }),
    );
  }
  const root = path.join(tmp, "repo");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "catalog.json"),
    JSON.stringify({ shows: [] }),
  );
  fs.writeFileSync(
    path.join(root, "data", "transcript-availability.json"),
    JSON.stringify({
      shows: SHOWS.map((s) => ({
        show_id: s.id,
        dai_suspected: false,
        feed_url: `https://feeds.example/${s.id}.xml`,
      })),
    }),
  );
  files = {
    fixture: path.join(tmp, "synthetic-attempt6.json"),
    archive: path.join(tmp, "archive.json"),
    pool: path.join(tmp, "pool.json"),
    root,
    normalized,
    index: path.join(tmp, "index"),
  };
  fs.writeFileSync(files.fixture, JSON.stringify({ acts: corpus.acts }));
  fs.writeFileSync(files.archive, JSON.stringify(corpus.archive));
  fs.writeFileSync(files.pool, JSON.stringify([]));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const runArgv = (extra: string[] = []): string[] => [
  "run",
  "--fixture",
  files.fixture,
  "--topic",
  "none",
  "--root",
  files.root,
  "--archive",
  files.archive,
  "--pool",
  files.pool,
  "--normalized-root",
  files.normalized,
  "--index-root",
  files.index,
  ...extra,
];

/* ------------------------------------------------------------------ */
/* The in-process retrieval server behind an injected fetch            */
/* ------------------------------------------------------------------ */

interface FakeOptions {
  /** bm25 answers no candidate for these claims (the keyword arm misses them). */
  dropFor?: ReadonlySet<string>;
  /** hybrid answers this episode for this claim as dense-only. */
  dense?: { claim: string; entry: TranscriptDigestEntry };
}

function fakeServer(options: FakeOptions = {}): {
  fetchFn: RetrievalFetch;
  modes: string[];
} {
  const svc = new RetrievalService({
    loadArchive: () => ({ rows: corpus.archive, generatedAt: null }),
    loadManifest: () => null,
    createCueStore: () => new FileTranscriptCueProvider(files.normalized),
    indexRoot: path.join(tmp, "server-index"),
    logger: { info: () => undefined, error: () => undefined },
  });
  const modes: string[] = [];
  const fetchFn: RetrievalFetch = async (
    url: string,
    init: RetrievalFetchInit,
  ) => {
    const u = new URL(url);
    const body = init.body
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
    let json: unknown;
    let status = 200;
    if (u.pathname === "/v1/episodes") json = svc.episodes();
    else if (u.pathname === "/v1/scopes")
      json = svc.createScope(body?.episodes);
    else if (u.pathname === "/v1/search") {
      const mode = typeof body?.mode === "string" ? body.mode : "bm25";
      modes.push(mode);
      const queries = body?.queries as Array<{ text: string; limit: number }>;
      const results = svc.search(body?.scopeId, queries);
      json = {
        results: results.map((r, i) => {
          const text = queries[i]!.text;
          let candidates: Array<Record<string, unknown>> =
            options.dropFor?.has(text)
              ? []
              : r.candidates.map((c) => ({ ...c }));
          if (mode === "hybrid") {
            candidates = candidates.map((c) => ({ ...c, via: "bm25" }));
            if (options.dense && text === options.dense.claim) {
              candidates.push({
                show_id: options.dense.entry.show_id,
                guid: options.dense.entry.guid,
                score: 0,
                matchedTerms: 0,
                via: "dense",
              });
            }
          }
          return { ...r, candidates };
        }),
      };
    } else if (u.pathname === "/v1/cues") {
      try {
        json = svc.cues(
          u.searchParams.get("show_id"),
          u.searchParams.get("guid"),
        );
      } catch (error) {
        status = (error as { status?: number }).status ?? 500;
        json = { error: String(error) };
      }
    } else {
      status = 404;
      json = { error: "not found" };
    }
    const text = JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fetchFn, modes };
}

const quiet = { stdout: () => undefined };
const remoteEnv = (mode = "bm25") => ({
  FORAY_RETRIEVAL_URL: "http://retrieval.test",
  FORAY_RETRIEVAL_MODE: mode,
});

describe("replaySourcing: the CLI replays sourcing alone, offline", () => {
  it("main() runs over the synthetic two-show corpus, deterministically, and the report says what each beat did", async () => {
    /* MUTATION THAT KILLS THIS: record the act-thesis search (limit 1) instead
       of the claim search in RecordingTextIndex (every beat's candidates are
       then []), or mark every beat seeded. Ran the first: red. */
    const lines: string[] = [];
    const first = await main(runArgv(), {
      env: {},
      stdout: (t) => lines.push(t),
    });
    const second = await main(runArgv(), { env: {}, stdout: () => undefined });
    expect(first.code).toBe(0);
    const report = first.report!;
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(report));
    expect(JSON.parse(lines.join(""))).toEqual(
      JSON.parse(JSON.stringify(report)),
    );

    expect(report.fixture).toBe("synthetic-attempt6.json");
    expect(report.retrieval).toEqual({ source: "local", mode: "bm25" });
    expect(report.beats).toHaveLength(32);
    const s = report.summary;
    expect(s).toEqual(summarizeReplayBeats(report.beats));
    expect(s.searchedBeats).toBe(28);
    expect(s.seededBeats).toBe(14);
    expect(s.unseededBeats).toBe(14);
    /* Not vacuous, and exact: every spoken beat placed on its own episode
       (13 episodes, both shows), every seed won, the three unspoken beats
       narrated at the text index, so 11 of 14 unseeded beats found tape. */
    expect(s.tapeBeats).toBe(25);
    expect(s.seedsWon).toBe(14);
    expect(s.showVariety).toMatchObject({
      distinctShows: 2,
      distinctEpisodes: 13,
    });
    for (const key of UNSPOKEN)
      expect(report.beats.find((b) => b.key === key)).toMatchObject({
        sourcing: "narration",
        gate: "text-index:no-candidate",
      });
    expect(s.unseededTapeBeats).toBe(11);
    expect(s.unseededYield).toBe(11 / 14);
    /* Every searching beat that is spoken somewhere had its episode among its candidates. */
    const dense = report.beats.find((b) => b.key === DENSE)!;
    expect(dense.candidates.map((c) => c.guid)).toContain(
      corpus.denseEntry.guid,
    );
    expect(
      report.beats.every((b) => b.candidates.every((c) => c.via === "bm25")),
    ).toBe(true);
    for (const b of report.beats.filter((x) => x.kind === "argument")) {
      expect(b).toMatchObject({
        searched: false,
        gate: "skipped:argument",
        candidates: [],
      });
    }
    for (const b of report.beats.filter((x) => x.sourcing === "tape")) {
      expect(b.gate).toBe("placed");
      expect(b.winner).not.toBeNull();
    }
    expect(
      report.beats
        .filter((b) => b.seeded)
        .every((b) => b.seedWindowWon !== null),
    ).toBe(true);
    expect(
      report.beats
        .filter((b) => !b.seeded)
        .every((b) => b.seedWindowWon === null),
    ).toBe(true);
  });

  it("--out writes the report and prints one summary line; compare of a replay with itself passes the default gate", async () => {
    /* MUTATION THAT KILLS THIS: return code 0 for a failing compare in main(),
       or skip writeOut when --out is given. Ran the first: red on the hybrid
       self-compare's exit code. */
    const out = path.join(tmp, "out", "base.json");
    const lines: string[] = [];
    expect(
      (
        await main(runArgv(["--out", out]), {
          env: {},
          stdout: (t) => lines.push(t),
        })
      ).code,
    ).toBe(0);
    expect(lines.join("")).toMatch(
      /^replay: synthetic-attempt6\.json local\/bm25 beats=32 searched=28 /,
    );
    const written = JSON.parse(fs.readFileSync(out, "utf8")) as ReplayReport;
    expect(written.format).toBe("replay-sourcing/1");
    const verdicts: string[] = [];
    const same = await main(["compare", out, out], {
      stdout: (t) => verdicts.push(t),
    });
    expect(same.code).toBe(0);
    expect(same.comparison!.verdict).toBe("pass");
    const hybrid = await main(["compare", out, out, "--gate", "hybrid"], {
      stdout: (t) => verdicts.push(t),
    });
    expect(hybrid.code).toBe(1);
    expect(verdicts.join("")).toContain(
      "replay compare (hybrid): FAIL - no gain",
    );
  });

  it("a remote bm25 replay prepares the exact questions sourcing asks: no miss, no hydration miss, the same beats as local", async () => {
    /* MUTATION THAT KILLS THIS: prepare claims at limit 1 or skip the act
       theses. Ran the thesis one: red on misses. (Hydrating only the
       candidates does NOT fail this one, since every seeded episode is also a
       candidate here; the next test guards the seed hydration.) */
    const local = (await main(runArgv(), { env: {}, ...quiet })).report!;
    const server = fakeServer();
    const remote = (
      await main(runArgv(), {
        env: remoteEnv(),
        fetchFn: server.fetchFn,
        ...quiet,
      })
    ).report!;
    expect(remote.retrieval).toEqual({ source: "remote", mode: "bm25" });
    expect(server.modes.every((m) => m === "bm25")).toBe(true);
    expect(remote.retrievalStats).toMatchObject({
      misses: 0,
      hydrationMisses: 0,
      degraded: 0,
      denseOnlyPrepared: 0,
    });
    expect(remote.beats).toEqual(local.beats);
    expect(compareReplays(local, remote).verdict).toBe("pass");
  });

  it("a remote replay hydrates a seeded episode no candidate names, so its seed window still wins", async () => {
    /* MUTATION THAT KILLS THIS: hydrate only the candidates and the title
       match (drop the seed/pool loop in remoteRetrieval). Ran it: red on
       seedWindowWon. */
    const { key, guid } = corpus.seeded[0]!;
    const server = fakeServer({
      dropFor: new Set(corpus.claimsByGuid.get(guid)),
    });
    const remote = (
      await main(runArgv(), {
        env: remoteEnv(),
        fetchFn: server.fetchFn,
        ...quiet,
      })
    ).report!;
    /* The episode is reachable only through the seed: no beat's candidates
       name it. */
    expect(
      remote.beats.some((b) => b.candidates.some((c) => c.guid === guid)),
    ).toBe(false);
    const beat = remote.beats.find((b) => b.key === key)!;
    expect(beat.seeded).toBe(true);
    expect(beat.seedWindowWon).toBe(true);
    expect(beat.sourcing).toBe("tape");
    expect(remote.retrievalStats).toMatchObject({
      misses: 0,
      hydrationMisses: 0,
    });
  });

  it("hybrid: a dense-only rescue of an unseeded beat passes the hybrid gate against the bm25 arm that missed it", async () => {
    /* MUTATION THAT KILLS THIS: answer every remote candidate's via as 'bm25'
       instead of reading hintsFor, or count a dense win only when the beat is
       seeded. Ran the first: red on the winner's via. */
    const options = {
      dropFor: new Set([corpus.denseClaim]),
      dense: { claim: corpus.denseClaim, entry: corpus.denseEntry },
    };
    const base = (
      await main(runArgv(), {
        env: remoteEnv("bm25"),
        fetchFn: fakeServer(options).fetchFn,
        ...quiet,
      })
    ).report!;
    const server = fakeServer(options);
    const hybrid = (
      await main(runArgv(["--mode", "hybrid"]), {
        env: remoteEnv(),
        fetchFn: server.fetchFn,
        ...quiet,
      })
    ).report!;
    expect(hybrid.retrieval.mode).toBe("hybrid");
    expect(server.modes).toContain("hybrid");

    const missed = base.beats.find((b) => b.key === DENSE)!;
    expect(missed).toMatchObject({ sourcing: "narration", candidates: [] });
    const rescued = hybrid.beats.find((b) => b.key === DENSE)!;
    expect(rescued.sourcing).toBe("tape");
    expect(rescued.winner!.via).toBe("dense");
    expect(hybrid.summary.denseOnlyCandidates).toBe(1);
    expect(hybrid.summary.denseOnlyWins).toBe(1);
    expect(hybrid.retrievalStats).toMatchObject({
      denseOnlyPrepared: 1,
      misses: 0,
    });

    const verdict = compareReplays(base, hybrid, { gate: "hybrid" });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.gainedTape).toEqual([DENSE]);
    expect(verdict.unseededTapeBeats.delta).toBe(1);
    expect(compareReplays(hybrid, hybrid, { gate: "hybrid" }).verdict).toBe(
      "pass",
    );
    expect(compareReplays(base, base, { gate: "hybrid" }).verdict).toBe("fail");
  });
});

describe("replaySourcing: arguments and refusals", () => {
  it("refuses a hybrid run without the server, an unreplayable show-share mode, and an unknown flag", async () => {
    /* MUTATION THAT KILLS THIS: accept --show-share order (forwarding a mode
       sourcing ignores). Ran it: red. */
    expect(() => parseReplayArgs(runArgv(["--show-share", "order"]))).toThrow(
      /GV-115/,
    );
    expect(() => parseReplayArgs(runArgv(["--bogus", "1"]))).toThrow(
      ReplayUsageError,
    );
    expect(() => parseReplayArgs(["run", "--fixture", files.fixture])).toThrow(
      /--topic/,
    );
    expect(parseReplayArgs(runArgv()).command).toBe("run");
    const refused = await main(runArgv(["--mode", "hybrid"]), {
      env: {},
      ...quiet,
    });
    expect(refused.code).toBe(2);
  });
});
