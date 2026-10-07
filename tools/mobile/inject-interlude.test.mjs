/* The jingle-into-the-app step (`tools/mobile/inject-interlude.mjs`).
 *
 * NE-34's jingle stopped being a SwiftPM resource on 2026-09-29 (a resource
 * bundle cannot take the archive's provisioning profile; release run
 * 36535801479). It now reaches App.app/public the way the Kokoro weights do,
 * and this suite guards the quiet failure: a green build with no jingle in it.
 * Every test names the mutation that turns it red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inject, check, DEFAULT_DEST, REPO_ROOT } from "./inject-interlude.mjs";
import { INTERLUDE_APP_PATH, INTERLUDE_SHA256, INTERLUDE_SOURCE } from "../audio/interlude-asset.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foray-inject-interlude-"));

test("inject copies the pinned jingle to <public>/player/assets and --check accepts it", () => {
  /* MUTATION: write to the public root, or under another name; skip the copy. */
  const dest = tmp();
  try {
    assert.deepEqual(check({ dest }), [`${INTERLUDE_APP_PATH}: missing from ${dest}`]);
    const { copied, problems } = inject({ dest });
    assert.deepEqual(problems, []);
    assert.equal(copied.path, path.join(dest, "player", "assets", "interlude-placeholder.wav"));
    assert.deepEqual(fs.readFileSync(copied.path), fs.readFileSync(path.join(REPO_ROOT, INTERLUDE_SOURCE)));
    assert.deepEqual(check({ dest }), []);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("a source that does not hash to the pin is refused and nothing is written; a wrong file in the app fails --check", () => {
  /* MUTATION: drop the pre-copy hash, or have check() test existence only. */
  const root = tmp();
  const dest = tmp();
  try {
    fs.mkdirSync(path.join(root, path.dirname(INTERLUDE_SOURCE)), { recursive: true });
    fs.writeFileSync(path.join(root, INTERLUDE_SOURCE), Buffer.from("an episode somebody dropped here"));
    const { copied, problems } = inject({ dest, root });
    assert.equal(copied, null);
    assert.match(problems[0], new RegExp(`pinned ${INTERLUDE_SHA256}`));
    assert.equal(fs.existsSync(path.join(dest, INTERLUDE_APP_PATH)), false, "nothing written");

    fs.mkdirSync(path.join(dest, path.dirname(INTERLUDE_APP_PATH)), { recursive: true });
    fs.writeFileSync(path.join(dest, INTERLUDE_APP_PATH), Buffer.from("not the jingle"));
    assert.match(check({ dest })[0], /sha256 [0-9a-f]{64}, pinned/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("both iOS build paths inject the jingle after the project is generated, and check it", () => {
  /* CH2-16: both paths run the inject sequence through ONE composite,
     .github/actions/ios-prepare, which carries the two lines.
     MUTATION: drop either line from ios-prepare, drop the ios-prepare use from
     ios-build.yml or the ios-archive action (the release path, which is the
     one that failed), or run it before `cap add ios`, which rewrites public/. */
  assert.equal(DEFAULT_DEST, "mobile/ios/App/App/public");
  const prepare = fs.readFileSync(path.join(REPO_ROOT, ".github/actions/ios-prepare/action.yml"), "utf8");
  assert.ok(prepare.includes("node tools/mobile/inject-interlude.mjs mobile/ios/App/App/public\n"), "ios-prepare does not inject the jingle");
  assert.ok(prepare.includes("node tools/mobile/inject-interlude.mjs mobile/ios/App/App/public --check"), "ios-prepare does not check the jingle");
  for (const rel of [".github/workflows/ios-build.yml", ".github/actions/ios-archive/action.yml"]) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const at = src.indexOf("uses: ./.github/actions/ios-prepare");
    assert.ok(at > 0, `${rel} does not run ios-prepare, so it does not inject the jingle`);
    const gen = src.indexOf("npm run add:ios 2>&1");
    assert.ok(gen > 0 && gen < at, `${rel}: the jingle must be injected after the iOS project is generated`);
  }
});
