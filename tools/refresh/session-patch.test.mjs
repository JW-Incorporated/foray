/* Tests for the session.json text patches (audit round 3, data-tools-11).
   Run: node --test tools/refresh/

   Two defects, one per test group:
   1. backfill-audio and classify-dai wrote data/discover.json (and the DAI
      cache) BEFORE patching and verifying session.json, so a verification
      throw left the client's two documents disagreeing.
   2. Values were inserted with `txt.replace(re, `$1${fields}`)`, so `$&`,
      `$'` or `$1` inside an audio URL was read as a replacement pattern. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchAudioFields, patchDaiFlags, prepareSessionPatch } from "./session-patch.mjs";

const session = (blocks) =>
  `{\n  "builder": "hand-architect-v1",\n  "episodes": {\n${blocks.join(",\n")}\n  }\n}\n`;
const block = (id, extra = "") => `    "${id}": { "title": "T ${id}", "duration_min": 42${extra} }`;

/* MUTATION: go back to `txt.replace(re, `$1${fields}`)` -- the URL's `$&`
   expands to the whole matched block and the text no longer parses (or the
   URL comes back wrong). */
test("an audio URL carrying $ replacement patterns is inserted literally", () => {
  const url = "https://track.example.com/p/$&/x$1y/$'/ep.mp3?a=$$";
  const original = session([block("a"), block("b")]);
  const { txt } = patchAudioFields(original, { a: { audio_url: url, duration_sec: 2520 } });
  const parsed = JSON.parse(txt);
  assert.equal(parsed.episodes.a.audio_url, url);
  assert.equal(parsed.episodes.a.duration_sec, 2520);
  assert.equal(parsed.episodes.b.audio_url, undefined, "the other block is untouched");
  // Every byte outside the patched block is preserved.
  assert.ok(txt.includes(block("b")));
});

test("the DAI flag is updated in place, inserted when absent, and literal", () => {
  const original = session([
    block("a", `, "audio_bytes": 10, "dai_suspected": false`),
    block("b", `, "audio_bytes": null`),
  ]);
  const { txt, patched } = patchDaiFlags(original, { a: { dai_suspected: true }, b: { dai_suspected: false } });
  const parsed = JSON.parse(txt);
  assert.equal(patched, 2);
  assert.equal(parsed.episodes.a.dai_suspected, true);
  assert.equal(parsed.episodes.b.dai_suspected, false);
});

test("prepareSessionPatch returns verified text, and throws on a mismatch instead of returning it", () => {
  const original = session([block("a"), block("b")]);
  const ok = prepareSessionPatch(original, {
    a: { audio_url: "https://cdn.example.com/a.mp3", duration_sec: 60 },
    b: {},
  }, { kind: "audio" });
  assert.equal(JSON.parse(ok.txt).episodes.a.audio_url, "https://cdn.example.com/a.mp3");

  /* The --force case the finding describes: the block already carries an
     audio_url, the in-memory episode has a NEW one, and the idempotent patch
     leaves the old value in the text. That must throw here, before any file
     is written, rather than after discover.json was. */
  const stale = session([block("a", `, "audio_url": "https://old.example.com/a.mp3"`)]);
  assert.throws(
    () => prepareSessionPatch(stale, { a: { audio_url: "https://new.example.com/a.mp3" } }, { kind: "audio" }),
    /session patch mismatch on a/,
  );
  assert.throws(() => prepareSessionPatch(original, { zzz: { audio_url: "x" } }, { kind: "audio" }), /lost episode zzz/);
});

/* The ordering itself. Both scripts are top-level CLIs that fetch the network,
   so the order is pinned on their source: inside the non-dry branch the
   session patch is prepared (and so verified) before the first write.
   MUTATION: move `writeFileSync(join(ROOT, "data", "discover.json") ...` back
   above the prepareSessionPatch call in either script. */
test("backfill-audio and classify-dai verify the session patch before writing any file", () => {
  for (const f of ["backfill-audio.mjs", "classify-dai.mjs"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("if (DRY) {"));
    const prepared = branch.indexOf("prepareSessionPatch(");
    const firstWrite = branch.indexOf("writeFileSync(");
    assert.ok(prepared > 0, `${f} no longer prepares the session patch through session-patch.mjs`);
    assert.ok(firstWrite > 0, `${f} writes nothing?`);
    assert.ok(prepared < firstWrite, `${f} writes a file before the session patch is verified`);
    assert.doesNotMatch(src, /\.replace\([^)]*`\$1/, `${f} inserts with a $1 replacement string`);
  }
});
