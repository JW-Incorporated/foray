import * as fs from "fs";
import * as path from "path";
import type { z } from "zod";

/**
 * GV-15 (docs/roadmap/generation-v2.md, decision 5): the ONE flag-reader
 * module for generation v2. Pipeline flags (`pipelineFlags.ts`), the gate
 * table (`gateConfig.ts`) and every retrieval flag are built on these
 * readers; none of them goes into `config/env.ts`.
 *
 * TWO RULES, both from the existing env readers:
 *
 *   CALL TIME, NOT IMPORT TIME. Every reader takes the source it reads
 *   (`process.env` by default) when it is CALLED, so a test sets
 *   `process.env.X` per case after the module is imported and the next read
 *   sees it. Nothing here caches a value.
 *
 *   FAIL FAST, NAME ONLY THE VARIABLE. An unset variable gives the fallback.
 *   A variable that is PRESENT (an empty or whitespace-only string included)
 *   and malformed throws, naming the variable and never its value: the
 *   `readBoundedNumber` convention in `config/env.ts` and the shape of
 *   `narrationActConcurrency` (`writeNarration.ts`). A typo silently becoming
 *   the default is exactly the surprise an operator set the flag to avoid.
 */

export type FlagSource = Readonly<Record<string, string | undefined>>;

/** The error every reader throws. The message names the variable and what
 * shape was expected; the offending value is never part of it. */
export class FlagValueError extends Error {
  constructor(
    readonly variable: string,
    expected: string
  ) {
    super(`Invalid value for environment variable ${variable}: expected ${expected}`);
    this.name = "FlagValueError";
  }
}

/** A parser turns a present, trimmed, non-empty raw value into a typed one,
 * or returns `undefined` when the value is malformed. It never sees an unset
 * variable. `expected` is the wording the error uses. */
export interface FlagParser<T> {
  parse(raw: string): T | undefined;
  expected: string;
}

/** The generic reader the others are built on: fallback when unset, the
 * parsed value when well-formed, `FlagValueError` otherwise. */
export function readFlag<T>(name: string, parser: FlagParser<T>, fallback: T, source: FlagSource = process.env): T {
  const present = source[name];
  if (present === undefined) return fallback;
  const raw = present.trim();
  const value = raw.length === 0 ? undefined : parser.parse(raw);
  if (value === undefined) throw new FlagValueError(name, parser.expected);
  return value;
}

/** One of `values`, compared exactly (after trimming). */
export function enumParser<T extends string>(values: readonly T[]): FlagParser<T> {
  return {
    parse: (raw) => (values as readonly string[]).includes(raw) ? (raw as T) : undefined,
    expected: `one of ${values.join("|")}`
  };
}

/** A number that passes `schema` (an integer range, a bound, ...). */
export function numberParser(schema: z.ZodType<number>, expected = "a number in range"): FlagParser<number> {
  return {
    parse: (raw) => {
      const result = schema.safeParse(Number(raw));
      return result.success ? result.data : undefined;
    },
    expected
  };
}

/** `1`/`true`/`on` or `0`/`false`/`off`, case-insensitive. */
export const booleanParser: FlagParser<boolean> = {
  parse: (raw) => {
    const v = raw.toLowerCase();
    if (v === "1" || v === "true" || v === "on") return true;
    if (v === "0" || v === "false" || v === "off") return false;
    return undefined;
  },
  expected: "1|0|true|false|on|off"
};

export function readEnumFlag<T extends string>(name: string, values: readonly T[], fallback: T, source: FlagSource = process.env): T {
  return readFlag(name, enumParser(values), fallback, source);
}

export function readNumberFlag(name: string, schema: z.ZodType<number>, fallback: number, source: FlagSource = process.env): number {
  return readFlag(name, numberParser(schema), fallback, source);
}

export function readBooleanFlag(name: string, fallback: boolean, source: FlagSource = process.env): boolean {
  return readFlag(name, booleanParser, fallback, source);
}

/** GV-76 (R2-12, QK-27): judge a page against its whole clip rather than a
 * 3,000-character excerpt of it. */
export const EVIDENCE_WHOLE_CLIP_ENV = "FORAY_EVIDENCE_WHOLE_CLIP";

