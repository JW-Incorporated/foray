/* player/engine-contract.js — the part NE-10j declares: OWNED_PREFIXES, the
   shared rows the native engine owns on iOS (docs/native-engine-plan.md §4.6).

   What goes wrong if this list is wrong is quiet on both sides. A prefix that
   misses a row the engine writes lets a stale page push its old copy over the
   engine's (the clobber NE-23's deferral exists to stop). A prefix that catches
   a row the engine does NOT write defers it on the iOS shell with nobody left
   writing it: the listener's thumbs, queue or history silently stop saving.
   So both directions are pinned against real code, not against a retyped list.

   NE-11j builds the rest of this module out and extends this suite. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_PREFIXES } from "./engine-contract.js";
import { positionKey } from "./position-store.js";
import { KEY_PREFIX as FORAY_PREFIX, progressKey } from "./foray-progress.js";
import { KEY as LAST_EPISODE_KEY } from "./episode-progress.js";
import { loadFixtures } from "./parity/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test("OWNED_PREFIXES is the three shared rows' namespaces, frozen", () => {
  // MUTATION: drop the colon from "cp_foray:" -> the scan below goes red;
  // push a fourth prefix at runtime -> this throws instead of deferring it.
  assert.ok(Object.isFrozen(OWNED_PREFIXES), "a caller must not be able to widen what the engine owns");
  assert.equal(OWNED_PREFIXES.length, 3);
  // Each prefix is the namespace a real writer uses, read from that writer.
  assert.ok(positionKey("ep-1").startsWith(OWNED_PREFIXES[0]), "cp_pos:<id> (position-store.js)");
  assert.equal(OWNED_PREFIXES[0], positionKey(""));
  assert.equal(OWNED_PREFIXES[1], FORAY_PREFIX, "cp_foray:<id> (foray-progress.js)");
  assert.ok(progressKey("f-1").startsWith(OWNED_PREFIXES[1]));
  assert.equal(OWNED_PREFIXES[2], LAST_EPISODE_KEY, "cp_last_episode (episode-progress.js)");
});

test("every row the rows family records is owned, and every owned prefix has a recorded row", () => {
  // The rows family is what the Swift EngineStore must write byte for byte
  // (NE-10s, NE-19). A recorded row outside OWNED_PREFIXES would be a row the
  // engine writes while the page still pushes its own copy; a prefix with no
  // recorded row would be deferred on the strength of nothing.
  // MUTATION: change OWNED_PREFIXES[0] to "cp_position:" -> red (cp_pos:ep-1 unowned).
  const keys = new Set();
  for (const fx of loadFixtures(ROOT, { family: "rows" })) {
    for (const c of fx.doc.cases) {
      for (const w of Array.isArray(c.expect?.return) ? c.expect.return : []) keys.add(w.key);
    }
  }
  assert.ok(keys.size >= 3, `the rows family records ${keys.size} distinct keys; expected all three rows`);
  for (const k of keys) assert.ok(owned(k), `${k} is recorded as a shared row but OWNED_PREFIXES does not own it`);
  for (const p of OWNED_PREFIXES) {
    assert.ok([...keys].some((k) => k.startsWith(p)), `${p} is owned but no rows case writes under it`);
  }
});

test("no other cp_ key the app spells falls under an owned prefix", () => {
  // Every `cp_` key literal in the shipping page (app.js, sw.js, the player
  // modules). The trailing colons are what keep `cp_foray_feedback` (the
  // thumbs) out of `cp_foray:`; this is the check that says so.
  // MUTATION: "cp_foray:" -> "cp_foray" in engine-contract.js -> red, naming
  // cp_foray_feedback.
  const files = ["app.js", "sw.js", "search-engine.js"].map((f) => path.join(ROOT, f));
  const playerDir = path.join(ROOT, "player");
  for (const f of fs.readdirSync(playerDir)) {
    if (f.endsWith(".js") && !f.endsWith(".test.js")) files.push(path.join(playerDir, f));
  }
  const spelled = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bcp_[A-Za-z0-9_]*:?/g)) spelled.add(m[0]);
  }
  assert.ok(spelled.size > 20, `found only ${spelled.size} cp_ keys; the scan is not reading the app`);
  for (const p of OWNED_PREFIXES) assert.ok(spelled.has(p), `${p} is not spelled anywhere in the shipping page`);
  const wrongly = [...spelled].filter((k) => owned(k) && !OWNED_PREFIXES.includes(k)).sort();
  assert.deepStrictEqual(wrongly, [], "keys the engine would defer but never writes");
});
