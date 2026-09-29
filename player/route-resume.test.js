/* Route resume, the JS reference (player/route-resume.js, NE-38rj; founder Q5).

   THIS SUITE READS ITS FIXTURES. Every test below except the last runs the
   `route-resume` family's cases that name it in `covers[]`
   (player/parity/fixtures/route-resume/) against the real module, so this one
   file is both the JS assertion and the native ports' test list (NE-38rs's
   RouteResume.swift, A-61 on the JVM). The two rule values and the founder's
   listener rule are AUTHORED cases: record.mjs refuses to overwrite them, so a
   JS edit that moves one is refused rather than quietly re-recorded.

   TO SEE ONE FAIL: let a listener's pause through the first guard of
   routeResumeDecision (record.mjs --mutate route-listener does exactly that),
   or set ROUTE_RESUME_MAX_LOST_SEC to 25 h, or turn the Bluetooth arm on by
   default, or drop `s.lost = null` from a resume in routeResumeStep, or let
   "lost" arm while paused — each turns the named test red with the case id and
   the diff. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCases } from "./parity/suite.js";

const cases = fixtureCases("route-resume", "route-resume");

/* ---------- the values and the vocabulary ---------- */

test("the rule values: a loss resumes for 24 h, and the Bluetooth arm is off", (t) => cases(t));
test("the port classes: CarPlay is a car; A2DP, HFP and LE are Bluetooth; everything else is other", (t) => cases(t));
test("a route's key is its port type and UID, never its name, and a port with no UID has none", (t) => cases(t));

/* ---------- the decision ---------- */

test("a known car lost while playing and back again resumes, once", (t) => cases(t));
test("a listener's pause is never resumed, even when the car is then lost and comes back", (t) => cases(t));
test("a call, Siri or a system pause during the loss clears it", (t) => cases(t));
test("a press after the loss clears it, whatever the press was", (t) => cases(t));
test("only the route that was lost resumes: a different car, or a port with no UID, does not", (t) => cases(t));
test("a car our audio never played through does not resume", (t) => cases(t));
test("Bluetooth resumes only with the arm on; headphones and other ports never", (t) => cases(t));
test("a loss older than 24 h does not resume; one exactly 24 h old does", (t) => cases(t));
test("one resume per loss: a second back, or a duplicate back while the resume's load is pending, finds nothing", (t) => cases(t));
test("a route lost while already paused never arms a resume", (t) => cases(t));
test("an event the reducer does not know is refused", (t) => cases(t));

/* ---------- the JS lanes never resume on a reconnect ---------- */

/* JS-only (exclusions.json, js-module-shape): the native engines have no
   queue-manager.js or client.js. The web and Android JS lanes keep "a
   reconnect never resumes" (queue-manager.js corner case #13, player-core-10);
   this module is the reference the native engines port, not a rule the page
   runs. TO SEE IT FAIL: import routeResumeDecision into client.js. */
test("neither queue-manager.js nor client.js imports route-resume.js: the JS lanes never resume on a reconnect", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of ["queue-manager.js", "client.js"]) {
    const src = fs.readFileSync(path.join(root, "player", file), "utf8");
    // Comments out, so a WHY-comment naming the module is not mistaken for an import.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
    assert.doesNotMatch(code, /route-resume(\.js)?["']/, `${file} imports route-resume.js; the JS lanes keep "a reconnect never resumes"`);
    for (const name of ["routeResumeDecision", "routeResumeStep", "routeResumeReplay", "ROUTE_RESUME_MAX_LOST_SEC"]) {
      assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${file} names ${name}`);
    }
  }
});