/** GV-76: `FORAY_EVIDENCE_WHOLE_CLIP=1` builds a page's OWN tape document
 * from the whole clip (`EVIDENCE_WHOLE_CLIP_MAX_CHARS`) and an ADJACENT
 * clip's document from its head and tail (`gatherEvidence.ts`). Default off:
 * today's 3,000-character window, byte for byte. */
export function evidenceWholeClip(source: FlagSource = process.env): boolean {
  return readBooleanFlag(EVIDENCE_WHOLE_CLIP_ENV, false, source);
}

/** The repository root (backend/src/generation -> three levels up). */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** GV-69: where the dossier researcher (FORAY_STAGE_RESEARCH=dossier) reads
 * the topic dossiers GV-30 builds. */
export const DOSSIER_DIR_ENV = "FORAY_DOSSIER_DIR";
/** The build's own output directory (tools/corpus/dossiers/build.mjs). */
export const DEFAULT_DOSSIER_DIR = path.join(REPO_ROOT, "data-local", "dossiers");

/** A directory path. A relative path is resolved against the repository
 * root, the root the default lives under, so the backend CLI (run from
 * backend/) and a tool run from the root read the same directory. */
const directoryParser: FlagParser<string> = {
  parse: (raw) => path.resolve(REPO_ROOT, raw),
  expected: "a directory path"
};

/** GV-69: the dossier directory, an absolute path. Unset gives
 * DEFAULT_DOSSIER_DIR; an empty or whitespace-only value throws naming
 * FORAY_DOSSIER_DIR. The directory is not checked here: a missing one is the
 * dossier researcher's single warning, not a configuration error. */
export function dossierDir(source: FlagSource = process.env): string {
  return readFlag(DOSSIER_DIR_ENV, directoryParser, DEFAULT_DOSSIER_DIR, source);
}

/** GV-87 (W3-13, QK-21): the per-show quota on a research-map subtopic's
 * tape windows (`researchShape.ts`). */
export const RESEARCH_SHOW_QUOTA_ENV = "FORAY_RESEARCH_SHOW_QUOTA";

/** A share of a subtopic's windows: a number in (0, 1]. */
const showQuotaParser: FlagParser<number> = {
  parse: (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
  },
  expected: "a number in (0, 1]"
};

/** GV-87: `FORAY_RESEARCH_SHOW_QUOTA=<share>` caps any one show at
 * ceil(share * 6) of a subtopic's six windows, so the spine is offered tape
 * from two or three shows when the archive has them. Unset gives `undefined`:
 * off, today's map byte for byte. 0, a negative, a value over 1 or a
 * non-number throws naming the variable. */
export function researchShowQuota(source: FlagSource = process.env): number | undefined {
  return readFlag<number | undefined>(RESEARCH_SHOW_QUOTA_ENV, showQuotaParser, undefined, source);
}

/* ---------------------------------------------------------------------------
   GV-95 (W3-11; decision 23): the retrieval server. FORAY_RETRIEVAL_URL unset
   keeps today's local path (the File cue provider and text index); set, the
   batch driver builds GV-29's RemoteRetrieval, PrecomputedTextIndex and
   HydratingCueProvider instead.
   --------------------------------------------------------------------------- */

export const RETRIEVAL_URL_ENV = "FORAY_RETRIEVAL_URL";
export const RETRIEVAL_TOKEN_ENV = "FORAY_RETRIEVAL_TOKEN";
/** The file the token is read from when FORAY_RETRIEVAL_TOKEN is unset: the
 * retrieval server's own rule (`retrievalServer.ts` `retrievalToken`). */
export const RETRIEVAL_TOKEN_FILE_ENV = "FORAY_RETRIEVAL_TOKEN_FILE";
export const RETRIEVAL_MODE_ENV = "FORAY_RETRIEVAL_MODE";
export const RETRIEVAL_MODES = ["bm25", "hybrid"] as const;
export type RetrievalModeFlag = (typeof RETRIEVAL_MODES)[number];

/**
 * Whether `hostname` (as `URL.hostname` spells it) is this machine: localhost,
 * 127.0.0.0/8 or ::1. The one place plain http may carry the bearer token,
 * because the bytes never leave the machine.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * GV-29 review follow-up (#1286, wave 5): a bearer token must not travel in
 * clear. True when `baseUrl` is plain http to a host other than this machine,
 * or does not parse at all (fail closed): a token may not be sent there.
 */
