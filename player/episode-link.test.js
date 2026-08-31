/* The mini-player's "Open episode" link — the exact bug Joey flagged during
 * live testing: "there's a button to 'open episode' which directs out of
 * the app! ... keep the users in the app." docs/episode-pages-plan.md §3
 * row 1 / Stage 1 fixes it by repointing `openLink` at the in-app
 * `#/episode/:id` route instead of `target="_blank"` to Apple Podcasts.
 *
 * player/client.js builds real DOM at import (see foray-playback.test.js's
 * note on why it can't be imported here), so — same approach
 * media-session.test.js's part 6 already uses for this exact file — this is
 * a real regression test against the SOURCE TEXT, not just eyeballed, with
 * the `//` comment escape hatch closed by stripping comments/strings first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(__dirname, "..", "player", "client.js");
const CLIENT = fs.readFileSync(CLIENT_PATH, "utf8");

/** Comments and string literals stripped, so a scan for a code path is not
    fooled by prose about it. Ported verbatim from media-session.test.js's
    codeOnly, which itself documents why order matters and why a `//` must be
    preceded by start-of-line/whitespace/an opener (a regex-literal `/` must
    not be misread as starting a comment). */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}

const CODE = codeOnly(CLIENT);

test("codeOnly does not blind itself on this file's own regex-shaped content", () => {
  const src = [
    'const re = /^#\\/episode\\//;',
    "// openLink.target = \"_blank\"; -- must not count as live code",
    "const ok = 1; // trailing comment",
  ].join("\n");
  const out = codeOnly(src);
  assert.match(out, /const re = /);
  assert.doesNotMatch(out, /must not count as live code/);
  assert.match(out, /const ok = 1;/);
});

test("the mini-player's episode link is never built as target=\"_blank\" / window.open (the flagged bug)", () => {
  // Mutation: restore `openLink.target = "_blank";` on the openLink builder.
  // This assertion fails the moment that line comes back as live code.
  assert.doesNotMatch(
    CODE,
    /openLink\.target\s*=/,
    "openLink must not set a target — it is an in-app hash link, not a new-tab link"
  );
  assert.doesNotMatch(
    CODE,
    /window\.open\(/,
    "no window.open anywhere in client.js"
  );
});

/** Same idea as codeOnly, but preserves template-literal content — this file
    needs to assert ON a template literal's exact contents (ui.openLink.href's
    assignment), which the stricter codeOnly() above intentionally erases. */
function codeOnlyKeepTemplates(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/(^|[\s(,;{}=])\/\/[^\n]*/gm, "$1");
}

const CODE_KEEP_TEMPLATES = codeOnlyKeepTemplates(CLIENT);

test("the mini-player's episode link is wired to the in-app #/episode/:id hash route", () => {
  // Mutation: change the setNowPlaying assignment back to
  // `ui.openLink.href = item.apple_episode_url;`. This assertion fails
  // because the in-app route pattern is gone from the live wiring.
  // Checked against CODE_KEEP_TEMPLATES (comments/quoted strings stripped,
  // template literals intact) because this assertion's target IS a template
  // literal — CODE's stricter codeOnly() would erase it.
  assert.match(
    CODE_KEEP_TEMPLATES,
    /ui\.openLink\.href\s*=\s*`#\/episode\/\$\{encodeURIComponent\(item\.id\)\}`/,
    "ui.openLink.href must be built from the in-app #/episode/:id hash route, mirroring ui.forayLink's own hash-route pattern in this same file"
  );
});

test("openLink's hidden state toggles on the episode id existing, not on apple_episode_url", () => {
  // Per the plan (§3 row 1): "hidden toggles on episode id existing, not on
  // apple_episode_url existing (it no longer depends on that field)."
  // Mutation: revert the guard to `if (item.apple_episode_url) {`.
  const guard = /if \(item\.id\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*ui\.openLink\.href/;
  assert.match(
    CODE.replace(/\s+/g, " "),
    /if \(item\.id\) \{[^}]*ui\.openLink\.href[^}]*ui\.openLink\.hidden = false;[^}]*\} else \{[^}]*ui\.openLink\.hidden = true;/,
    "the openLink visibility branch must gate on item.id, not item.apple_episode_url"
  );
  assert.doesNotMatch(
    CODE,
    /if \(item\.apple_episode_url\)/,
    "no remaining branch may gate openLink's visibility on apple_episode_url"
  );
});

test("closing the sheet on tap: openLink collapses the sheet like forayLink already does", () => {
  // Not strictly required by the plan, but openLink is now an in-app
  // navigation like forayLink — leaving the sheet open over the page it
  // navigates to would be the same bug forayLink's own click handler exists
  // to prevent. Mirror it. Checked against the raw source: codeOnly()
  // replaces quoted strings like "click" with "", which would defeat a
  // literal match on the addEventListener call.
  assert.match(
    CLIENT,
    /ui\.openLink\.addEventListener\("click",\s*\(\)\s*=>\s*setExpanded\(false\)\)/,
    "ui.openLink should collapse the expanded sheet on click, same as ui.forayLink"
  );
});

test("the label no longer implies leaving the app", () => {
  // Loose on purpose — the plan explicitly leaves final copy to the
  // implementer ("Episode ↗" or similar, "consider dropping" the glyph) but
  // is specific that it must not still read "Open episode" (the flagged copy).
  assert.doesNotMatch(CLIENT, /"Open episode ↗"/, "the old, misleading label text must be gone");
});
