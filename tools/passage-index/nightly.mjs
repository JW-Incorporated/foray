#!/usr/bin/env node
/* The nightly retrieval chain (GV-48, from W3-09; docs/roadmap/generation-v2.md).

     node tools/passage-index/nightly.mjs [--source r2|local] [--url http://127.0.0.1:7311]
       [--db f] [--embedder stub|transformers|openai] [--passages f] [--log f]

   One run, in order, stopping at the first failure:
     1. stream-index   the delta (GV-09, W3-05/06): only shows whose objects
                       changed are re-streamed; their passages are appended to
                       --passages (default data-local/passage-index/nightly-passages.jsonl).
     2. warm           warm-transcript-index.mjs --from-staged (GV-53, W3-03):
                       digest rows for the streamed episodes.
     3. ingest         index-db.mjs ingest --passages <that file> (GV-28, W3-07).
     4. embed          index-db.mjs embed --embedder <kind>; the passages file
                       is removed only after this succeeds.
     5. reload         POST /v1/reload on the retrieval server.
     6. shortlist      POST /v1/shortlist/rebuild (every taxonomy node).

   ON AN UNCHANGED CORPUS steps 2-5 are skipped and only the shortlist is
   rebuilt: stream-index re-streams nothing, so no index, digest row, passage
   or vector is written. A passages file left by an earlier run that failed
   after stream-index counts as a change, so its passages are still ingested
   and embedded (both are idempotent per episode).

   Each step appends one JSON line to --log (default
   data-local/passage-index/nightly.log): {at, run, step, status, ms, ...};
   status is ok, skipped or failed. The last line is the run's own
   {step: "nightly"}. Query text never appears: the chain has none.

   The server URL defaults to FORAY_RETRIEVAL_URL, then 127.0.0.1:7311; the
   token comes from FORAY_RETRIEVAL_TOKEN or FORAY_RETRIEVAL_TOKEN_FILE, never
   argv. The R2 read key is stream-index's (R2_CREDENTIALS_FILE). On the
   Spark (shared, OQ-07) run it niced: `nice -n 10 node tools/passage-index/nightly.mjs`.

   Exit: 0 when every step ran or was skipped, 1 when one failed or the
   arguments are bad. */
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { isEntryScript } from "../ci/entry.mjs";
import { exitCodeFor } from "../generation/exit-code.mjs";
import { EMBEDDER_KINDS } from "./embedder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
const LOCAL_DIR = path.join(REPO_ROOT, "data-local", "passage-index");

export const DEFAULT_LOG = path.join(LOCAL_DIR, "nightly.log");
export const DEFAULT_PASSAGES = path.join(LOCAL_DIR, "nightly-passages.jsonl");
export const DEFAULT_DB = path.join(LOCAL_DIR, "passages.db");
export const DEFAULT_URL = "http://127.0.0.1:7311";
/** A shortlist rebuild over 194 nodes is minutes, not seconds. */
export const SHORTLIST_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const RELOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** The steps, in order. */
export const NIGHTLY_STEPS = Object.freeze(["stream-index", "warm", "ingest", "embed", "reload", "shortlist"]);
/** The steps an unchanged corpus skips. */
export const DELTA_STEPS = Object.freeze(["warm", "ingest", "embed", "reload"]);

const USAGE =
  "usage: nightly.mjs [--source r2|local] [--url u] [--db f] " +
  `[--embedder ${EMBEDDER_KINDS.join("|")}] [--passages f] [--log f]`;

