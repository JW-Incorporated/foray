#!/usr/bin/env node
/* tools/narration/stamp-narration.mjs — write rendered narration into data/forays.json.
 *
 * `docs/plans/spark-central-narration-assessment.md` §3.0 ("Data shape"), §3.4
 * and §5 Phase 1 step 3. Given the manifest(s) `render-foray.py` wrote and the
 * public base URL of the narration bucket (`NARRATION_PUBLIC_BASE`, i.e.
 * https://audio.jwlabs.ai, ruling D6), each rendered line gets:
 *
 *   Heart (the profile's default voice, D4 "Heart ships first"):
 *     audio_url        <base>/<key>          installed builds play this unchanged
 *     duration_sec     measured from the PCM
 *     duration_source  "measured"
 *   every other voice (Echo):
 *     voices.<voice>   { audio_url, duration_sec }
 *   always:
 *     render           { profile, script_sha, lexicon_sha }
 *       script_sha  = sha256(billableText(script)) — tools/narrate/billable.mjs,
 *                     the ONE canonicaliser (§3.4: "never a second")
 *       lexicon_sha = sha256 of hard-terms.json at render time (§3.4 "stale
 *                     renders after a lexicon edit")
 *
 * and the Foray's `runtime_sec` is RESTATED in the same write (§3.4: "runtime_sec
 * must be restated in the same PR as the durations"): the old value plus, per
 * stamped line, the Heart duration minus what `narrationDuration` said before.
 *
 * IDEMPOTENT. A second run with the same manifest changes no byte: the fields
 * already hold these values, and the runtime delta of a measured line against
 * the same measurement is zero.
 *
 * REFUSALS, each before anything is written:
 *   - a manifest from another render profile than the committed one;
 *   - a line whose script changed since it was rendered (the manifest records
 *     sha256 of the exact script it rendered): stale audio is never stamped;
 *   - a base URL that is not https, or carries a query/token;
 *   - a PUBLISHED Foray, unless --allow-published. Phase 1 renders drafts only:
 *     the player's speak-the-script fallback must ship in a build first
 *     (assessment §1 risk 1, §5 Phase 2).
 *
 * NO CREDENTIALS and no network: this edits one JSON file.
 *
 *     node tools/narration/stamp-narration.mjs --manifest out/            # every manifest*.json in out/
 *     node tools/narration/stamp-narration.mjs --manifest a.json --manifest b.json --base https://audio.jwlabs.ai
 *     node tools/narration/stamp-narration.mjs --manifest out/ --check    # report, write nothing
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { billableText } from "../narrate/billable.mjs";
import { narrationDuration } from "../../player/foray-queue.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const PROFILE_PATH = path.join(HERE, "render-profile.json");
export const MANIFEST_KIND = "foray-narration-render";
export const DURATION_MEASURED = "measured";

export class StampError extends Error {}

export const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

export function loadProfile(p = PROFILE_PATH) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The base every audio_url starts with. https, no query, no fragment, no
    trailing slash — a tokened or http URL would be written into public data. */
export function normalizeBase(base) {
  if (typeof base !== "string" || !base.trim()) throw new StampError("no public base URL (pass --base or set NARRATION_PUBLIC_BASE)");
  let u;
  try {
    u = new URL(base.trim());
  } catch {
    throw new StampError(`public base ${JSON.stringify(base)} is not a URL`);
  }
  if (u.protocol !== "https:") throw new StampError(`public base must be https, got ${u.protocol}`);
  if (u.search || u.hash || u.username || u.password) throw new StampError("public base must carry no query, fragment or credentials");
  return u.toString().replace(/\/+$/, "");
}

/** Every manifest named: a file, or a directory's `manifest*.json`. */
export function readManifests(paths) {
  const files = [];
  for (const p of paths) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (/^manifest.*\.json$/.test(f)) files.push(path.join(p, f));
    } else files.push(p);
  }
  if (!files.length) throw new StampError(`no manifest*.json found in ${paths.join(", ")}`);
  return files.map((f) => {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    if (m.kind !== MANIFEST_KIND) throw new StampError(`${f} is not a ${MANIFEST_KIND} manifest`);
    return { file: f, manifest: m };
  });
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Stamp `doc` (data/forays.json, parsed) in place from the manifests.
 * Returns `{ changed, stamped, forays: [{id, runtime_before, runtime_after}], skipped }`.
 * Throws StampError before mutating anything if any line is refused.
 */
