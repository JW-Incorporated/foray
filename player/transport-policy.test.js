/* The client layer's transport rules (player/transport-policy.js, NE-08).

   THIS SUITE READS ITS FIXTURES. Every test below except the last runs the
   `transport` family's cases that name it in `covers[]`
   (player/parity/fixtures/transport/transport.json) against the real module —
   so the one file is both this suite's assertion and the Swift port's test
   list (TransportPolicy.swift, NE-09). The rule values themselves (4 s,
   0.25 s, 1 s) are AUTHORED cases: record.mjs refuses to overwrite them, so a
   JS edit that moves one is refused rather than quietly re-recorded.

   TO SEE ONE FAIL: set RESTART_WINDOW_SEC to 5, or drop `restored` from the
   first line of `resolveToggle`, or make `remoteStopAction` close on any truthy
   `close`, or drop the Foray branch's `durationSec` ceiling from `skipTarget`,
   or let `nudgeAction` skip forward from the last line — each turns the named
   test red with the case id and the diff.

   The behaviour of client.js ITSELF (that the bar, the lock screen and the car
   really take these answers) is pinned where it always was, by the suites that
   boot the real client.js: transport-reconcile, media-session, foray-playback.
   They are unchanged, and they are the proof that this extraction changed no
   behaviour. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCases } from "./parity/suite.js";

const cases = fixtureCases("transport", "transport-policy");

test("the restart window is 4 s, a Foray scrub lands 0.25 s inside the end, and an episode seek stops 1 s short", (t) => cases(t));

/* ---------- play / pause: resolveToggle ---------- */

test("play on a restored bar starts the restored item, whatever else is true", (t) => cases(t));
test("play on a finished Foray starts it over; a finished episode resumes", (t) => cases(t));
test("a press that asks for what the transport already is only repaints", (t) => cases(t));
test("play with something showing and nothing queued loads it; otherwise play resumes and pause pauses", (t) => cases(t));

/* ---------- previous: previousAction ---------- */

test("previous inside the first 4 s of a clip goes to the clip before; later, or on the first clip, it is the manager's", (t) => cases(t));
test("previous is measured on the Foray clock, so it goes back past a narration line too; a jump in flight restarts", (t) => cases(t));
test("an episode's previous restarts from 4 s in; before that the page may go to the row before", (t) => cases(t));

/* ---------- nudges and seeks ---------- */

test("a Foray nudge moves on the Foray clock and never below zero", (t) => cases(t));
test("a Foray nudge given the Foray's total stops 1 s short of its end; with none it is only floored", (t) => cases(t));
test("a nudge inside a spoken line re-speaks it back and skips it forward, but not past the last; anywhere else it seeks", (t) => cases(t));
test("an episode nudge is clamped between 0 and 1 s before the end", (t) => cases(t));
test("an episode target that is not a number is refused, and only a known duration caps it", (t) => cases(t));
test("a seek with nothing loaded is written down as the next start; paused, loading and playing seek", (t) => cases(t));
test("a Foray scrub reloads when it changes clip or nothing is loaded, and lands inside the item", (t) => cases(t));
test("a Foray-clock offset lands inside the item, never on its out-point", (t) => cases(t));
test("a spoken narration item has nothing to seek; a rendered one seeks in its own file", (t) => cases(t));

/* ---------- the remote stop ---------- */

test("a remote stop pauses unless it is the notification's close", (t) => cases(t));

/* ---------- an OS interruption's resume: interruptionResumeOffset ----------

   NE-14j (plan §4.4), JS-first: the manager's interruption-resume path asks this
   (queue-manager.test.js pins that it does, and only there). TO SEE IT FAIL:
   set INTERRUPTION_REWIND_SEC to 2, or drop the `startSec` floor. */
test("an OS interruption's should-resume steps back 1.5 s, never before the item's own start", (t) => cases(t));

/* ---------- client.js asks; it keeps no copy ---------- */

/* JS-only (exclusions.json, js-module-shape): the Swift engine has no client.js.
   What this holds down is the extraction itself — a second copy of a rule left
   behind in client.js would be exactly the drift this file exists to end, and
   every behaviour suite would stay green while the two copies agreed.
   TO SEE IT FAIL: paste `const RESTART_WINDOW_SEC = 4;` back into client.js, or
   inline `details?.close === true` in `remoteStop`. */
test("client.js asks these rules and keeps no private copy of one", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = fs.readFileSync(path.join(root, "player", "client.js"), "utf8");
  // Comments out, so a WHY-comment naming a rule is not mistaken for a copy.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
  const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\/transport-policy\.js";/.exec(code);
  assert.ok(imported, "client.js must import its transport rules from ./transport-policy.js");
  const names = imported[1].split(",").map((s) => s.trim()).filter(Boolean);
  for (const fn of ["resolveToggle", "previousAction", "episodePreviousRestarts", "skipTarget", "nudgeAction", "scrubTarget", "seekAction", "remoteStopAction", "clampEpisodeTarget", "sourceOffsetFor"]) {
    assert.ok(names.includes(fn), `client.js does not import ${fn}`);
    assert.match(code, new RegExp(`\\b${fn}\\(`), `client.js imports ${fn} but never asks it`);
    assert.doesNotMatch(code, new RegExp(`function\\s+${fn}\\s*\\(`), `client.js declares its own ${fn}`);
  }
  for (const k of ["RESTART_WINDOW_SEC", "SEEK_INSIDE_END_SEC", "SEEK_END_GUARD_SEC"]) {
    assert.doesNotMatch(code, new RegExp(`\\b${k}\\b`), `client.js still carries ${k}; the rule is transport-policy.js's`);
  }
  assert.doesNotMatch(code, /details\?\.close/, "the remote stop's close rule is remoteStopAction's");
  assert.doesNotMatch(code, /nothingToSeekIn/, "the pend-or-seek rule is seekAction's");
});
