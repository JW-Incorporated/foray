/* Tactile Phase 3 row primitives. Every named mutation was executed before
 * push; assertions inspect the raw markup, not a truncated visual fixture. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { load, rule, CSS } = require("./helpers/tactile-primitives.js");

const p = load();

test("show, episode, and queue rows use the three measured height tokens", () => {
  // MUTATION: change `.row-episode` min-height to `--row-show` -> this test fails.
  assert.match(rule(".row-show"), /min-height:\s*var\(--row-show\)/);
  assert.match(rule(".row-episode"), /min-height:\s*var\(--row-episode\)/);
  assert.match(rule(".row-queue"), /min-height:\s*var\(--row-queue\)/);
});

test("an episode has one trailing keycap and Up Next stays on its meta line", () => {
  // MUTATION: render the queue action in `row__end` beside Play -> the meta containment assertion fails.
  const html = p.tactileEpisodeRow({ title: "Episode", show: "Show", duration: "35 min" });
  assert.strictEqual((html.match(/class="keycap\b/g) || []).length, 1, "one trailing Play keycap");
  const meta = /<div class="row__meta">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(meta, /class="row__queue"/);
  assert.match(meta, />Up Next</);
  assert.doesNotMatch(/<div class="row__end">([\s\S]*?)<\/div>/.exec(html)[1], /row__queue/);
});

test("meta lines use the short display-name rule while titles keep escaped data", () => {
  // MUTATION: drop the `tactileDisplayName()` call in tactileEpisodeRow -> the suffix leaks and this test fails.
  const html = p.tactileEpisodeRow({ title: '<A & "B">', show: "Lingthusiasm - A podcast that's enthusiastic about linguistics", duration: "35 min" });
  assert.match(html, /class="row__show">Lingthusiasm<\/span>/);
  assert.doesNotMatch(html, /enthusiastic/);
  assert.match(html, /&lt;A &amp; &quot;B&quot;&gt;/);
});

test("downloaded rows wrap after the show name at narrow phone widths", () => {
  // MUTATION: change `flex: 1 1 100%` to `flex: 0 1 auto` -> this test fails.
  assert.match(CSS, /@media \(max-width: 393px\)[\s\S]*\.row-episode:has\(\.tag--downloaded\) \.row__show\s*\{\s*flex:\s*1 1 100%/);
  assert.match(rule(".row__show"), /min-width:\s*112px/);
});

test("artwork URLs pass through safeUrl and unsafe sources never reach markup", () => {
  // MUTATION: replace `esc(safeUrl(d.url))` with `d.url` -> javascript: reaches the src and this test fails.
  const bad = p.tactileEpisodeRow({ title: "Episode", show: "Show", artwork: "javascript:alert(1)" });
  const good = p.tactileEpisodeRow({ title: "Episode", show: "Show", artwork: "https://example.com/a.png" });
  assert.match(bad, /src="#"/);
  assert.doesNotMatch(bad, /javascript:/);
  assert.match(good, /src="https:\/\/example\.com\/a\.png"/);
});
