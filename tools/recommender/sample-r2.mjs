/* R2 transcript sampler (RV-05, docs/roadmap/recommender-v1.md D3; #1163
   item 17.3). DORMANT until the R2 read key exists.

     node tools/recommender/sample-r2.mjs --keys <file.json | gold> \
       [--per-show 3] [--dry-run] [--limit N]

   What it is for. evidence.mjs (RV-03) gives a show the `transcript` tier
   when at least one normalized body for it sits under
   data-local/transcripts/normalized/ (22 shows today, founder PC). The farm's
   bucket holds about 1 TB more. When the read key arrives, this pulls up to
   `--per-show` bodies per gold-set show into that same local layout, so those
   shows move to the transcript tier with no other code change.

   Dormant state. Credentials come from loadR2Credentials
   (tools/foraycorpus-export/r2-client.mjs: the R2_* env names, else the file
   R2_CREDENTIALS_FILE names, else ~/.foray/r2-credentials). With none, the CLI
   prints one line naming the credentials file and HUMAN-ACTIONS #138 and
   EXITS 2 (DORMANT_EXIT), before it reads a key list or touches the disk.

   Per show (keys in file order, `--limit` keeps the first N):
   1. Count the show's local bodies with listLocal (tools/passage-index/
      sources.mjs, the walk evidence.mjs and the backend make). A show that
      already has >= `--per-show` is SKIPPED without listing R2.
   2. List `transcripts/normalized/<safeKey(show_key)>/` (listPrefix; safeKey
      from tools/foraycorpus-export/config.mjs). That is the identity directory
      of show-map.mjs (the #831 forward contract); a show with no object there
      is reported in `missing_in_r2`, never an error.
   3. Pick the missing count from the listed bodies the show does not already
      hold, with a choice seeded by show_key (`rng` of tools/segments/
      rank-breadth.mjs), so a rerun picks the same episodes.
   4. getObject each (capped at MAX_OBJECT_BYTES by r2-client.mjs), check it
      the way sync-r2 does (the farm's sha256 metadata against the bytes,
      JSON.parse, bodyShapeError), and write the exact bytes atomically
      (temp + rename) to <transcripts dir>/<show dir>/<object name>. The show
      dir is the one listLocal already uses for the show, else
      localDirFor(show_key) (= safeKey, what fetch-transcripts.mjs writes), so
      listLocal lists the new files under the same show_id. A body that fails
      a check is reported in `rejected` and not written.
   `--dry-run` lists R2 and reports `planned`; it never GETs and never writes.

   Prints { shows, fetched, skipped, missing_in_r2, bytes, rejected, planned }
   as JSON. Exit 0 on any outcome but a missing key (2) or a usage error (1).

   Hard rules of the package: no model call; offline tests (a fake S3 client
   with fake command classes, as r2-client.test.mjs does); this tool reads
   nothing on a live app path and nothing on a live app path reads it. R2 is
   the project's own bucket, not a feed host, so politeness.mjs (feed hosts)
   does not apply; sync-r2.mjs does not use it either. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";

import { isEntryScript } from "../ci/entry.mjs";
import { NORMALIZED_PREFIX, ROOT, safeKey } from "../foraycorpus-export/config.mjs";
import { createR2Client, defaultCredentialsFile, getObject, listPrefix, loadR2Credentials, R2Error, sha256 } from "../foraycorpus-export/r2-client.mjs";
import { localDirFor } from "../foraycorpus-export/show-map.mjs";
import { bodyShapeError, parseBodyKey } from "../foraycorpus-export/sync-r2.mjs";
import { listLocal } from "../passage-index/sources.mjs";
import { rng } from "../segments/rank-breadth.mjs";

export const DEFAULT_PER_SHOW = 3;
export const DORMANT_EXIT = 2;
export const USAGE_EXIT = 1;

/** Path settings: env override (resolved against cwd, evidence.mjs's idiom), else ROOT-relative. */
export const PATHS = Object.freeze({
  transcriptsDir: ["RECOMMENDER_TRANSCRIPTS_DIR", "data-local/transcripts/normalized"],
  goldSet: ["RECOMMENDER_GOLD_SET_PATH", "data/recommender/gold-set.json"],
});