/** Parsed argv; an unknown flag or a missing value throws. */
export function parseNightlyArgs(argv, env = process.env) {
  const out = {
    source: "r2",
    url: env.FORAY_RETRIEVAL_URL?.trim() || DEFAULT_URL,
    db: DEFAULT_DB,
    embedder: "transformers",
    passages: DEFAULT_PASSAGES,
    log: DEFAULT_LOG,
  };
  const flags = { "--source": "source", "--url": "url", "--db": "db", "--embedder": "embedder", "--passages": "passages", "--log": "log" };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown flag ${argv[i]}\n${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argv[i - 1]} needs a value`);
    out[key] = value;
  }
  if (out.source !== "r2" && out.source !== "local") throw new Error(`--source must be r2 or local, got ${out.source}`);
  if (!EMBEDDER_KINDS.includes(out.embedder)) throw new Error(`--embedder must be one of ${EMBEDDER_KINDS.join(", ")}, got ${out.embedder}`);
  for (const k of ["db", "passages", "log"]) out[k] = path.resolve(out[k]);
  return out;
}

/** True when a passages file with content is waiting to be ingested. */
export function passagesPending(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * Run the chain. `steps` maps each NIGHTLY_STEPS name to `async (ctx) =>
 * summary`: a step fails by throwing or by returning `{ok: false}`;
 * `stream-index` returns `{delta}` (shows re-streamed). Anything else a step
 * returns is logged with it.
 *
 * @returns {Promise<{ok: boolean, exitCode: number, changed: boolean, steps: object[]}>}
 */
export async function runNightly({ steps, passages = DEFAULT_PASSAGES, logFile = DEFAULT_LOG, now = () => Date.now(), runId = randomUUID(), removePassages } = {}) {
  for (const name of NIGHTLY_STEPS) if (typeof steps?.[name] !== "function") throw new Error(`nightly: no step ${name}`);
  const remove = removePassages ?? ((file) => rmSync(file, { force: true }));
  mkdirSync(path.dirname(logFile), { recursive: true });
  const write = (line) => appendFileSync(logFile, `${JSON.stringify({ at: new Date(now()).toISOString(), run: runId, ...line })}\n`, "utf8");
  const record = [];
  const started = now();
  const ctx = { passages, runId };
  let changed = false;
  let failed = null;

  for (const name of NIGHTLY_STEPS) {
    if (!changed && DELTA_STEPS.includes(name)) {
      const line = { step: name, status: "skipped", reason: "no-delta" };
      write(line);
      record.push(line);
      continue;
    }
    const t0 = now();
    let summary;
    try {
      summary = (await steps[name](ctx)) ?? {};
    } catch (err) {
      summary = { ok: false, error: String(err?.message ?? err) };
    }
    const ok = summary.ok !== false;
    const rest = { ...summary };
    delete rest.ok;
    const line = { step: name, status: ok ? "ok" : "failed", ms: now() - t0, ...rest };
    write(line);
    record.push(line);
    if (!ok) {
      failed = name;
      break;
    }
    if (name === "stream-index") {
      const pending = passagesPending(passages);
      changed = Number(summary.delta ?? 0) > 0 || pending;
      ctx.delta = Number(summary.delta ?? 0);
      ctx.pending = pending;
    }
    if (name === "embed") remove(passages);
  }

  const final = { step: "nightly", status: failed ? "failed" : "ok", ms: now() - started, changed, ...(failed ? { failedStep: failed } : {}) };
  write(final);
  return { ok: !failed, exitCode: failed ? 1 : 0, changed, steps: record };
}

/* ------------------------------------------------------------ real steps */

/** Spawn `node [nodeArgs] script args` with inherited stdio; resolves {ok, exit}. */
export function runNode(script, args, { nodeArgs = [], spawnImpl = spawn, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [...nodeArgs, script, ...args], { cwd, env: process.env, stdio: "inherit" });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("exit", (code, signal) => {
      const exit = exitCodeFor(code, signal);
      resolve({ ok: exit === 0, exit });
    });
  });
}

function tokenFrom(env) {
  const direct = env.FORAY_RETRIEVAL_TOKEN?.trim();
  if (direct) return direct;
  const file = env.FORAY_RETRIEVAL_TOKEN_FILE?.trim();
  if (!file) return null;
  const text = readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : null;
}

/** POST `route` on the retrieval server; resolves {ok, status, ...summary}. */
export async function postServer(baseUrl, route, body, { token = null, timeoutMs, fetchFn = globalThis.fetch } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchFn(`${String(baseUrl).replace(/\/+$/, "")}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `${route}: ${e?.name ?? "error"}` };
  }
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    /* A non-JSON answer: the status says enough. */
  }
  return { ok: res.ok, status: res.status, ...(res.ok ? {} : { error: json?.error ?? `HTTP ${res.status}` }), ...(json && res.ok ? { reply: json } : {}) };
}

/** The six steps over the real tools. Nothing here runs at import. */
export function realSteps(args, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const token = tokenFrom(env);
  const indexDb = path.join(HERE, "index-db.mjs");
  const sqlite = ["--experimental-sqlite"];
  return {
    "stream-index": async (ctx) => {
      const { main } = await import("./stream-index.mjs");
      const result = await main(["--source", args.source, "--passages-out", ctx.passages]);
      return { ok: result.exitCode === 0, delta: result.rebuilt.length, bodies: result.bodies, quarantined: result.quarantined.length };
    },
    warm: () => runNode(path.join(REPO_ROOT, "tools", "generation", "warm-transcript-index.mjs"), ["--from-staged"]),
    ingest: (ctx) => runNode(indexDb, ["ingest", "--passages", ctx.passages, "--db", args.db], { nodeArgs: sqlite }),
    embed: () => runNode(indexDb, ["embed", "--embedder", args.embedder, "--db", args.db], { nodeArgs: sqlite }),
    reload: async () => {
      const r = await postServer(args.url, "/v1/reload", {}, { token, timeoutMs: RELOAD_TIMEOUT_MS, fetchFn });
      return { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.reply ? { shows: r.reply.shows, episodes: r.reply.episodes } : {}) };
    },
    shortlist: async () => {
      const r = await postServer(args.url, "/v1/shortlist/rebuild", {}, { token, timeoutMs: SHORTLIST_TIMEOUT_MS, fetchFn });
      return { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.reply ? { nodes: r.reply.nodes, rows: r.reply.rows, empty: r.reply.empty?.length ?? 0 } : {}) };
    },
  };
}

async function main() {
  let args;
  try {
    args = parseNightlyArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`nightly: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await runNightly({ steps: realSteps(args), passages: args.passages, logFile: args.log });
  const last = result.steps[result.steps.length - 1];
  process.stdout.write(`nightly: ${result.ok ? "ok" : `failed at ${last?.step}`} changed=${result.changed} log=${args.log}\n`);
  process.exitCode = result.exitCode;
}

if (isEntryScript(import.meta.url)) await main();
