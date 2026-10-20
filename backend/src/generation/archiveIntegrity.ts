import * as fs from "fs";
import * as path from "path";
import type { ManifestShow, RetrievalHealth } from "./retrievalClient";
import type { CorpusShowOnDisk } from "./transcriptCorpus";
import { TRANSCRIPT_TEXT_INDEX_VERSION } from "./transcriptTextIndex";

/**
 * RUN-START CORPUS INTEGRITY GUARD (GV-101, roadmap PKG-23; covers GP-09).
 *
 * #703's failure was a run that sourced against PART of its archive and looked
 * healthy. `corpusCoverage` (transcriptCorpus.ts) counts what a run can see of
 * the corpus it HAS; it cannot say the corpus itself is short, because it has
 * no denominator from outside the disk. Two outside denominators exist:
 *
 *   LOCAL. `tools/foraycorpus-export/sync-r2.mjs` (PKG-13) writes
 *   `data-local/transcripts/r2-sync-state.json` after a mirror of R2, with
 *   `shows{<localDir>: {bodies}}` and `bodies_expected` (their sum). A disk that
 *   holds fewer bodies than that was truncated or partly deleted after the sync.
 *
 *   REMOTE (FORAY_RETRIEVAL_URL set, GV-95). The retrieval server's `/healthz`
 *   says which index format it serves, which corpus digest it loaded and how
 *   many episodes it indexed; the manifest this process loaded through the same
 *   `RemoteRetrieval` (`manifestShows()`) says what it actually received. A
 *   format or archive stamp that differs from this machine's, or a manifest
 *   short of the server's own count, means answers would be mapped onto the
 *   wrong rows or drawn from part of the corpus.
 *
 * READ-ONLY. Nothing here writes, so the persistence rule holds; the CLI decides
 * what a failed check does (exit 2 unless `--allow-short-archive`).
 */

/** Where sync-r2.mjs writes its state, relative to the repo root. */
export const SYNC_STATE_RELATIVE_PATH = path.join(
  "data-local",
  "transcripts",
  "r2-sync-state.json",
);

/** The fields of sync-r2's state file this guard reads. */
export interface SyncState {
  /** Sum of `shows[*].bodies`: the normalized bodies on disk after the sync. */
  bodies_expected: number;
  /** Keyed by the show's directory under `normalized/` (sync-r2's `localDir`). */
  shows: Record<string, { show_id?: string | null; bodies: number }>;
  synced_at?: string | null;
}

/** A state file that exists and cannot be trusted. Thrown, never read as
 * "no state": an unreadable file would otherwise switch the guard off. */
export class SyncStateError extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(`sync state ${file} is unreadable: ${reason}`);
    this.name = "SyncStateError";
  }
}

/**
 * The sync state under `root` (the repo root), or null when there is none (a
 * machine that never ran sync-r2.mjs: nothing to check against). Throws
 * `SyncStateError` when the file exists and is not valid JSON of the expected
 * shape.
 */
export function readSyncState(root: string): SyncState | null {
  const file = path.join(root, SYNC_STATE_RELATIVE_PATH);
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path under the caller's repo root, read only.
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SyncStateError(file, (err as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SyncStateError(file, `not JSON (${(err as Error).message})`);
  }
  const o = parsed as Record<string, unknown> | null;
  if (o === null || typeof o !== "object" || Array.isArray(o))
    throw new SyncStateError(file, "not an object");
  const expected = o.bodies_expected;
  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected < 0
  ) {
    throw new SyncStateError(
      file,
      "bodies_expected is not a non-negative integer",
    );
  }
  const rawShows = o.shows;
  if (
    rawShows === null ||
    typeof rawShows !== "object" ||
    Array.isArray(rawShows)
  )
    throw new SyncStateError(file, "shows is not an object");
  const shows: SyncState["shows"] = {};
  for (const [dir, value] of Object.entries(
    rawShows as Record<string, unknown>,
  )) {
    const bodies = (value as { bodies?: unknown } | null)?.bodies;
    if (typeof bodies !== "number" || !Number.isInteger(bodies) || bodies < 0) {
      throw new SyncStateError(
        file,
        `shows["${dir}"].bodies is not a non-negative integer`,
      );
    }
    const showId = (value as { show_id?: unknown }).show_id;
    shows[dir] = {
      show_id: typeof showId === "string" ? showId : null,
      bodies,
    };
  }
  return {
    bodies_expected: expected,
    shows,
    synced_at: typeof o.synced_at === "string" ? o.synced_at : null,
  };
}

/** One show directory holding fewer bodies than the sync left in it. */
export interface ShortShow {
  show: string;
  expected: number;
  found: number;
}

