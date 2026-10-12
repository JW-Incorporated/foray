#!/usr/bin/env node
/* Pull the retrieval server's archive onto a generation box (GV-16, from
   W3-08; docs/roadmap/generation-v2.md).

     node tools/passage-index/pull-archive.mjs --url http://<server>:7311 [--out f] [--timeout-ms n]

   GETs /v1/archive from the retrieval server (backend/src/cli/retrievalServer.ts)
   and writes data-local/transcripts/corpus-digest.json ATOMICALLY (tmp file +
   rename), so every backend reader on this box (topic supply, sourcing,
   findDigestForItem, deriveItemId / disambiguateItemIds) sees the server's
   rows, not the ones this box's own reconcile last wrote.

   The file is REPLACED whole: it is the description of the corpus the
   server holds. loadTranscriptArchive still reads the committed digests
   first and keeps the first row per (show_id, guid), so the committed rows
   the server also sends are dropped there and the server's local rows land
   after them, in the server's order. With the same committed digests on both
   boxes, that is the server's archive row for row, and disambiguateItemIds
   derives the same item ids. item_id_suffix is runtime-only (never read from a
   file, per TranscriptDigestEntry), so it is stripped before writing.

   Validation before anything is written: an HTTP error, a body that is not
   {transcripts: [...]}, a row without a string show_id and guid, or an empty
   archive (unless --allow-empty) leaves the existing file untouched.

   The bearer token comes from FORAY_RETRIEVAL_TOKEN or the file named by
   FORAY_RETRIEVAL_TOKEN_FILE, never from argv. --url defaults to
   FORAY_RETRIEVAL_URL. Exit: 0 written, 1 refused or failed. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { writeTextAtomic } from "./manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_OUT = join(REPO_ROOT, "data-local", "transcripts", "corpus-digest.json");
export const DEFAULT_TIMEOUT_MS = 60_000;

export class PullArchiveError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function tokenFrom(env) {
  const direct = env.FORAY_RETRIEVAL_TOKEN?.trim();
  if (direct) return direct;
  const file = env.FORAY_RETRIEVAL_TOKEN_FILE?.trim();
  if (!file) return null;
  const text = readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : null;
}

/** @returns {{url: string, out: string, token: string|null, timeoutMs: number, allowEmpty: boolean}} */
export function parsePullArgs(argv, env = process.env) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? String(argv[i + 1]) : null;
  };
  const url = value("--url") ?? env.FORAY_RETRIEVAL_URL ?? null;
  if (!url) throw new PullArchiveError("USAGE", "--url (or FORAY_RETRIEVAL_URL) is required");
  const timeoutText = value("--timeout-ms");
  const timeoutMs = timeoutText === null ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PullArchiveError("USAGE", "--timeout-ms must be a positive number");
  return {
    url,
    out: resolve(value("--out") ?? DEFAULT_OUT),
    token: tokenFrom(env),
    timeoutMs,
    allowEmpty: argv.includes("--allow-empty"),
  };
}

/** The archive endpoint for a server base URL. */
export function archiveUrl(base) {
  return `${String(base).replace(/\/+$/, "")}/v1/archive`;
}

/** A URL safe to record: no credentials, no query. */
function recordableUrl(base) {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The corpus-digest document for a /v1/archive payload. Throws
 * PullArchiveError('BAD_ARCHIVE' | 'EMPTY_ARCHIVE') on a payload it will not
 * write.
 */
export function digestFromArchive(payload, { source = null, now = () => new Date(), allowEmpty = false } = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.transcripts)) {
    throw new PullArchiveError("BAD_ARCHIVE", "the server's answer has no transcripts array");
  }
  const transcripts = [];
  payload.transcripts.forEach((row, i) => {
    if (!row || typeof row !== "object" || typeof row.show_id !== "string" || row.show_id.length === 0 || typeof row.guid !== "string" || row.guid.length === 0) {
      throw new PullArchiveError("BAD_ARCHIVE", `row ${i} has no string show_id and guid`);
    }
    // item_id_suffix is derived at load time by disambiguateItemIds, never read from a file.
    const { item_id_suffix: _runtimeOnly, ...rest } = row;
    transcripts.push(rest);
  });
  if (transcripts.length === 0 && !allowEmpty) {
    throw new PullArchiveError("EMPTY_ARCHIVE", "the server's archive is empty; refusing to replace this box's digest (--allow-empty overrides)");
  }
  return {
    version: 1,
    generated_at: now().toISOString(),
    policy:
      "machine-local: pulled from the retrieval server's archive (tools/passage-index/pull-archive.mjs, GV-16). Never committed; replaced whole on the next pull.",
    pulled_from: {
      url: source,
      archive_generated_at: typeof payload.generated_at === "string" ? payload.generated_at : null,
    },
    summary: { transcripts: transcripts.length },
    transcripts,
  };
}

/**
 * GET the archive and write the digest. Nothing is written unless the whole
 * answer validates.
 * @returns {Promise<{out: string, rows: number, bytes: number}>}
 */
export async function pullArchive({ url, out = DEFAULT_OUT, token = null, timeoutMs = DEFAULT_TIMEOUT_MS, allowEmpty = false, fetchFn = globalThis.fetch, now } = {}) {
  const headers = { accept: "application/json", "accept-encoding": "gzip" };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchFn(archiveUrl(url), { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PullArchiveError("UNREACHABLE", `${archiveUrl(url)}: ${e?.name ?? "error"}`);
  }
  if (!response.ok) throw new PullArchiveError(`HTTP_${response.status}`, `${archiveUrl(url)} answered ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new PullArchiveError("BAD_ARCHIVE", "the server's answer is not JSON");
  }
  const digest = digestFromArchive(payload, { source: recordableUrl(url), now, allowEmpty });
  const text = JSON.stringify(digest);
  writeTextAtomic(out, text);
  return { out, rows: digest.transcripts.length, bytes: Buffer.byteLength(text) };
}

async function main() {
  let args;
  try {
    args = parsePullArgs(process.argv.slice(2));
    const result = await pullArchive(args);
    console.log(`[pull-archive] wrote ${result.rows} rows (${(result.bytes / 1048576).toFixed(1)} MB) to ${result.out}`);
  } catch (e) {
    console.error(`[pull-archive] ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}

if (isEntryScript(import.meta.url)) await main();
