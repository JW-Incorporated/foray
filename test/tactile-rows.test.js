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
  /* A row with the mark wraps when it must at any width (row-gap 0), and at 393 and under the
     WORD mark (offline) puts the name alone on line one; the check-circle alone (`.tag--icon`,
     online) is left to wrap naturally. Redesign 2026 `home-offline` changed this from "every
     downloaded row, at 393 and under" because the online mark is small and must not force a wrap.
     MUTATION: change `flex: 1 1 100%` to `flex: 0 1 auto` -> this test fails.
     MUTATION 2: drop `:not(.tag--icon)` -> the icon-only row is forced to wrap and the third assertion fails. */
  assert.match(CSS, /@media \(max-width: 393px\)[\s\S]*\.row-episode:has\(\.tag--downloaded:not\(\.tag--icon\)\) \.row__show\s*\{\s*flex:\s*1 1 100%/);
  assert.match(rule(".row-episode:has(.tag--downloaded) .row__meta"), /flex-wrap:\s*wrap/);
  assert.doesNotMatch(CSS, /\.row-episode:has\(\.tag--downloaded\) \.row__show\s*\{/);
  /* The name shrinks and ellipsises before anything else on the line, and the
     facts are one unshrinking group. Tactile Today: the notes' `min-width:
     112px` on the name pushed a row with a long length ("1 hr 4 min") over the
     key beside it; the prototype's final rule is a name that may shrink to
     nothing. MUTATION: restore `min-width: 112px` -> the first assertion fails
     (and the gate's tap-targets report "+ Up Next" overlapping the key). */
  assert.match(rule(".row__show"), /flex:\s*0 1 auto/);
  assert.match(rule(".row__show"), /min-width:\s*0/);
  assert.match(rule(".row__facts"), /flex:\s*none/);
});

test("artwork URLs pass through safeUrl and unsafe sources never reach markup", () => {
  // MUTATION: replace `esc(safeUrl(artUrl(d.url, px * 3)))` with `artUrl(d.url, px * 3)` -> javascript: reaches the src and this test fails.
  const bad = p.tactileEpisodeRow({ title: "Episode", show: "Show", artwork: "javascript:alert(1)" });
  const good = p.tactileEpisodeRow({ title: "Episode", show: "Show", artwork: "https://example.com/a.png" });
  assert.match(bad, /src="#"/);
  assert.doesNotMatch(bad, /javascript:/);
  assert.match(good, /src="https:\/\/example\.com\/a\.png"/);
});