export function stampForays(doc, manifests, { base, profile, allowPublished = false } = {}) {
  const baseUrl = normalizeBase(base);
  const defaultVoice = profile.default_voice;
  const forays = new Map((doc.forays ?? []).map((f) => [f.id, f]));

  /* PASS 1: validate everything, mutate nothing. */
  const plan = [];
  for (const { file, manifest } of manifests) {
    if (manifest.profile !== profile.id) {
      throw new StampError(`${file} was rendered with profile ${manifest.profile}, not the committed ${profile.id}`);
    }
    for (const e of manifest.items ?? []) {
      if (e.status !== "rendered" && e.status !== "unchanged") continue;
      const foray = forays.get(e.foray_id);
      if (!foray) throw new StampError(`${file}: Foray ${e.foray_id} is not in data/forays.json`);
      if (foray.status === "published" && !allowPublished) {
        throw new StampError(
          `${e.foray_id} is PUBLISHED. Phase 1 stamps drafts only: a narration file that fails to load stops the ` +
            "player until the speak-the-script fallback ships in a build (assessment §1 risk 1, §5 Phase 2). " +
            "Pass --allow-published only after that build is out."
        );
      }
      const item = (foray.items ?? []).find((i) => i.type === "narration" && i.id === e.item_id);
      if (!item) throw new StampError(`${file}: ${e.foray_id} has no narration item ${e.item_id}`);
      if (typeof item.script !== "string" || sha256(item.script) !== e.text_sha256) {
        throw new StampError(`${e.foray_id} / ${e.item_id}: the script changed since it was rendered; re-render before stamping`);
      }
      if (!(typeof e.duration_sec === "number" && Number.isFinite(e.duration_sec) && e.duration_sec > 0)) {
        throw new StampError(`${e.foray_id} / ${e.item_id} / ${e.voice}: duration_sec ${e.duration_sec} is not a positive number`);
      }
      if (typeof e.key !== "string" || !e.key.startsWith(`${profile.key_prefix}/${profile.id}/${e.voice}/`) || !/\.m4a$/.test(e.key)) {
        throw new StampError(`${e.foray_id} / ${e.item_id}: key ${e.key} is not under ${profile.key_prefix}/${profile.id}/${e.voice}/`);
      }
      if (!profile.voices.includes(e.voice)) throw new StampError(`${e.voice} is not a voice in the render profile`);
      plan.push({ foray, item, e });
    }
  }

  /* PASS 2: write. Per Foray, the runtime moves by exactly what its narration
     durations moved, measured with the player's own `narrationDuration`. */
  const before = new Map();
  const touched = new Map();
  let stamped = 0;
  for (const { foray, item, e } of plan) {
    if (!touched.has(foray.id)) touched.set(foray.id, { foray, delta: 0, runtimeBefore: foray.runtime_sec });
    if (!before.has(item)) before.set(item, narrationDuration(item).sec);
    const url = `${baseUrl}/${e.key}`;
    if (e.voice === defaultVoice) {
      item.audio_url = url;
      item.duration_sec = e.duration_sec;
      item.duration_source = DURATION_MEASURED;
    } else {
      if (!item.voices || typeof item.voices !== "object") item.voices = {};
      item.voices[e.voice] = { audio_url: url, duration_sec: e.duration_sec };
    }
    const render = { profile: profile.id, script_sha: sha256(billableText(item.script)), lexicon_sha: e.lexicon_sha ?? null };
    item.render = { ...(item.render ?? {}), ...render };
    stamped += 1;
  }
  for (const [item, sec] of before) {
    const fid = plan.find((p) => p.item === item).foray.id;
    touched.get(fid).delta += narrationDuration(item).sec - sec;
  }
  const out = [];
  for (const t of touched.values()) {
    if (typeof t.foray.runtime_sec === "number" && t.delta !== 0) t.foray.runtime_sec = round3(t.foray.runtime_sec + t.delta);
    out.push({ id: t.foray.id, runtime_before: t.runtimeBefore, runtime_after: t.foray.runtime_sec });
  }
  return { stamped, forays: out };
}

function parseArgs(argv) {
  const a = { manifests: [], base: null, data: null, check: false, allowPublished: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--manifest") a.manifests.push(argv[++i]);
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--data") a.data = argv[++i];
    else if (k === "--check") a.check = true;
    else if (k === "--allow-published") a.allowPublished = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new StampError(`unknown argument ${k}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifests.length) {
    console.log("Usage: node tools/narration/stamp-narration.mjs --manifest <file|dir> [--manifest ...] [--base URL] [--data data/forays.json] [--check] [--allow-published]");
    return args.help ? 0 : 2;
  }
  const profile = loadProfile();
  const base = args.base ?? process.env.NARRATION_PUBLIC_BASE ?? profile.public_base;
  const dataPath = path.resolve(args.data ?? path.join(REPO_ROOT, "data", "forays.json"));
  if (!fs.existsSync(dataPath)) throw new StampError(`no data file at ${dataPath}`);
  const text = fs.readFileSync(dataPath, "utf8");
  const doc = JSON.parse(text);
  const res = stampForays(doc, readManifests(args.manifests), { base, profile, allowPublished: args.allowPublished });
  const next = JSON.stringify(doc, null, 2) + "\n";
  const changed = next !== text;
  for (const f of res.forays) console.log(`${f.id}: runtime_sec ${f.runtime_before} -> ${f.runtime_after}`);
  console.log(`${res.stamped} line-voice(s) stamped from base ${normalizeBase(base)}; data ${changed ? "CHANGED" : "unchanged"}${args.check ? " (--check: not written)" : ""}`);
  if (changed && !args.check) fs.writeFileSync(dataPath, next);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`stamp-narration: ${err instanceof StampError ? err.message : err.stack}`);
      process.exit(err instanceof StampError ? 2 : 1);
    }
  );
}
