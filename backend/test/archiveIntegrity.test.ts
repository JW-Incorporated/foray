import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SYNC_STATE_RELATIVE_PATH,
  SyncStateError,
  archiveIntegrity,
  readSyncState,
  remoteIntegrity,
  type SyncState,
} from "../src/generation/archiveIntegrity";
import {
  RemoteRetrieval,
  type RetrievalFetch,
  type RetrievalHealth,
} from "../src/generation/retrievalClient";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { scanNormalizedCorpus } from "../src/generation/transcriptCorpus";
import { TRANSCRIPT_TEXT_INDEX_VERSION } from "../src/generation/transcriptTextIndex";

/**
 * GV-101 (roadmap PKG-23): the run-start corpus integrity guard. The PKG-03
 * truncated-archive fixture was never built, so every local case builds a tmp
 * repo root: `data-local/transcripts/normalized/<dir>/<n>.json` bodies, scanned
 * by the real `scanNormalizedCorpus`, plus a sync-r2.mjs-shaped state file.
 * The remote cases drive the real `RemoteRetrieval` over a scripted fetch.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0))
    fs.rmSync(r, { recursive: true, force: true });
});

const SHOW_A = "history-pod-0123456789";
const SHOW_B = "science-pod-abcdef0123";

/** A tmp repo root holding `bodies[dir]` body files per show directory, and,
 * when given, a state file. Returns the root. */
function tmpRepo(bodies: Record<string, number>, state?: SyncState): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-integrity-"));
  roots.push(root);
  const normalized = path.join(root, "data-local", "transcripts", "normalized");
  for (const [dir, n] of Object.entries(bodies)) {
    fs.mkdirSync(path.join(normalized, dir), { recursive: true });
    for (let i = 0; i < n; i += 1)
      fs.writeFileSync(path.join(normalized, dir, `ep-${i}.json`), "{}");
  }
  if (state) {
    fs.mkdirSync(path.dirname(path.join(root, SYNC_STATE_RELATIVE_PATH)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, SYNC_STATE_RELATIVE_PATH),
      JSON.stringify(state),
    );
  }
  return root;
}

/** The state sync-r2.mjs writes for `bodies` (bodies_expected = their sum). */
function syncState(bodies: Record<string, number>): SyncState {
  const shows: SyncState["shows"] = {};
  let sum = 0;
  for (const [dir, n] of Object.entries(bodies)) {
    shows[dir] = { show_id: dir.replace(/-[0-9a-f]{10}$/, ""), bodies: n };
    sum += n;
  }
  return { bodies_expected: sum, shows, synced_at: "2026-10-01T00:00:00.000Z" };
}

/** The guard over a tmp repo, read the way the CLI reads it. */
function check(root: string) {
  return archiveIntegrity({
    state: readSyncState(root),
    shows: scanNormalizedCorpus(
      path.join(root, "data-local", "transcripts", "normalized"),
    ),
  });
}

describe("archiveIntegrity: the disk against the sync state (GV-101 local)", () => {
  /* MUTATION THAT KILLS THIS: drop the `found += have` sum (found stays 0).
     Ran it: red. */
  it("a disk that matches its sync state is ok", () => {
    const bodies = { [SHOW_A]: 3, [SHOW_B]: 2 };
    const root = tmpRepo(bodies, syncState(bodies));
    expect(check(root)).toEqual({
      ok: true,
      expected: 5,
      found: 5,
      missingShows: [],
      shortShows: [],
    });
  });

  /* MUTATION THAT KILLS THIS: compare directory counts instead of bodies
     (ok = state shows present on disk >= state shows): both directories are
     still there, so that reads ok. Ran it: red. */
  it("a truncated corpus is not ok and names the short show", () => {
    const root = tmpRepo(
      { [SHOW_A]: 3, [SHOW_B]: 1 },
      syncState({ [SHOW_A]: 3, [SHOW_B]: 4 }),
    );
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(7);
    expect(result.found).toBe(4);
    expect(result.shortShows).toEqual([
      { show: SHOW_B, expected: 4, found: 1 },
    ]);
    expect(result.missingShows).toEqual([]);
  });

  /* MUTATION THAT KILLS THIS: return { ok: false, expected: 0 } when there is
     no state (the guard would then refuse every machine that never synced).
     Ran it: red. */
  it("an absent state is ok with expected null", () => {
    const root = tmpRepo({ [SHOW_A]: 2 });
    expect(readSyncState(root)).toBeNull();
    expect(check(root)).toEqual({
      ok: true,
      expected: null,
      found: 0,
      missingShows: [],
      shortShows: [],
    });
  });

  /* MUTATION THAT KILLS THIS: drop the missingShows push (a deleted show
     directory would then only show up as a smaller total). Ran it: red. */
  it("a show in the state but missing on disk is listed", () => {
    const root = tmpRepo(
      { [SHOW_A]: 3 },
      syncState({ [SHOW_A]: 3, [SHOW_B]: 2, "emptied-0000000000": 0 }),
    );
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.missingShows).toEqual([SHOW_B]);
    expect(result.found).toBe(3);
    expect(result.expected).toBe(5);
  });

  /* MUTATION THAT KILLS THIS: read a state that is not JSON as null (the
     guard would switch itself off on a corrupt file). Ran it: red. */
  it("a state file that exists and is malformed throws SyncStateError, naming the file", () => {
    const root = tmpRepo({});
    const file = path.join(root, SYNC_STATE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(() => readSyncState(root)).toThrow(SyncStateError);
    expect(() => readSyncState(root)).toThrow(/r2-sync-state\.json/);
    fs.writeFileSync(file, JSON.stringify({ shows: {} }));
    expect(() => readSyncState(root)).toThrow(/bodies_expected/);
    fs.writeFileSync(
      file,
      JSON.stringify({ bodies_expected: 1, shows: { x: { bodies: "1" } } }),
    );
    expect(() => readSyncState(root)).toThrow(/shows\["x"\]\.bodies/);
  });
});