export interface ArchiveIntegrity {
  /** True when there is no state, or `found >= expected`. */
  ok: boolean;
  /** `state.bodies_expected`, or null when there is no state. */
  expected: number | null;
  /** Bodies on disk summed over the state's show directories that are present. */
  found: number;
  /** State directories (with bodies > 0) absent from disk, sorted. */
  missingShows: string[];
  /** State directories on disk with fewer bodies than the state records, sorted. */
  shortShows: ShortShow[];
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The local check: the disk (`scanNormalizedCorpus`'s result, i.e. the shows
 * `corpusCoverage` counted) against the sync state. Counts BODIES, never
 * directories: a show directory that lost half its files still exists.
 */
export function archiveIntegrity(options: {
  state: SyncState | null;
  shows: readonly CorpusShowOnDisk[];
}): ArchiveIntegrity {
  const { state, shows } = options;
  if (state === null)
    return {
      ok: true,
      expected: null,
      found: 0,
      missingShows: [],
      shortShows: [],
    };
  const onDisk = new Map<string, number>();
  for (const show of shows) onDisk.set(show.dirName, show.episodes);
  let found = 0;
  const missingShows: string[] = [];
  const shortShows: ShortShow[] = [];
  for (const [dir, { bodies }] of Object.entries(state.shows)) {
    const have = onDisk.get(dir);
    if (have === undefined) {
      /* scanNormalizedCorpus skips an empty directory, so a show the sync
         left with 0 bodies is not missing. */
      if (bodies > 0) missingShows.push(dir);
      continue;
    }
    found += have;
    if (have < bodies)
      shortShows.push({ show: dir, expected: bodies, found: have });
  }
  missingShows.sort(byName);
  shortShows.sort((a, b) => byName(a.show, b.show));
  return {
    ok: found >= state.bodies_expected,
    expected: state.bodies_expected,
    found,
    missingShows,
    shortShows,
  };
}

export interface RemoteIntegrity {
  /** True when every reason below is absent. */
  ok: boolean;
  /** The episodes the server says it indexed (`/healthz`), or null. */
  expected: number | null;
  /** The episodes in the manifest this process loaded. */
  found: number;
  /** Why the check failed, one sentence each; empty when ok. */
  reasons: string[];
}

/**
 * The remote check, over what `openRemoteRetrieval` already fetched through
 * the one `RemoteRetrieval` (no second client): `/healthz`, the loaded
 * manifest (`manifestShows()`), and the `generated_at` of the corpus digest
 * this machine pulled (tools/passage-index/pull-archive.mjs).
 */
export function remoteIntegrity(options: {
  healthz: RetrievalHealth | null;
  pulledArchiveGeneratedAt: string | null;
  manifest: readonly ManifestShow[];
  /** The index format this process reads; TRANSCRIPT_TEXT_INDEX_VERSION by default. */
  indexVersion?: number;
}): RemoteIntegrity {
  const { healthz, pulledArchiveGeneratedAt, manifest } = options;
  const indexVersion = options.indexVersion ?? TRANSCRIPT_TEXT_INDEX_VERSION;
  const found = manifest.reduce((n, s) => n + s.episodes, 0);
  const reasons: string[] = [];
  if (healthz === null) {
    reasons.push(
      "the server did not answer /healthz, so its index version and archive stamp cannot be checked",
    );
  } else {
    if (healthz.indexVersion !== indexVersion) {
      reasons.push(
        `the server's index version is ${healthz.indexVersion ?? "unknown"}, this process reads version ${indexVersion}`,
      );
    }
    if (
      healthz.archiveGeneratedAt === null ||
      pulledArchiveGeneratedAt === null ||
      healthz.archiveGeneratedAt !== pulledArchiveGeneratedAt
    ) {
      reasons.push(
        `the server's corpus digest (generated_at ${healthz.archiveGeneratedAt ?? "none"}) is not this machine's ` +
          `(${pulledArchiveGeneratedAt ?? "none"}); run tools/passage-index/pull-archive.mjs`,
      );
    }
    if (healthz.episodes !== null && found < healthz.episodes) {
      reasons.push(
        `the loaded manifest lists ${found} episodes, the server says it indexed ${healthz.episodes}`,
      );
    }
    if (healthz.shows !== null && manifest.length < healthz.shows) {
      reasons.push(
        `the loaded manifest lists ${manifest.length} shows, the server says it holds ${healthz.shows}`,
      );
    }
  }
  if (manifest.length === 0)
    reasons.push("the server's episode manifest is empty or did not load");
  return {
    ok: reasons.length === 0,
    expected: healthz?.episodes ?? null,
    found,
    reasons,
  };
}

/** What the CLI checked at run start. */
export type IntegrityVerdict =
  | ({ kind: "local" } & ArchiveIntegrity)
  | ({ kind: "remote" } & RemoteIntegrity)
  | { kind: "unreadable-state"; ok: false; message: string };

/**
 * What a run does with a verdict: the lines to print and whether to refuse
 * (exit 2). `--allow-short-archive` prints the same shortfall and goes on. A
 * local run with no sync state prints nothing.
 */
export function integrityGate(
  verdict: IntegrityVerdict,
  allowShortArchive: boolean,
): { refuse: boolean; lines: string[] } {
  const lines: string[] = [];
  if (verdict.kind === "local") {
    if (verdict.expected === null) return { refuse: false, lines };
    if (verdict.ok) {
      lines.push(
        `archive integrity: ${verdict.found} of ${verdict.expected} synced bodies on disk`,
      );
      return { refuse: false, lines };
    }
    lines.push(
      `ARCHIVE SHORT: ${verdict.found} of ${verdict.expected} synced bodies on disk (${SYNC_STATE_RELATIVE_PATH})`,
    );
    if (verdict.missingShows.length)
      lines.push(`  missing shows: ${verdict.missingShows.join(", ")}`);
    for (const s of verdict.shortShows)
      lines.push(`  short show: ${s.show} (${s.found} of ${s.expected})`);
    lines.push(
      "  re-run tools/foraycorpus-export/sync-r2.mjs to restore the archive",
    );
  } else if (verdict.kind === "remote") {
    if (verdict.ok) {
      lines.push(
        `archive integrity: the retrieval server's manifest lists ${verdict.found} episodes (server indexed ${verdict.expected ?? "unknown"})`,
      );
      return { refuse: false, lines };
    }
    lines.push("REMOTE ARCHIVE MISMATCH:");
    for (const r of verdict.reasons) lines.push(`  ${r}`);
  } else {
    lines.push(`ARCHIVE STATE UNREADABLE: ${verdict.message}`);
  }
  lines.push(
    allowShortArchive
      ? "  --allow-short-archive: sourcing against this corpus anyway"
      : "  refusing to source against a short or stale corpus (exit 2); pass --allow-short-archive to run anyway",
  );
  return { refuse: !allowShortArchive, lines };
}
