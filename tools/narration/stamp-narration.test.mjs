/* stamp-narration.mjs: rendered narration into data/forays.json, exactly once.
 *
 * `docs/plans/spark-central-narration-assessment.md` §3.0 (data shape), §3.4
 * (runtime restated in the same write; script_sha via billableText) and §5
 * Phase 1 (drafts only). Driven against the FROZEN fixture (a verbatim copy of
 * a real narrated draft) and a manifest shaped exactly like render-foray.py's,
 * so the check-forays gate judges a real Foray, stamped, and a publish to
 * data/ cannot break this suite.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stampForays, normalizeBase, loadProfile, readManifests, StampError } from "./stamp-narration.mjs";
import { narrationDuration } from "../../player/foray-queue.js";
import { billableText } from "../narrate/billable.mjs";
import { checkForays } from "../foray/check-forays.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "stamp-narration.mjs");
const PROFILE = loadProfile();
const BASE = "https://audio.jwlabs.ai";
/* The FROZEN fixture (tools/foray/fixtures/README.md): a verbatim copy of a
   real narrated generated draft, so the checker judges real data and no
   publish to data/ can break this suite. */
const FROZEN = path.join(ROOT, "tools", "foray", "fixtures", "frozen", "data");
const DRAFT = "what-engineers-actually-do-all-day-e08236";
const PUBLISHED = "what-engineers-published-copy";

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const fixtureFile = (name) => JSON.parse(fs.readFileSync(path.join(FROZEN, `${name}.json`), "utf8"));
/** The frozen catalogue, plus a PUBLISHED copy of the narrated draft. */
function realData() {
  const doc = fixtureFile("forays");
  const copy = structuredClone(doc.forays.find((f) => f.id === DRAFT));
  doc.forays.push({ ...copy, id: PUBLISHED, status: "published" });
  return doc;
}

/** A manifest shaped like render-foray.py's, for every narration line of `fid`. */
function fakeManifest(doc, fid, voices = PROFILE.voices, stretch = 1.1) {
  const foray = doc.forays.find((f) => f.id === fid);
  const items = [];
  for (const voice of voices) {
    for (const it of foray.items.filter((i) => i.type === "narration")) {
      const dur = Math.round((narrationDuration(it).sec * stretch + (voice === "am_echo" ? 0.25 : 0)) * 1000) / 1000;
      items.push({
        foray_id: fid, item_id: it.id, voice, status: "rendered",
        key: `n/${PROFILE.id}/${voice}/${sha(fid + it.id + voice)}.m4a`,
        bytes: 1000, duration_sec: dur, sha256: "0".repeat(64), profile: PROFILE.id,
        text_sha256: sha(it.script), lexicon_sha: "l".repeat(64), chunks: 1,
      });
    }
  }
  return { kind: "foray-narration-render", version: 1, profile: PROFILE.id, items, failed: [] };
}

test("Heart goes in the flat fields, Echo in voices, and render carries profile + billableText sha", () => {
  /* §3.0's shape: installed builds read `audio_url` unchanged, so Heart (the
     default voice) must be the flat field and `duration_source` "measured".
     MUTATION: write Echo into audio_url, or hash the raw script instead of billableText. */
  const doc = realData();
  const m = fakeManifest(doc, DRAFT);
  stampForays(doc, [{ file: "m", manifest: m }], { base: BASE, profile: PROFILE });
  const item = doc.forays.find((f) => f.id === DRAFT).items.find((i) => i.type === "narration");
  const heart = m.items.find((e) => e.item_id === item.id && e.voice === "af_heart");
  const echo = m.items.find((e) => e.item_id === item.id && e.voice === "am_echo");
  assert.equal(item.audio_url, `${BASE}/${heart.key}`);
  assert.equal(item.duration_sec, heart.duration_sec);
  assert.equal(item.duration_source, "measured");
  assert.deepEqual(item.voices, { am_echo: { audio_url: `${BASE}/${echo.key}`, duration_sec: echo.duration_sec } });
  assert.deepEqual(item.render, { profile: PROFILE.id, script_sha: sha(billableText(item.script)), lexicon_sha: "l".repeat(64) });
});

test("runtime_sec is restated by exactly the Heart durations' change, and check-forays agrees", () => {
  /* §3.4: "runtime_sec must be restated in the same PR as the durations"; the
     checker compares it with the listener's clock to 0.5 s. Echo's durations must
     NOT move it (Heart ships first). MUTATION: add Echo's delta too, or skip the restatement. */
  const doc = realData();
  const foray = doc.forays.find((f) => f.id === DRAFT);
  const before = foray.runtime_sec;
  const est = foray.items.filter((i) => i.type === "narration").reduce((a, i) => a + narrationDuration(i).sec, 0);
  const m = fakeManifest(doc, DRAFT);
  const heartSum = m.items.filter((e) => e.voice === "af_heart").reduce((a, e) => a + e.duration_sec, 0);
  stampForays(doc, [{ file: "m", manifest: m }], { base: BASE, profile: PROFILE });
  assert.ok(Math.abs(foray.runtime_sec - (before + heartSum - est)) < 0.002, `${foray.runtime_sec} vs ${before + heartSum - est}`);
  doc.forays = doc.forays.filter((f) => f.id !== PUBLISHED);
  const files = { forays: doc, segments: fixtureFile("segments"), sources: fixtureFile("segment-sources"), taxonomy: fixtureFile("taxonomy") };
  const { errors, report } = checkForays(files);
  assert.deepEqual(errors, [], errors.join("\n"));
  const r = report.forays.find((f) => f.id === DRAFT);
  assert.ok(Math.abs(r.runtime_sec - foray.runtime_sec) <= 0.5);
});

