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
  // MUTATION: in tactileBandLayout replace `segment.duration / freeTime * free` with `free / segments.length` -> the 400:100 width relationship fails.
  const bars = baseBars(p.tactileBand({ id: "proportion", kind: "detail", segments, renderWidth: 400 }));
  assert.strictEqual(bars.length, segments.length);
  assert.ok(bars[0].width > bars[2].width * 3.5, "a four-times-longer clip should be about four times wider");
  assert.ok(bars[1].width >= 20, "detail narration keeps an 8px minimum at 400px wide");
  assert.ok(bars.every((bar) => bar.width >= 7.5), "every segment keeps at least 3px rendered");
});

/* Layout invariants every band must hold, on the raw boxes (not the rendered
   rects, which round to 2 places). */
function assertLayout(boxes, mins, label) {
  for (let i = 0; i < boxes.length; i += 1) {
    assert.ok(boxes[i].width >= mins[i] - 1e-9, `${label}: bar ${i} keeps its minimum (${boxes[i].width} >= ${mins[i]})`);
    if (i + 1 < boxes.length) {
      assert.ok(boxes[i].x + boxes[i].width + 2 <= boxes[i + 1].x + 1e-9, `${label}: bar ${i} ends a 2-unit gap before bar ${i + 1}`);
    }
  }
  const last = boxes[boxes.length - 1];
  assert.ok(Math.abs(last.x + last.width - 1000) < 1e-6, `${label}: the last bar ends at 1000, not past it or short of it`);
  assert.strictEqual(boxes[0].x, 0, `${label}: the first bar starts at 0`);
}

test("narrow interior and trailing segments keep their minimum without overlapping or clipping", () => {
  /* The review's two cases. Interior: an 8px narration tick between two long
     clips. Trailing: a 3px clip at the very end. The old code advanced the
     cursor by raw runtime while widening the bar, so the tick overlapped the
     next bar and the last bar was cut at 1000 below its minimum.
     MUTATION: in tactileBandLayout replace `cursor += widths[i] + gap` with
     `cursor += segment.duration / total * 1000` -> overlap and end assertions fail.
     MUTATION 2: never pin (`if (!pinned[i] && w < mins[i])` -> `if (false)`)
     -> the minimum assertions fail. */
  const interiorInput = [
    { showId: "a", show: "Origin Stories", duration: 1200 },
    { showId: "n", narration: true, duration: 4 },
    { showId: "b", show: "BBQ Radio Network", duration: 1196 },
  ];
  const trailingInput = [
    { showId: "a", show: "Origin Stories", duration: 2000 },
    { showId: "b", show: "Small Show", duration: 2 },
  ];
  const w = 345;
  assertLayout(p.tactileBandLayout(p.tactileBandSegments(interiorInput), w, "detail"), [3, 8, 3].map((m) => m / w * 1000), "interior");
  assertLayout(p.tactileBandLayout(p.tactileBandSegments(trailingInput), w, "detail"), [3, 3].map((m) => m / w * 1000), "trailing");
  // The rendered SVG carries the same geometry.
  const bars = baseBars(p.tactileBand({ id: "narrow", kind: "detail", segments: interiorInput, renderWidth: w }));
  assert.ok(bars[1].width >= 8 / w * 1000 - 0.01, "the narration rect is drawn at its 8px minimum");
  assert.ok(bars[1].x + bars[1].width < bars[2].x, "the narration rect does not overlap the next bar");
  const tail = baseBars(p.tactileBand({ id: "tail", kind: "detail", segments: trailingInput, renderWidth: w }));
  assert.ok(tail[1].width >= 3 / w * 1000 - 0.01, "the trailing rect is drawn at its 3px minimum, not clipped");
  assert.ok(tail[1].x + tail[1].width <= 1000.01, "the trailing rect ends inside the viewBox");
});

test("a band whose minima cannot fit scales evenly and stays inside its box, in order", () => {
  /* 400 clips at 345px need 400 x 3px = 1200px of minimum: the one case a bar
     renders under its minimum. They must still be ordered, gapped and end at 1000.
     MUTATION: delete the `minSum >= available` branch's scaling (use `mins`
     as-is) -> every bar gets its full minimum and the band runs past 1000. */
  const many = p.tactileBandSegments(Array.from({ length: 400 }, (_, i) => ({ showId: "s" + i, show: "Show " + i, duration: 1 + (i % 7) })));
  const boxes = p.tactileBandLayout(many, 345, "detail");
  const scaled = boxes[0].width;
  assert.ok(scaled < 3 / 345 * 1000, "fixture premise: the minima genuinely do not fit");
  assertLayout(boxes, boxes.map(() => scaled), "over-full");
});

