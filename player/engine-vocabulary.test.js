/* player/engine-vocabulary.js (NE-04): the closed token sets of the native
   engine's diagnostics rows. The diag-tokens parity family records the sets
   and a sample of admissions for the Swift side; this suite holds the rules
   that are about the SETS themselves and the tokens other code already spells. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOCABULARY, VOCABULARY_SETS, admitToken,
  INTERRUPTION_REASONS, STOP_CAUSES, MODE_REASONS, FAULT_KINDS, SOURCES,
} from "./engine-vocabulary.js";
import { TRANSPORT_SOURCES } from "./diagnostic-log.js";
import { TOKEN_RE } from "../tools/parity/gen-constants.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the tokens the plan names are in their sets (plan §4.4, §4.6, card NE-04)", () => {
  // Apple's AVAudioSession.InterruptionReason cases, and nothing else: an
  // unrecognised reason maps to `unknown`, it does not grow the set.
  assert.deepEqual([...INTERRUPTION_REASONS], ["default", "appWasSuspended", "builtInMicMuted", "unknown"]);
  for (const t of ["grace-expired", "seam-timeout", "system-pause", "unknown"]) assert.ok(STOP_CAUSES.includes(t), `stop cause ${t}`);
  for (const t of ["no-plist-key", "crash-loop", "page-health", "downgrade"]) assert.ok(MODE_REASONS.includes(t), `mode reason ${t}`);
  assert.deepEqual([...FAULT_KINDS], ["implicit-activation", "externally-owned"]);
});

test("every source the page records for a transport command is admissible as an engine command's source", () => {
  // A page command carries its TRANSPORT_SOURCES token into engineSend's
  // `source` (plan §5.2); an engine that dropped one would record a command
  // from nowhere, which is D-4's "a stop with no cause" one layer down.
  for (const s of TRANSPORT_SOURCES) assert.equal(admitToken("source", s), s, `page source ${s}`);
  assert.ok(SOURCES.length > TRANSPORT_SOURCES.size, "the engine adds its own sources beside the page's");
});

test("the reason the NE-01 stub hello answers with is a mode reason", () => {
  // EngineHandshake.swift is compiled only on CI's Mac, but its literal is
  // plain text: the stub says reason=not-built, and a Copy header carrying a
  // reason this set drops would be a header with a hole in it.
  const swift = fs.readFileSync(path.join(ROOT, "mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/EngineHandshake.swift"), "utf8");
  const m = swift.match(/static let notBuiltReason = "([^"]+)"/);
  assert.ok(m, "EngineHandshake.notBuiltReason not found");
  assert.equal(admitToken("modeReason", m[1]), m[1]);
});

test("every set is frozen, non-empty, duplicate-free and spelled as a token; admission is exact for every token", () => {
  assert.ok(Object.isFrozen(VOCABULARY));
  assert.deepEqual([...VOCABULARY_SETS], Object.keys(VOCABULARY));
  for (const set of VOCABULARY_SETS) {
    const tokens = VOCABULARY[set];
    assert.ok(Object.isFrozen(tokens), `${set} is frozen`);
    assert.ok(tokens.length > 0, `${set} is non-empty`);
    assert.equal(new Set(tokens).size, tokens.length, `${set} has no duplicates`);
    for (const t of tokens) {
      assert.match(t, TOKEN_RE, `${set}: ${t}`);
      assert.equal(admitToken(set, t), t);
      assert.equal(admitToken(set, t.toUpperCase()), null, `${set}: ${t} is case-exact`);
      assert.equal(admitToken(set, `${t} `), null, `${set}: ${t} is not trimmed`);
    }
  }
  assert.throws(() => admitToken("hasOwnProperty", "x"), RangeError);
  assert.throws(() => admitToken(undefined, "x"), RangeError);
});