test("stamping twice is byte-identical (idempotent)", () => {
  /* MUTATION: add the delta without subtracting the prior measurement -> runtime drifts on run 2. */
  const doc = realData();
  const m = [{ file: "m", manifest: fakeManifest(doc, DRAFT) }];
  stampForays(doc, m, { base: BASE, profile: PROFILE });
  const once = JSON.stringify(doc, null, 2);
  stampForays(doc, m, { base: BASE, profile: PROFILE });
  assert.equal(JSON.stringify(doc, null, 2), once);
});

test("a script edited after its render is refused, and nothing is written", () => {
  /* Stale audio never reaches data. MUTATION: skip the text_sha256 check. */
  const doc = realData();
  const m = fakeManifest(doc, DRAFT);
  const foray = doc.forays.find((f) => f.id === DRAFT);
  const lines = foray.items.filter((i) => i.type === "narration");
  lines.at(-1).script += " Edited.";
  const snapshot = JSON.stringify(doc);
  assert.throws(() => stampForays(doc, [{ file: "m", manifest: m }], { base: BASE, profile: PROFILE }), /script changed/);
  assert.equal(JSON.stringify(doc), snapshot, "a refused stamp must not have written the lines before the stale one");
});

test("after a script edit, every voice the line carries is re-stamped together, or nothing is", () => {
  /* render.script_sha is one per line and vouches for every voice on it. A
     re-render where only Heart succeeded must not leave the OLD Echo file under
     the NEW sha. MUTATION: drop the carried-voices check. */
  const doc = realData();
  stampForays(doc, [{ file: "m", manifest: fakeManifest(doc, DRAFT) }], { base: BASE, profile: PROFILE });
  const line = doc.forays.find((f) => f.id === DRAFT).items.filter((i) => i.type === "narration").at(-1);
  line.script += " Edited after the first render.";
  const heartOnly = fakeManifest(doc, DRAFT, ["af_heart"]);
  const snapshot = JSON.stringify(doc);
  assert.throws(
    () => stampForays(doc, [{ file: "m", manifest: heartOnly }], { base: BASE, profile: PROFILE }),
    /am_echo would keep the old script's file/
  );
  assert.equal(JSON.stringify(doc), snapshot, "a refused stamp writes nothing");
  /* Both voices, re-rendered from the new script: accepted. */
  stampForays(doc, [{ file: "m", manifest: fakeManifest(doc, DRAFT) }], { base: BASE, profile: PROFILE });
  assert.equal(line.render.script_sha, sha(billableText(line.script)));
  /* An unedited line may still be re-stamped one voice at a time. */
  stampForays(doc, [{ file: "m", manifest: fakeManifest(doc, DRAFT, ["af_heart"], 1.2) }], { base: BASE, profile: PROFILE });
});

test("a PUBLISHED Foray is refused in Phase 1 unless --allow-published", () => {
  /* Assessment §1 risk 1: a failed load stops the player until the fallback
     ships. MUTATION: drop the status guard. */
  const doc = realData();
  const m = [{ file: "m", manifest: fakeManifest(doc, PUBLISHED) }];
  assert.throws(() => stampForays(doc, m, { base: BASE, profile: PROFILE }), /PUBLISHED/);
  stampForays(doc, m, { base: BASE, profile: PROFILE, allowPublished: true });
  assert.match(doc.forays.find((f) => f.id === PUBLISHED).items.find((i) => i.type === "narration").audio_url, /^https:\/\/audio\.jwlabs\.ai\/n\//);
});

test("the base must be https with no query, token or credentials", () => {
  /* A tokened URL would be published to every phone. MUTATION: accept http or ?token=. */
  assert.equal(normalizeBase("https://audio.jwlabs.ai/"), "https://audio.jwlabs.ai");
  for (const bad of ["http://audio.jwlabs.ai", "https://audio.jwlabs.ai/?token=x", "https://u:p@audio.jwlabs.ai", "", "not a url"]) {
    assert.throws(() => normalizeBase(bad), StampError, bad);
  }
});

test("a manifest from another render profile is refused", () => {
  /* MUTATION: skip the profile comparison -> old-profile keys get stamped. */
  const doc = realData();
  const m = fakeManifest(doc, DRAFT);
  m.profile = "kokoro-fp32-aac64-v0";
  assert.throws(() => stampForays(doc, [{ file: "m", manifest: m }], { base: BASE, profile: PROFILE }), /profile/);
});

test("the CLI stamps a copy of the frozen forays file, then reports it unchanged on the second run", () => {
  /* Executes the real entry point, twice, including directory manifest discovery.
     MUTATION: a module-level error, or writing when nothing changed. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
  try {
    const dataPath = path.join(tmp, "forays.json");
    fs.writeFileSync(dataPath, JSON.stringify(fixtureFile("forays"), null, 2) + "\n");
    const doc = realData();
    fs.writeFileSync(path.join(tmp, "manifest-af_heart.json"), JSON.stringify(fakeManifest(doc, DRAFT, ["af_heart"])));
    fs.writeFileSync(path.join(tmp, "manifest-am_echo.json"), JSON.stringify(fakeManifest(doc, DRAFT, ["am_echo"])));
    assert.equal(readManifests([tmp]).length, 2);
    const env = { ...process.env, NARRATION_PUBLIC_BASE: BASE };
    const run = () => spawnSync(process.execPath, [CLI, "--manifest", tmp, "--data", dataPath], { encoding: "utf8", env });
    const r1 = run();
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /data CHANGED/);
    const after1 = fs.readFileSync(dataPath, "utf8");
    const r2 = run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /data unchanged/);
    assert.equal(fs.readFileSync(dataPath, "utf8"), after1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