test("the scrubber maps pointer and needle through the drawn bars, not raw runtime", () => {
  /* Fixture: 1000 s with a 2 s narration tick at 100 s, drawn 100px wide, so
     the tick is pinned at 8px (80 units, ~94-174) instead of its ~2-unit runtime
     share. It sits off-centre on purpose: a symmetric fixture maps the same
     either way and would pin nothing.
     MUTATION: make pointerValue return `pointerUnits(event, rect) / 1000 * total`
     -> the middle of the tick reads ~134 s, a time in the next show.
     MUTATION 2: in setValue use `value / total * 1000` for x -> the needle for
     100 s (the end of the first show) lands at 100, inside the tick. */
  const segs = [
    { showId: "a", show: "Origin Stories", duration: 100 },
    { showId: "n", narration: true, duration: 2 },
    { showId: "b", show: "BBQ Radio Network", duration: 898 },
  ];
  const boxes = p.tactileBandLayout(p.tactileBandSegments(segs), 100, "scrub");
  const tick = boxes[1];
  assert.ok(tick.width >= 80 - 1e-9, "fixture premise: the tick is pinned at 8px");
  const scrubber = scrubberFixture(0, 1000);
  p.tactileWireScrubber(scrubber, { totalSeconds: 1000, segments: segs });
  const needleX = () => Number(/translate\(([\d.]+) 0\)/.exec(scrubber.needle.attrs.transform)[1]);

  const middlePx = 10 + (tick.x + tick.width / 2) / 1000 * 100;
  scrubber.listeners.pointerdown({ clientX: middlePx, pointerId: 1, preventDefault() {} });
  const value = Number(scrubber.attrs.get("aria-valuenow"));
  assert.ok(value >= 100 && value <= 102, `the middle of the tick reads a time inside it (${value})`);
  assert.ok(needleX() >= tick.x - 0.01 && needleX() <= tick.x + tick.width + 0.01, `the needle sits on the tick (${needleX()})`);
  scrubber.listeners.pointercancel({ pointerId: 1 });

  scrubber.attrs.set("aria-valuenow", "0");
  scrubber.listeners.keydown({ key: "ArrowUp", preventDefault() {} });
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "100", "fixture premise: ArrowUp seeks to the first boundary");
  const end = boxes[0].x + boxes[0].width;
  assert.ok(Math.abs(needleX() - end) < 0.01 && needleX() < tick.x, `the end of the first show puts the needle at its bar's edge, before the tick (${needleX()} vs ${end})`);
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

test("progress uses a clip path on the drawn bars and scrub exposes the raw accessible value", () => {
  /* 43% of runtime is exactly the end of the first narration tick (400 + 30 of
     1000 s). The bars are laid out with minimum widths, so that instant must
     land on the narration bar's right edge, not at 430 of 1000.
     MUTATION: compute `progressX` as `progress * 1000` -> clip and needle read
     430.00, past the narration bar's edge, and both edge assertions fail. */
  const html = p.tactileBand({ id: "progress", kind: "scrub", segments, progress: .43, totalSeconds: 1000, valueText: "7 minutes 10 of 16 minutes 40, BBQ Radio Network" });
  assert.match(html, /id="progress-progress"/);
  const bars = baseBars(html);
  const edge = bars[1].x + bars[1].width;
  const clip = Number(/class="band__progress" x="0" y="0" width="([\d.]+)" height="60"/.exec(html)[1]);
  const needle = Number(/class="needle" transform="translate\(([\d.]+) 0\)"/.exec(html)[1]);
  assert.ok(Math.abs(clip - edge) < 0.02, `clip ${clip} ends at the narration bar's edge ${edge}`);
  assert.ok(Math.abs(needle - edge) < 0.02, `needle ${needle} sits at the narration bar's edge ${edge}`);
  assert.ok(needle < bars[2].x, "the needle has not entered the next show's bar");
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

function scrubberFixture(value = 30, max = 100) {
  const attrs = new Map([["role", "slider"], ["aria-valuemin", "0"], ["aria-valuemax", String(max)], ["aria-valuenow", String(value)]]);
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
