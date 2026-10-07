/* Tactile Phase 3 radio-band primitive. Mutations in each test were executed
 * against this suite before push, including the art director's BR BR bug. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { load, rule, ROOT } = require("./helpers/tactile-primitives.js");
const fs = require("node:fs");
const path = require("node:path");

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

function scrubberFixture(value = 30) {
  const attrs = new Map([["role", "slider"], ["aria-valuemin", "0"], ["aria-valuemax", "100"], ["aria-valuenow", String(value)]]);
  const listeners = {};
  const progress = { attrs: {}, setAttribute(name, next) { this.attrs[name] = next; } };
  const needle = { attrs: {}, setAttribute(name, next) { this.attrs[name] = next; } };
  return {
    attrs, listeners, progress, needle,
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, next) { attrs.set(name, String(next)); },
    removeAttribute(name) { attrs.delete(name); },
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
    querySelector(selector) { return selector === ".band__progress" ? progress : selector === ".needle" ? needle : null; },
    getBoundingClientRect() { return { left: 10, width: 100 }; },
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture(id) { this.released = id; },
  };
}

test("scrubber pointer input tracks the well and publishes its changed value", () => {
  // MUTATION: delete the pointerdown listener registration -> the first call is missing and this test fails.
  const scrubber = scrubberFixture();
  const inputs = [];
  const changes = [];
  p.tactileWireScrubber(scrubber, {
    totalSeconds: 100,
    segments: [{ duration: 20 }, { duration: 30 }, { duration: 50 }],
    onInput(value, source) { inputs.push([value, source]); },
    onChange(value, source) { changes.push([value, source]); },
  });
  let prevented = false;
  scrubber.listeners.pointerdown({ clientX: 60, pointerId: 7, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "50");
  assert.strictEqual(scrubber.progress.attrs.width, "500.00");
  assert.strictEqual(scrubber.needle.attrs.transform, "translate(500.00 0)");
  scrubber.listeners.pointermove({ clientX: 90, pointerId: 7, preventDefault() {} });
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "80");
  scrubber.listeners.pointerup({ clientX: 57, pointerId: 7, preventDefault() {} });
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "50", "release snaps to a boundary within 12px");
  assert.deepStrictEqual(inputs, [[50, "pointer"], [80, "pointer"], [50, "pointer"]]);
  assert.deepStrictEqual(changes, [[50, "pointer"]], "release commits one seek");
  assert.strictEqual(scrubber.captured, 7);
  assert.strictEqual(scrubber.released, 7);
});

test("scrubber keyboard input seeks by time, by segment, and to both ends", () => {
  // MUTATION: change ArrowUp to add 30 seconds instead of choosing `nextBoundary` -> 50 becomes 75.
  const scrubber = scrubberFixture(30);
  p.tactileWireScrubber(scrubber, { totalSeconds: 100, segments: [{ duration: 20 }, { duration: 30 }, { duration: 50 }] });
  function key(value) {
    let prevented = false;
    scrubber.listeners.keydown({ key: value, preventDefault() { prevented = true; } });
    assert.ok(prevented, `${value} is handled`);
    return Number(scrubber.attrs.get("aria-valuenow"));
  }
  assert.strictEqual(key("ArrowRight"), 60, "right seeks 30 seconds");
  assert.strictEqual(key("ArrowLeft"), 45, "left seeks 15 seconds");
  assert.strictEqual(key("ArrowUp"), 50, "up seeks to the next segment boundary");
  assert.strictEqual(key("ArrowDown"), 20, "down seeks to the previous segment boundary");
  assert.strictEqual(key("End"), 100);
  assert.strictEqual(key("Home"), 0);
});

test("the gallery wires every rendered scrubber instead of shipping an inert slider", () => {
  // MUTATION: remove the tactileWireScrubber call from renderGallery -> this test fails.
  const gallery = fs.readFileSync(path.join(ROOT, "ui", "gallery.js"), "utf8");
  assert.match(gallery, /querySelectorAll\("\.band--scrub"\)[\s\S]*tactileWireScrubber\(scrubber/);
});