test("the bridge carries adoption-ready metadata, Up Next, and one Play keycap", () => {
  // MUTATION: delete the bridge__details block -> show, duration, and Up Next all disappear and this test fails.
  const html = p.tactileBridgeCard({ title: "Words wear into new forms", show: "Lingthusiasm - A podcast", duration: "35 min" });
  assert.match(html, /class="bridge__show">Lingthusiasm<\/span>/);
  assert.match(html, /class="readout">35 min<\/span>/);
  assert.match(html, /class="row__queue"[^>]*aria-label="Add to Up Next: Words wear into new forms"/);
  assert.match(html, />Up Next<\/span>/);
  assert.strictEqual((html.match(/class="keycap\b/g) || []).length, 1, "one Play keycap");
  assert.match(html, /aria-label="Play Words wear into new forms"/);
});

test("skeletons expose the final hero, row, and playlist anatomy as separate shapes", () => {
  // MUTATION: replace the three skel__title spans with one span -> the title-line count fails.
  const hero = p.tactileSkeleton("hero");
  const title = /<div class="skel__title">([\s\S]*?)<\/div>/.exec(hero)[1];
  const discs = /<span class="skel__discs">([\s\S]*?)<\/span><span class="skel__shape skel__readout">/.exec(hero)[1];
  const why = /<div class="skel__why">([\s\S]*?)<\/div>/.exec(hero)[1];
  assert.strictEqual((title.match(/skel__shape/g) || []).length, 3, "three independent title lines");
  assert.strictEqual((discs.match(/skel__shape/g) || []).length, 3, "three overlapping discs");
  assert.strictEqual((why.match(/skel__shape/g) || []).length, 2, "two why-lines");
  for (const part of ["skel__eyebrow", "skel__band", "skel__readout", "skel__primary", "skel__secondary"]) assert.match(hero, new RegExp(part));
  const row = p.tactileSkeleton("row");
  assert.match(row, /skel__row-art/);
  assert.match(row, /skel__row-meta/);
  assert.match(row, /skel__row-control/);
  const card = p.tactileSkeleton("card");
  assert.match(card, /skel__card-art/);
  assert.strictEqual((/<div class="skel__card-lines">([\s\S]*?)<\/div>/.exec(card)[1].match(/skel__shape/g) || []).length, 2);
  assert.match(rule(".skel__title > span"), /height:\s*calc\(var\(--s-6\) \+ var\(--s-1\)\)/);
});

test("row and tile artwork is decorative by default; standalone artwork names itself only when asked", () => {
  /* Review nit (p3-primitives, second look): artwork defaulted its alt to the
     title printed beside it, so every row was announced twice.
     MUTATION: restore `var label = d.alt || d.title || "Podcast artwork"` in
     tactileArtFrame -> the row and tile assertions fail. */
  const row = p.tactileEpisodeRow({ title: "Episode", show: "Show", artwork: "https://example.com/a.png" });
  assert.match(row, /<img src="https:\/\/example\.com\/a\.png" alt="" /);
  const show = p.tactileShowRow({ name: "Origin Stories", artwork: "https://example.com/b.png" });
  assert.match(show, /<img src="https:\/\/example\.com\/b\.png" alt="" /);
  const queue = p.tactileQueueRow({ title: "Queued", show: "Show", artwork: "https://example.com/c.png" });
  assert.match(queue, /<img src="https:\/\/example\.com\/c\.png" alt="" /);
  const alone = p.tactileArtFrame({ url: "https://example.com/d.png", title: "Ignored", alt: "Cover of <Origin Stories>" });
  assert.match(alone, /alt="Cover of &lt;Origin Stories&gt;"/, "an explicit alt is kept, escaped");
});

test("artwork asks Apple's CDN for 3x its drawn size, lazily, with its box reserved", () => {
  /* perf-2 (test/boot-path.test.js) holds every <img> in the app to artUrl;
     this pins the frame sizes it is given, from the --art-* tokens.
     MUTATION: pass `d.url` instead of `artUrl(d.url, px * 3)` in tactileArtFrame
     -> the 600px original is fetched and the size assertions fail.
     MUTATION 2: set `row: 44` in TACTILE_ART_PX -> the row asks for 132, not 168. */
  const big = "https://is1-ssl.mzstatic.com/image/thumb/Podcasts211/v4/3d/mza_1.jpg/600x600bb.jpg";
  const row = p.tactileArtFrame({ size: "row", url: big });
  assert.match(row, /\/168x168bb\.jpg" alt="" loading="lazy" decoding="async" width="56" height="56">/);
  assert.match(p.tactileArtFrame({ size: "mini", url: big }), /\/132x132bb\.jpg"[^>]*width="44" height="44"/);
  assert.match(p.tactileArtFrame({ size: "hero", url: big }), /\/288x288bb\.jpg"[^>]*width="96" height="96"/);
  for (const [size, token] of [["row", "--art-row"], ["queue", "--art-queue"], ["mini", "--art-mini"], ["disc", "--art-disc"]]) {
    const px = Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(CSS)[1]);
    assert.match(p.tactileArtFrame({ size, url: big }), new RegExp(`/${px * 3}x${px * 3}bb\\.jpg"[^>]*width="${px}"`), `${size} follows ${token}`);
  }
  const other = "https://example.com/art/600x600bb.jpg";
  assert.match(p.tactileArtFrame({ url: other }), /src="https:\/\/example\.com\/art\/600x600bb\.jpg"/, "an unknown host is left alone");
});