export function tokenWouldTravelInClear(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return true;
  }
  if (url.protocol === "https:") return false;
  return !(url.protocol === "http:" && isLoopbackHost(url.hostname));
}

/** An http(s) URL with a host, no query and no fragment; a trailing slash is
 * dropped. */
const retrievalUrlParser: FlagParser<string> = {
  parse: (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname.length === 0) return undefined;
    if (url.search.length > 0 || url.hash.length > 0 || url.username.length > 0 || url.password.length > 0) return undefined;
    return raw.replace(/\/+$/, "");
  },
  expected: "an http(s) URL with no query, fragment or credentials, e.g. http://127.0.0.1:7311"
};

/** GV-95: the retrieval server's base URL, or undefined (unset: the local
 * path). A malformed value throws naming FORAY_RETRIEVAL_URL. */
export function retrievalUrl(source: FlagSource = process.env): string | undefined {
  return readFlag<string | undefined>(RETRIEVAL_URL_ENV, retrievalUrlParser, undefined, source);
}

/** Any non-empty string. */
const tokenParser: FlagParser<string> = { parse: (raw) => raw, expected: "a non-empty token" };

/** GV-95: the bearer token, from FORAY_RETRIEVAL_TOKEN, else from the file
 * FORAY_RETRIEVAL_TOKEN_FILE names (trimmed), else undefined. A present but
 * empty variable, or a token file that cannot be read or is empty, throws
 * naming the variable. */
export function retrievalToken(source: FlagSource = process.env, readFile: (file: string) => string = defaultReadFile): string | undefined {
  const direct = readFlag<string | undefined>(RETRIEVAL_TOKEN_ENV, tokenParser, undefined, source);
  if (direct !== undefined) return direct;
  const file = readFlag<string | undefined>(RETRIEVAL_TOKEN_FILE_ENV, filePathParser, undefined, source);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFile(file).trim();
  } catch {
    throw new FlagValueError(RETRIEVAL_TOKEN_FILE_ENV, "a readable file holding the token");
  }
  if (text.length === 0) throw new FlagValueError(RETRIEVAL_TOKEN_FILE_ENV, "a readable file holding the token");
  return text;
}

function defaultReadFile(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-named secret file.
  return fs.readFileSync(file, "utf8");
}

/** A file path, resolved against the repository root like `directoryParser`. */
const filePathParser: FlagParser<string> = {
  parse: (raw) => path.resolve(REPO_ROOT, raw),
  expected: "a file path"
};

/** GV-95: FORAY_RETRIEVAL_MODE, bm25 (the default) or hybrid. */
export function retrievalMode(source: FlagSource = process.env): RetrievalModeFlag {
  return readEnumFlag(RETRIEVAL_MODE_ENV, RETRIEVAL_MODES, "bm25", source);
}

export interface RetrievalConfig {
  baseUrl: string;
  token: string | undefined;
  mode: RetrievalModeFlag;
}

/**
 * GV-95: the three retrieval flags together, or null when FORAY_RETRIEVAL_URL
 * is unset (today's local path, and then no token is read). Fails fast:
 *   - hybrid with no URL throws naming FORAY_RETRIEVAL_MODE (the local index
 *     is BM25 only, so the mode would silently do nothing);
 *   - a token with a plain-http URL to a non-loopback host throws naming
 *     FORAY_RETRIEVAL_URL (GV-29 review: the token would cross the network in
 *     clear). Use https, or a loopback URL (an SSH tunnel, say).
 */
export function retrievalConfig(source: FlagSource = process.env, readFile?: (file: string) => string): RetrievalConfig | null {
  const baseUrl = retrievalUrl(source);
  const mode = retrievalMode(source);
  if (baseUrl === undefined) {
    if (mode !== "bm25") throw new FlagValueError(RETRIEVAL_MODE_ENV, `bm25 when ${RETRIEVAL_URL_ENV} is unset (the local index is BM25 only)`);
    return null;
  }
  const token = retrievalToken(source, readFile);
  if (token !== undefined && tokenWouldTravelInClear(baseUrl)) {
    throw new FlagValueError(RETRIEVAL_URL_ENV, `an https URL, or http to a loopback host, when ${RETRIEVAL_TOKEN_ENV} is set (the token must not travel in clear)`);
  }
  return { baseUrl, token, mode };
}