/* ------------------------------------------------------------------ */
/* Remote: /healthz and the manifest the existing client loaded          */
/* ------------------------------------------------------------------ */

const STAMP = "2026-10-01T00:00:00.000Z";
const entry = (show_id: string, guid: string): TranscriptDigestEntry => ({
  show_id,
  show_title: show_id,
  guid,
  title: guid,
  cues: 1,
});
const ARCHIVE = [
  entry("history-pod", "h1"),
  entry("history-pod", "h2"),
  entry("science-pod", "s1"),
];
const ROWS = ARCHIVE.map((e) => ({
  show_id: e.show_id,
  guid: e.guid,
  size: 10,
  mtimeMs: 1,
  transcript_source: null,
}));

/** The real client over a scripted server: /v1/episodes answers `rows`,
 * /healthz answers `healthz`. Nothing leaves the process. */
async function loaded(healthz: RetrievalHealth, rows: unknown[] = ROWS) {
  const fetchFn: RetrievalFetch = async (url) => {
    const route = new URL(url).pathname;
    const json =
      route === "/v1/episodes"
        ? rows
        : route === "/healthz"
          ? healthz
          : { error: "no route" };
    const status = route === "/v1/episodes" || route === "/healthz" ? 200 : 404;
    const text = JSON.stringify(json);
    return { ok: status === 200, status, text: async () => text };
  };
  const retrieval = new RemoteRetrieval({
    baseUrl: "https://retrieval.test",
    token: null,
    fetchFn,
    archive: ARCHIVE,
  });
  await retrieval.loadManifest();
  return { retrieval, health: await retrieval.health() };
}

const HEALTHY: RetrievalHealth = {
  indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION,
  shows: 2,
  episodes: 3,
  archiveGeneratedAt: STAMP,
};

describe("remoteIntegrity: the retrieval server against this machine (GV-101 remote)", () => {
  /* MUTATION THAT KILLS THIS: drop the index-version comparison. Ran it: red.
     MUTATION THAT KILLS THIS: drop the archive-stamp comparison. Ran it: red. */
  it("a matching server is ok; an index version or archive stamp mismatch is not", async () => {
    const good = await loaded(HEALTHY);
    expect(
      remoteIntegrity({
        healthz: good.health,
        pulledArchiveGeneratedAt: STAMP,
        manifest: good.retrieval.manifestShows(),
      }),
    ).toEqual({
      ok: true,
      expected: 3,
      found: 3,
      reasons: [],
    });

    const oldIndex = await loaded({
      ...HEALTHY,
      indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION - 1,
    });
    const version = remoteIntegrity({
      healthz: oldIndex.health,
      pulledArchiveGeneratedAt: STAMP,
      manifest: oldIndex.retrieval.manifestShows(),
    });
    expect(version.ok).toBe(false);
    expect(version.reasons).toEqual([
      `the server's index version is ${TRANSCRIPT_TEXT_INDEX_VERSION - 1}, this process reads version ${TRANSCRIPT_TEXT_INDEX_VERSION}`,
    ]);

    const stale = remoteIntegrity({
      healthz: good.health,
      pulledArchiveGeneratedAt: "2026-09-01T00:00:00.000Z",
      manifest: good.retrieval.manifestShows(),
    });
    expect(stale.ok).toBe(false);
    expect(stale.reasons[0]).toMatch(
      /generated_at 2026-10-01T00:00:00\.000Z\) is not this machine's \(2026-09-01T00:00:00\.000Z\)/,
    );
    /* A machine that never pulled a digest cannot prove the stamps match. */
    expect(
      remoteIntegrity({
        healthz: good.health,
        pulledArchiveGeneratedAt: null,
        manifest: good.retrieval.manifestShows(),
      }).ok,
    ).toBe(false);
  });

  /* MUTATION THAT KILLS THIS: drop the manifest-vs-/healthz episode
     comparison (a manifest that lost rows would pass). Ran it: red.
     MUTATION THAT KILLS THIS: treat a null /healthz as ok. Ran it: red. */
  it("a manifest short of the server's own count, an empty manifest, or no /healthz is not ok", async () => {
    const short = await loaded(HEALTHY, ROWS.slice(0, 2));
    const truncated = remoteIntegrity({
      healthz: short.health,
      pulledArchiveGeneratedAt: STAMP,
      manifest: short.retrieval.manifestShows(),
    });
    expect(truncated.ok).toBe(false);
    expect(truncated.found).toBe(2);
    expect(truncated.reasons).toContain(
      "the loaded manifest lists 2 episodes, the server says it indexed 3",
    );

    const empty = await loaded(HEALTHY, []);
    expect(
      remoteIntegrity({
        healthz: empty.health,
        pulledArchiveGeneratedAt: STAMP,
        manifest: empty.retrieval.manifestShows(),
      }).reasons,
    ).toContain("the server's episode manifest is empty or did not load");

    const good = await loaded(HEALTHY);
    const silent = remoteIntegrity({
      healthz: null,
      pulledArchiveGeneratedAt: STAMP,
      manifest: good.retrieval.manifestShows(),
    });
    expect(silent.ok).toBe(false);
    expect(silent.expected).toBeNull();
    expect(silent.reasons[0]).toMatch(/did not answer \/healthz/);
  });
});