export function pathOf(name, env = process.env) {
  const [envName, rel] = PATHS[name];
  const v = env[envName];
  return typeof v === "string" && v.trim() !== "" ? resolvePath(v) : join(ROOT, rel);
}

const USAGE = "usage: node tools/recommender/sample-r2.mjs --keys <file.json|gold> [--per-show 3] [--dry-run] [--limit N]";

export class UsageError extends Error {}

/** argv (without node and the script) -> {keys, perShow, dryRun, limit}. */
export function parseArgs(argv) {
  const out = { keys: null, perShow: DEFAULT_PER_SHOW, dryRun: false, limit: null };
  const positiveInt = (flag, v) => {
    if (!/^[1-9]\d*$/.test(String(v ?? ""))) throw new UsageError(`${flag} needs a positive integer, got ${v ?? "nothing"}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--keys") {
      out.keys = argv[i + 1];
      i += 1;
      if (!out.keys || out.keys.startsWith("--")) throw new UsageError("--keys needs a file or `gold`");
    } else if (a === "--per-show") out.perShow = positiveInt(a, argv[(i += 1)]);
    else if (a === "--limit") out.limit = positiveInt(a, argv[(i += 1)]);
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (!out.keys) throw new UsageError("--keys is required");
  return out;
}

/** The show keys of a key-list document: an array of keys or {show_key} rows, or {shows|keys: [...]}
    (the gold-set.json shape of RV-07 is {shows: [{show_key, ...}]}). Order kept, duplicates dropped. */
export function keysOf(doc) {
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.shows) ? doc.shows : Array.isArray(doc?.keys) ? doc.keys : null;
  if (!rows) throw new UsageError("a key list is an array, or an object with `shows` or `keys`");
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const k = typeof row === "string" || typeof row === "number" ? String(row) : row?.show_key ?? row?.show_id;
    if (typeof k !== "string" && typeof k !== "number") continue;
    const key = String(k).trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** `--keys gold` reads the gold set; anything else is a JSON file path. */
export function readKeys(spec, { env = process.env, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const path = spec === "gold" ? pathOf("goldSet", env) : resolvePath(spec);
  let text;
  try {
    text = readFile(path);
  } catch (e) {
    throw new UsageError(`cannot read the key list ${path}: ${e?.code ?? e?.message}`);
  }
  return keysOf(JSON.parse(text));
}

/** The R2 listing prefix of a show: its identity directory (show-map.mjs). */
export function r2PrefixFor(showKey) {
  return `${NORMALIZED_PREFIX}/${safeKey(showKey)}/`;
}

/** `n` of `names`, chosen by a generator seeded with `seed` (partial Fisher-Yates over the sorted
    names, so the listing order does not matter). Returned in sorted order. */
export function pickObjects(names, n, seed) {
  const pool = [...new Set(names)].sort();
  const next = rng(String(seed));
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take).sort();
}

const unsafeName = (s) => s === "" || s === "." || s === ".." || /[\\/]/.test(s);

/** Writes `bytes` to `path` via a temp file and a rename. */
function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** One fetched object checked the way sync-r2 checks it: null when good, else a reason code. */
export function rejectReason(got) {
  if (got.sha256Meta && sha256(got.body) !== String(got.sha256Meta).toLowerCase()) return "SHA_MISMATCH";
  let body;
  try {
    body = JSON.parse(got.body.toString("utf8"));
  } catch {
    return "BAD_JSON";
  }
  const bad = bodyShapeError(body);
  return bad ? `BAD_SHAPE:${bad}` : null;
}

/**
 * The sampling run. `client`/`bucket`/`commands` reach R2 through r2-client.mjs (tests pass a fake
 * client and fake command classes); `normalizedRoot` is the local transcripts root.
 */
export async function sampleShows({ keys, perShow = DEFAULT_PER_SHOW, dryRun = false, limit = null, client, bucket, commands = {}, normalizedRoot }) {
  const selected = limit ? keys.slice(0, limit) : keys;
  const local = listLocal(normalizedRoot).shows;
  const summary = { shows: selected.length, fetched: 0, skipped: 0, missing_in_r2: [], bytes: 0, rejected: [], planned: [] };
  const base = resolvePath(normalizedRoot);

  for (const key of selected) {
    const have = local.get(key) ?? [];
    if (have.length >= perShow) {
      summary.skipped += 1;
      continue;
    }
    const listed = [];
    for await (const obj of listPrefix(client, bucket, r2PrefixFor(key), { ListObjectsV2Command: commands.ListObjectsV2Command })) {
      const parsed = parseBodyKey(obj.key);
      if (!parsed || !obj.key.startsWith(r2PrefixFor(key)) || unsafeName(parsed.file)) continue;
      listed.push(parsed.file);
    }
    if (listed.length === 0) {
      summary.missing_in_r2.push(key);
      continue;
    }
    const held = new Set(have.map((e) => e.fileName));
    const picks = pickObjects(
      listed.filter((f) => !held.has(f)),
      perShow - have.length,
      key,
    );
    const dir = have[0]?.dir ?? localDirFor(key);
    for (const file of picks) {
      const r2Key = `${r2PrefixFor(key)}${file}`;
      if (dryRun) {
        summary.planned.push(r2Key);
        continue;
      }
      let got;
      try {
        got = await getObject(client, bucket, r2Key, { GetObjectCommand: commands.GetObjectCommand });
      } catch (e) {
        summary.rejected.push({ key: r2Key, reason: e instanceof R2Error ? e.code : `GET_FAILED:${e?.name ?? "Error"}` });
        continue;
      }
      const reason = rejectReason(got);
      if (reason) {
        summary.rejected.push({ key: r2Key, reason });
        continue;
      }
      const path = resolvePath(base, dir, file);
      if (!path.startsWith(base + sep)) {
        summary.rejected.push({ key: r2Key, reason: "PATH_ESCAPE" });
        continue;
      }
      writeAtomic(path, got.body);
      summary.fetched += 1;
      summary.bytes += got.body.length;
    }
  }
  return summary;
}

/** The dormant line: names the credentials file and the human action that creates it. */
export function dormantMessage(env, homedir) {
  const file = typeof env.R2_CREDENTIALS_FILE === "string" && env.R2_CREDENTIALS_FILE.trim() !== "" ? env.R2_CREDENTIALS_FILE : defaultCredentialsFile(homedir);
  return `sample-r2: dormant, no R2 read key (#1163 item 17.3): save it in ${file} (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET; HUMAN-ACTIONS #138) or set R2_CREDENTIALS_FILE; nothing was fetched or written`;
}

/**
 * The CLI. Every outside effect is injectable: `loadCredentials` (loadR2Credentials's options are
 * forwarded), `makeClient`, `commands`. Returns the exit code.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    homedir,
    readCredentialsFile,
    loadCredentials = loadR2Credentials,
    makeClient = createR2Client,
    commands = {},
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
  } = deps;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(`sample-r2: ${e.message}\n${USAGE}\n`);
    return USAGE_EXIT;
  }

  let creds;
  try {
    const opts = { env };
    if (homedir) opts.homedir = homedir;
    if (readCredentialsFile) opts.readFile = readCredentialsFile;
    creds = await loadCredentials(opts);
  } catch (e) {
    if (e instanceof R2Error && e.code === "NO_CREDENTIALS") {
      stderr(`${dormantMessage(env, homedir)}\n`);
      return DORMANT_EXIT;
    }
    throw e;
  }

  let keys;
  try {
    keys = readKeys(args.keys, { env });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(`sample-r2: ${e.message}\n`);
    return USAGE_EXIT;
  }

  const client = await makeClient(creds);
  const summary = await sampleShows({
    keys,
    perShow: args.perShow,
    dryRun: args.dryRun,
    limit: args.limit,
    client,
    bucket: creds.bucket,
    commands,
    normalizedRoot: pathOf("transcriptsDir", env),
  });
  stdout(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`sample-r2: ${e?.stack ?? e}\n`);
      process.exitCode = 1;
    },
  );
}
