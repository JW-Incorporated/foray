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

test("a run under 24px keeps its station code when two letters fit between its neighbours' codes", () => {
  /* The first runs of a 7-show foray are 13 and 19px wide; with no code beside them
     colour was the only thing naming the show. Wide runs claim their codes first, a
     narrow one takes a code only if it clears its neighbours (centres 16px apart) and
     is at least 8px wide, left to right.
     MUTATION 1: make tactileBandLabelRuns return only the wide runs -> the two fitting
     narrow codes (BF, YC) disappear and the first assertion fails.
     MUTATION 2: drop the `fits(run)` collision test (`if (wide || true)`) -> the crowded
     pair loses its gap and the pitch assertion fails. */
  const shows = [
    { showId: "bf", show: "Bootstrapped Founder", duration: 40 },
    { showId: "yc", show: "Y Combinator", duration: 55 },
    { showId: "ss", show: "Startups Stories", duration: 300 },
    { showId: "bg", show: "Big Show", duration: 600 },
    { showId: "t1", show: "Tiny One", duration: 35 },
    { showId: "t2", show: "Tiny Two", duration: 35 },
  ];
  const html = p.tactileBand({ id: "narrow", kind: "scrub", segments: shows, renderWidth: 345 });
  const labels = [...html.matchAll(/class="t-band__code[^"]*" data-run-start="(\d+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(labels.slice(0, 4), ["0:BF", "1:YC", "2:SS", "3:BS"], "the narrow runs read, in order, beside the wide ones");
  const xs = [...html.matchAll(/class="t-band__code[^"]*"[^>]*x="([\d.]+)"/g)].map((m) => Number(m[1]) * 345 / 1000);
  xs.slice(1).forEach((x, i) => assert.ok(x - xs[i] >= 16 - 1e-6, `codes ${i} and ${i + 1} are ${x - xs[i]}px apart, under the 16px pitch`));
  assert.deepStrictEqual(labels.slice(4), ["4:TO"], "two 11px runs side by side cannot both clear the pitch: the first reads, the second stays code-less");
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

test("the mini band and the mini player's line draw narration as a solid tick, not a hatch", () => {
  /* BUILD-NOTES 3.6: in the 8px mini band (and the 3px line) a narration item
     is a solid ultramarine tick, min 3px, no hatch; r1 read 4px hatched
     slivers as rendering artifacts.
     MUTATION: make `var hatch = kind !== "mini" && !line;` read `var hatch = true;`
     -> the mini and line narration rects carry the hatch URL and this fails. */
  for (const kind of ["mini", "line"]) {
    const html = p.tactileBand({ id: "tick-" + kind, kind, segments });
    const narration = [...html.matchAll(/<rect class="t-band__bar t-band__bar--narration[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(narration.length >= 2, `${kind}: fixture premise, narration is drawn`);
    for (const rect of narration) {
      assert.doesNotMatch(rect, /fill="url\(/, `${kind}: narration is not hatched`);
      assert.match(rect, /t-band__bar--tick/, `${kind}: narration takes the solid tick fill`);
    }
  }
  assert.match(rule(".t-band__bar--tick"), /fill:\s*var\(--dial-seg-narration\)/);
});

test("bands rendered without an id never share their pattern or clip-path ids", () => {
  /* A url(#id) reference resolves to the FIRST element in the document with
     that id. Two bands sharing a default id would both hatch and clip through
     the first band's definitions, so the second would show the first one's
     progress. Assert on the raw markup of two default bands on one page, and
     resolve each band's clip-path reference the way a document would (first
     match in the combined markup).
     MUTATION: in tactileBand replace `tactileBandAutoId()` with `"dial-band"`
     -> the ids collide and band two's clip resolves to band one's 10%. */
  const a = p.tactileBand({ kind: "detail", segments, progress: 0.1 });
  const b = p.tactileBand({ kind: "detail", segments, progress: 0.9 });
  const page = a + b;
  const defs = [...page.matchAll(/<(?:pattern|clipPath) id="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(defs.length, 4, "two patterns and two clip paths");
  assert.strictEqual(new Set(defs).size, 4, "every definition id is unique on the page: " + defs.join(", "));
  for (const band of [a, b]) {
    const clipRef = /clip-path="url\(#([^)]+)\)"/.exec(band)[1];
    const own = /<clipPath id="([^"]+)"><rect class="band__progress"[^>]*width="([\d.]+)"/.exec(band);
    assert.strictEqual(clipRef, own[1], "a band clips through its own clip path");
    const resolved = new RegExp('<clipPath id="' + clipRef + '"><rect class="band__progress"[^>]*width="([\\d.]+)"').exec(page)[1];
    assert.strictEqual(resolved, own[2], "the document resolves the reference to this band's own progress");
    for (const fill of band.matchAll(/fill="url\(#([^)]+)\)"/g)) {
      assert.ok(band.includes('<pattern id="' + fill[1] + '"'), "a band hatches through its own pattern");
    }
  }
  assert.notStrictEqual(/width="([\d.]+)" height="60"><\/rect><\/clipPath>/.exec(a)[1], /width="([\d.]+)" height="60"><\/rect><\/clipPath>/.exec(b)[1], "fixture premise: the two bands' progress differs");
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
  /* 80px of a 100px well: the 2px gaps (20 units each at this width) put that pointer
     at 79 s, one under the gap-free 80. */
  scrubber.listeners.pointermove({ clientX: 90, pointerId: 7, preventDefault() {} });
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "79");
  scrubber.listeners.pointerup({ clientX: 57, pointerId: 7, preventDefault() {} });
  assert.strictEqual(scrubber.attrs.get("aria-valuenow"), "50", "release snaps to a boundary within 12px");
  assert.deepStrictEqual(inputs, [[50, "pointer"], [79, "pointer"], [50, "pointer"]]);
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

/* ---- Today iteration 2: the mini band reads as bars in a well ---- */

test("bars are separated by 2 rendered px, not 2 viewBox units", () => {
  /* The first Today build left 2 UNITS between bars: 0.65px at the 323px hero band,
     so bars of one enamel fused into one long bar. The gap is 2000 / renderWidth units.
     MUTATION: put `var gap = 2` back in tactileBandLayout -> the 323px gap is 2 units
     (0.65px) and the pixel assertion fails. */
  const w = 323;
  const boxes = p.tactileBandLayout(p.tactileBandSegments(segments), w, "mini");
  for (let i = 0; i + 1 < boxes.length; i += 1) {
    const gapPx = (boxes[i + 1].x - (boxes[i].x + boxes[i].width)) / 1000 * w;
    assert.ok(Math.abs(gapPx - 2) < 1e-6, `gap ${i} is 2px rendered (${gapPx})`);
  }
  assert.ok(Math.abs(boxes[boxes.length - 1].x + boxes[boxes.length - 1].width - 1000) < 1e-6);
});

test("a dense band drops to the 1px gap floor before it lets any bar fall under its minimum", () => {
  /* 80 clips at 323px need 80 x 3px = 240px of minimum; 79 gaps of 2px add 158 (398 > 323),
     of 1px add 79 (319 <= 323). So the gap falls to 1px and every bar keeps its 3px.
     MUTATION: delete the `Math.max(2, 1000 / width)` candidate from the gap list in
     tactileBandLayout -> the band keeps 2px gaps, its bars are scaled under 3px and the
     assertions fail. */
  const w = 323;
  const many = p.tactileBandSegments(Array.from({ length: 80 }, (_, i) => ({ showId: "s" + (i % 3), show: "Show " + (i % 3), duration: 60 })));
  const boxes = p.tactileBandLayout(many, w, "mini");
  const gapPx = (boxes[1].x - (boxes[0].x + boxes[0].width)) / 1000 * w;
  assert.ok(Math.abs(gapPx - 1) < 1e-6, `the gap fell to the 1px floor (${gapPx})`);
  assert.ok(boxes.every((b) => b.width / 1000 * w >= 3 - 1e-6), "and every bar still keeps 3px");
});

test("the mini band's bars fill its 8px and end in a 2px radius on both axes", () => {
  /* The viewBox is 60 high and the mini band renders 8px tall, so the old 28-unit bar was
     3.7px: under half the prototype's 8px. Bars fill the box (y 0, height 60) and the corner
     is 2px: rx 2000/323 units across, ry 15 units (2px of an 8px, 60-unit axis).
     MUTATION: change `barH = mini ? 60 : 28` to `28` -> the height assertion fails.
     MUTATION 2: use `rx="2"` for every kind -> the rx assertion fails. */
  const html = p.tactileBand({ id: "fill", kind: "mini", segments, renderWidth: 323 });
  const base = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(html)[1];
  const rects = [...base.matchAll(/<rect [^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(rects.length, segments.length);
  for (const rect of rects) {
    assert.match(rect, /y="0"/);
    assert.match(rect, /height="60"/);
    assert.match(rect, new RegExp('rx="' + (2000 / 323).toFixed(2) + '"'));
    assert.match(rect, /ry="15\.00"/);
  }
  const detail = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(p.tactileBand({ id: "d", kind: "detail", segments, renderWidth: 323 }))[1];
  assert.match(detail, /y="8"[^>]*height="28"/, "detail keeps its own 28-unit bars");
});

test("an unplayed mini band has no needle; a played one has a 2px needle", () => {
  /* The hero band is a foray nobody has started: a needle at 0 read as a stray "I" at the
     left end of the well. MUTATION: delete the `(mini && !progress)` guard -> the idle band
     draws a needle and the first assertion fails. The played needle is 2px wide in
     rendered terms (2000 / 323 units), not the 2 units the other kinds still use. */
  const idle = p.tactileBand({ id: "idle", kind: "mini", segments, renderWidth: 323 });
  assert.doesNotMatch(idle, /class="needle"/);
  const played = p.tactileBand({ id: "played", kind: "mini", segments, renderWidth: 323, progress: 0.5 });
  const needle = /class="needle"[^>]*><rect [^>]*width="([\d.]+)"/.exec(played);
  assert.ok(needle, "the played mini band draws its needle");
  assert.ok(Math.abs(Number(needle[1]) - 2000 / 323) < 0.01, `2px wide (${needle[1]} units)`);
});

test("a show never takes ultramarine or the sky next to it, so the narration ticks stay distinguishable", () => {
  /* The Today band is 8px with no station codes, so colour is the only carrier. A
     single-show foray whose show hashed to enamel 2 (ultramarine, the colour 4a
     authored its narration in) drew a monochrome blue strip.
     MUTATION: in ui/primitives.js set TACTILE_SHOW_ENAMELS to [0, 1, 2, 3, 4, 5, 6, 7]
     -> this fails on the first show id that hashes to 2 or 6. */
  const seen = new Set();
  for (let n = 0; n < 400; n += 1) {
    const html = p.tactileBand({ id: "enamel-" + n, kind: "mini", renderWidth: 300, segments: [
      { showId: "show-" + n, show: "Show " + n, duration: 300 },
      { showId: "n", show: "", duration: 20, narration: true },
      { showId: "show-" + n, show: "Show " + n, duration: 300 },
    ] });
    const base = /<g class="t-band__base">([\s\S]*?)<\/g>/.exec(html)[1];
    for (const m of base.matchAll(/t-band__bar--c(\d)/g)) seen.add(Number(m[1]));
  }
  assert.deepStrictEqual([...seen].sort(), [0, 1, 3, 4, 5, 7], "all six show enamels are used, ultramarine (2) and sky (6) are not");
});

test("a three-way name collision resolves to three distinct codes, in the model and in the band", () => {
  // MUTATION: delete the `first.slice(0, 2)` and later-letter rungs from tactileStationCodes (stop at head + last[0]) ->
  //   Dashing falls back to a code Daily already holds and the distinct-codes assertion fails (the DA / DD / DD bug).
  const shows = [
    { id: "daily", name: "Daily" },
    { id: "daring", name: "Daring" },
    { id: "dashing", name: "Dashing" },
  ];
  const codes = p.tactileStationCodes(shows);
  assert.deepStrictEqual([...codes.values()], ["DA", "DD", "DS"]);
  assert.strictEqual(new Set(codes.values()).size, 3, "no two stations share a key");
  const trio = shows.map((s) => ({ showId: s.id, show: s.name, duration: 100 }));
  const html = p.tactileBand({ id: "trio", kind: "detail", segments: trio, renderWidth: 400 });
  const labels = [...html.matchAll(/class="t-band__code[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(labels, ["DA", "DD", "DS"], "the band draws the model's codes, not its own");
});

test("the Now Playing chip's codes (client.js dialForayCodes) are the band's codes for the same foray", () => {
  // MUTATION: put the old inline collision rule back in dialForayCodes (client.js) -> the chip says DA / DD / DA
  //   while the band says DA / DD / DS and this deepStrictEqual fails.
  const src = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8").replace(/\r\n/g, "\n");
  const lifted = ["dialStationCodeFor", "dialForayCodes"].map((name) => {
    const m = new RegExp("^function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}", "m").exec(src);
    assert.ok(m, `client.js still declares ${name}() at top level`);
    return m[0];
  }).join("\n");
  const ctx = load();
  require("node:vm").runInContext(lifted + "\nvar __codes = dialForayCodes;", ctx, { filename: "player/client.js (dialForayCodes)" });
  const foray = [
    ["daily", "Daily"], ["daring", "Daring"], ["dashing", "Dashing"],
    ["origin", "Origin Stories"], ["os", "Old Souls"], ["the-owl", "The Owl Show"],
  ];
  const chip = [...ctx.__codes(foray).values()];
  const html = ctx.tactileBand({
    id: "agree", kind: "detail", renderWidth: 1000,
    segments: foray.map(([showId, show]) => ({ showId, show, duration: 100 })),
  });
  const band = [...html.matchAll(/class="t-band__code[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(band, chip);
  assert.strictEqual(new Set(chip).size, foray.length, "and every station has its own code");
});

test("the detail needle is drawn in rendered pixels: 2px wide, a round 8px head, 6px past the bars at both ends", () => {
  /* The detail band is 60px tall in a 1000-unit-wide viewBox stretched to the card, so one y unit
     is a pixel and one x unit is renderWidth/1000 of one. The old needle (width 2, circle r 4) was
     0.64px wide with a 1.3px head at 329px: a stray hairline, not the playhead. Bars span y 8-36.
     MUTATION 1: set the rect back to `width="2"` -> the 2px width assertion fails.
     MUTATION 2: draw `<circle r="4">` instead of the ellipse -> the head assertion fails.
     MUTATION 3: shorten the rect to `height="39"` or move it to y="3" -> it stops short of the bars' bottom (36 + 6 = 42). */
  const w = 329;
  const html = p.tactileBand({ id: "needle", kind: "detail", segments, renderWidth: w, progress: 0.3 });
  const needle = /<g class="needle"[^>]*>([\s\S]*?)<\/g>/.exec(html)[1];
  const rect = /<rect x="(-?[\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(needle);
  assert.ok(rect, "a needle rect");
  const px = w / 1000;
  assert.ok(Math.abs(Number(rect[3]) * px - 2) < 0.02, `2px wide (${Number(rect[3]) * px}px)`);
  assert.ok(Math.abs(Number(rect[1]) * px + 1) < 0.02, "centred on its x");
  assert.strictEqual(Number(rect[2]), 2, "starts 6px above the bars' top (8)");
  assert.strictEqual(Number(rect[2]) + Number(rect[4]), 42, "ends 6px below the bars' bottom (36)");
  const head = /<ellipse cx="0" cy="3" rx="([\d.]+)" ry="([\d.]+)"/.exec(needle);
  assert.ok(head, "the head is an ellipse that undoes the stretch");
  assert.ok(Math.abs(Number(head[1]) * px - 4) < 0.02 && Number(head[2]) === 4, "an 8px round head on top of the needle");
  assert.match(rule(".band--detail"), /height:\s*calc\(var\(--tap\)\s*\+\s*var\(--s-4\)\)/, "60px: the unit the markup is drawn in");
  /* the scrubber's needle (Now Playing, accepted) is untouched */
  assert.match(p.tactileBand({ id: "scrub-needle", kind: "scrub", segments, renderWidth: w, progress: 0.3 }), /<rect x="-1" y="3" width="2" height="39" rx="1"><\/rect><circle cx="0" cy="3" r="4">/);
});

test("detail station codes are the 13px label step in the text face, undistorted by the stretched viewBox", () => {
  /* The codes were 12px mono in a viewBox stretched 0.33 on x and 0.73 on y: a ~9px squashed
     'PA' beside the prototype's 13px 700 label. The markup counter-scales on x (a glyph is as wide
     as it is tall) and the CSS names the label tokens.
     MUTATION 1: drop the `transform` from the detail <text> -> the scale assertion fails.
     MUTATION 2: in styles.css change `var(--t-label)` to `var(--t-micro)` (or --font-text to
     --font-mono) in `.band--detail .t-band__code` -> the rule assertion fails. */
  const w = 329;
  const html = p.tactileBand({ id: "codes", kind: "detail", segments, renderWidth: w, currentIndex: 4 });
  const texts = [...html.matchAll(/<text class="t-band__code[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(texts.length >= 2, "more than one run is labelled");
  for (const t of texts) {
    const m = /transform="translate\(([\d.]+) 53\) scale\(([\d.]+) 1\)"/.exec(t);
    assert.ok(m, `placed by transform: ${t}`);
    assert.ok(Math.abs(Number(m[2]) * w / 1000 - 1) < 0.001, `x scale 1000/${w} cancels the stretch (${m[2]})`);
  }
  const css = rule(".band--detail .t-band__code");
  assert.match(css, /font:\s*var\(--w-label\)\s+var\(--t-label\)\/1\s+var\(--font-text\)/, "the 13px / 700 label in the text face");
  const scrub = p.tactileBand({ id: "scrub-codes", kind: "scrub", segments, renderWidth: w });
  assert.doesNotMatch(scrub, /<text[^>]*transform=/, "the scrubber's codes are not re-placed");
});
