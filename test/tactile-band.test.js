/* Tactile Phase 3 radio-band primitive. Mutations in each test were executed
 * against this suite before push, including the art director's BR BR bug. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { load, rule } = require("./helpers/tactile-primitives.js");

const p = load();
const segments = [
  { showId: "origin", show: "Origin Stories", duration: 400 },
  { showId: "n", show: "4a narration", duration: 30, narration: true },
  { showId: "bbq", show: "BBQ Radio Network", duration: 100 },
  { showId: "n", show: "4a narration", duration: 20, narration: true },
  { showId: "bbq", show: "BBQ Radio Network", duration: 100 },
  { showId: "moreish", show: "The Moreish Podcast", duration: 350 },
];

function baseBars(html) {
  const first = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(html)[1];
  return [...first.matchAll(/data-segment-index="(\d+)" x="([\d.]+)" y="8" width="([\d.]+)"/g)]
    .map((m) => ({ index: Number(m[1]), x: Number(m[2]), width: Number(m[3]) }));
}

test("segment widths follow runtime and keep the required rendered minima", () => {
  // MUTATION: replace `segment.duration / total` with `1 / segments.length` -> the 400:100 width relationship fails.
  const bars = baseBars(p.tactileBand({ id: "proportion", kind: "detail", segments, renderWidth: 400 }));
  assert.strictEqual(bars.length, segments.length);
  assert.ok(bars[0].width > bars[2].width * 3.5, "a four-times-longer clip should be about four times wider");
  assert.ok(bars[1].width >= 20, "detail narration keeps an 8px minimum at 400px wide");
  assert.ok(bars.every((bar) => bar.width >= 7.5), "every segment keeps at least 3px rendered");
});

test("station codes label same-show runs once across narration ticks", () => {
  // MUTATION: make narration end the active run in tactileBandRuns -> this fails with `BR BR`.
  const html = p.tactileBand({ id: "runs", kind: "detail", segments, renderWidth: 400, currentIndex: 4 });
  assert.strictEqual((html.match(/>BR<\/text>/g) || []).length, 1, "BBQ Radio Network is one run, not BR BR");
  assert.strictEqual((html.match(/>OS<\/text>/g) || []).length, 1);
  assert.strictEqual((html.match(/>MP<\/text>/g) || []).length, 1);
  assert.match(html, /class="t-band__code is-current" data-run-start="2" data-run-end="4"/);
});

test("the 24px label gate is applied to the whole run, not either bar", () => {
  // MUTATION: gate on each bar width before grouping -> the two 14px BR bars lose their one valid label.
  const narrow = [
    { showId: "long", show: "Origin Stories", duration: 800 },
    { showId: "bbq", show: "BBQ Radio Network", duration: 35 },
    { showId: "n", show: "4a narration", duration: 12, narration: true },
    { showId: "bbq", show: "BBQ Radio Network", duration: 35 },
    { showId: "tiny", show: "Small Show", duration: 8 },
  ];
  const html = p.tactileBand({ id: "gate", kind: "detail", segments: narrow, renderWidth: 400 });
  assert.strictEqual((html.match(/>BR<\/text>/g) || []).length, 1);
  assert.strictEqual((html.match(/>SS<\/text>/g) || []).length, 0, "a truly narrow run stays unlabelled");
});

test("progress uses a clip path and scrub exposes the raw accessible value", () => {
  // MUTATION: multiply clip width by 900 instead of 1000 -> the exact 430 value fails.
  const html = p.tactileBand({ id: "progress", kind: "scrub", segments, progress: .43, totalSeconds: 1000, valueText: "7 minutes 10 of 16 minutes 40, BBQ Radio Network" });
  assert.match(html, /id="progress-progress"/);
  assert.match(html, /width="430\.00" height="60"/);
  assert.match(html, /role="slider"[^>]*aria-valuenow="430"/);
  assert.match(html, /aria-valuetext="7 minutes 10 of 16 minutes 40, BBQ Radio Network"/);
});

test("narration is hatched outside mini mode and mini has no station labels", () => {
  // MUTATION: remove the hatch fill URL from narration rects -> the detail assertion fails.
  const detail = p.tactileBand({ id: "hatched", kind: "detail", segments });
  const mini = p.tactileBand({ id: "mini", kind: "mini", segments });
  assert.match(detail, /t-band__bar--narration" fill="url\(#hatched-hatch\)"/);
  assert.doesNotMatch(mini, /t-band__code/);
  assert.match(rule(".band--mini"), /height:\s*var\(--s-2\)/);
});
