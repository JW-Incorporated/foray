/* Cross-module vocabulary pins (code-health CH-31; issues P2-08, X1-10).

   `player/diagnostic-log.js` keeps no imports on purpose: it is the field
   record, it must load and write when every other module has failed, and a
   row is admitted by its tokens against sets it holds itself. So three of its
   closed sets are COPIES of vocabularies another module owns, and nothing but
   this suite holds the copies equal:

     diagnostic-log SESSION_ERRORS  <- engine-vocabulary SESSION_ERROR_DETAILS
                                       (the `err=` of a legacy
                                       `sessionActivated (failed)` row, L13)
     diagnostic-log DATA_FILE_KEYS  <- foray-directory FILE_KEYS (the per-file
                                       outcome loop and the `data` line)
     diagnostic-log DATA_SOURCES    >= every source a directory reports

   What drift costs is quiet: a token the owner adds and the copy lacks is
   DROPPED by `oneOf`, so the Copy report prints a failure with no reason, or
   a fourth data document with no outcome — the L13 gap the sets were added to
   close. The pins read the real modules, never a retyped list.

   The last test is the other half of the card: the three `cp_` rows the
   native engine owns are spelled once, in engine-vocabulary.js, and
   engine-contract.js, foray-progress.js and episode-progress.js import them
   rather than restating the strings. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as diagnosticLog from "./diagnostic-log.js";
import {
  SESSION_ERROR_DETAILS, POSITION_KEY_PREFIX, FORAY_PROGRESS_KEY_PREFIX, LAST_EPISODE_KEY,
} from "./engine-vocabulary.js";
import * as forayDirectory from "./foray-directory.js";
import { SOURCE as CATALOGUE_SOURCE } from "./catalogue-directory.js";
import { OWNED_PREFIXES } from "./engine-contract.js";
import { KEY_PREFIX as FORAY_KEY_PREFIX } from "./foray-progress.js";
import { KEY as EPISODE_KEY } from "./episode-progress.js";
import { positionKey } from "./position-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("diagnostic-log's SESSION_ERRORS is engine-vocabulary's SESSION_ERROR_DETAILS, token for token and in order (P2-08, L13)", () => {
  /* A Swift card adds an AVAudioSession.ErrorCode token to engine-vocabulary
     (the one place a token is added) and the legacy plugin's
     `sessionActivated (failed)` row carrying it reaches diagnostic-log, whose
     copy drops it: the failure prints with no reason.
     MUTATION (run): add a 13th token ("is-busy-2") to SESSION_ERROR_DETAILS in
     engine-vocabulary.js alone -> red. */
  assert.deepEqual([...diagnosticLog.SESSION_ERRORS], [...SESSION_ERROR_DETAILS]);
});

test("diagnostic-log's DATA_FILE_KEYS is foray-directory's FILE_KEYS, key for key and in order (X1-10)", () => {
  /* foray-directory fetches, validates and caches each document FILE_KEYS
     names; diagnostic-log tags and prints the outcome of each document
     DATA_FILE_KEYS names. A fourth document added to the first and not the
     second is fetched and never reported.
     MUTATION (run): add "chapters" to foray-directory.js FILE_KEYS alone -> red. */
  assert.deepEqual([...diagnosticLog.DATA_FILE_KEYS], [...forayDirectory.FILE_KEYS]);
});

test("every source a directory reports is a source the `data` row admits (X1-10)", () => {
  /* `dataSource` writes `source: DATA_SOURCES.has(source) ? source : null`, so
     a source the directory reports and the record does not admit becomes a
     row that says nothing about where the documents came from. Every
     foray-directory `SOURCE_*` export is read by name, so a new one is pinned
     the day it is added.
     catalogue-directory's SOURCE.NONE is the one exception, by meaning: it is
     "there is no catalogue" (#40's error), not a place a document came from,
     and the row's null says exactly that. It is pinned as the only exception
     so a second one is a decision, not an accident.
     MUTATION (run): respell foray-directory.js SOURCE_NETWORK as "net" -> red;
     add `SHARD: "shard"` to catalogue-directory.js SOURCE -> red. */
  const forayNames = Object.keys(forayDirectory).filter((k) => /^SOURCE_[A-Z_]+$/.test(k)).sort();
  assert.deepEqual(forayNames, ["SOURCE_BUNDLE", "SOURCE_CACHE", "SOURCE_NETWORK"], "premise: the directory's sources are read by name");
  for (const k of forayNames) {
    assert.ok(diagnosticLog.DATA_SOURCES.has(forayDirectory[k]), `foray-directory ${k}=${forayDirectory[k]} is not in DATA_SOURCES`);
  }
  const notAdmitted = Object.entries(CATALOGUE_SOURCE).filter(([, v]) => !diagnosticLog.DATA_SOURCES.has(v)).map(([k]) => k);
  assert.deepEqual(notAdmitted, ["NONE"], "catalogue-directory SOURCE tokens outside DATA_SOURCES");
});

test("the three engine-owned row keys are spelled once, in engine-vocabulary.js, and the owners import them (X1-10)", () => {
  /* engine-contract.js's OWNED_PREFIXES decides which rows DurableStore defers
     on the iOS shell, and foray-progress.js / episode-progress.js write those
     rows. Three literal copies of one string are how a respelling in one file
     would leave the engine owning a row nobody writes (or the page clobbering
     one the engine does). engine-contract.test.js pins the values; this pins
     that there is one spelling to pin.
     MUTATION (run): put `export const KEY_PREFIX = "cp_foray:";` back in
     foray-progress.js -> red (the scan finds the literal); spell
     OWNED_PREFIXES[2] as "cp_last_episode" in engine-contract.js -> red. */
  assert.deepEqual([...OWNED_PREFIXES], [POSITION_KEY_PREFIX, FORAY_PROGRESS_KEY_PREFIX, LAST_EPISODE_KEY]);
  assert.equal(FORAY_KEY_PREFIX, FORAY_PROGRESS_KEY_PREFIX);
  assert.equal(EPISODE_KEY, LAST_EPISODE_KEY);
  // position-store.js spells its family inside `positionKey` (not this card's
  // file); the value is held equal here and in engine-contract.test.js.
  assert.equal(positionKey(""), POSITION_KEY_PREFIX);

  /* A key literal is the whole string, or the head of a template that builds
     one (`cp_pos:${id}`); a complete example row such as the schema's
     "cp_pos:ep-1" is data, not a second spelling of the prefix. */
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  const literals = (file) => [...codeOnly(fs.readFileSync(path.join(HERE, file), "utf8"))
    .matchAll(/["'`](cp_(?:pos:|foray:|last_episode))(?=["'`]|\$\{)/g)].map((m) => m[1]);
  assert.deepEqual(literals("engine-vocabulary.js").sort(), ["cp_foray:", "cp_last_episode", "cp_pos:"],
    "premise: engine-vocabulary.js spells each key once");
  for (const file of ["engine-contract.js", "foray-progress.js", "episode-progress.js"]) {
    assert.deepEqual(literals(file), [], `${file} restates an engine-owned row key instead of importing it`);
  }
});
