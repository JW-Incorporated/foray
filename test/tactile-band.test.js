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
  return [...first.matchAll(/data-segment-index="(\d+)" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
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

test("bars are separate rounded blocks a visible gap apart, at every render width", () => {
  /* Iteration 3 (fidelity): the bars abutted with a 2-unit seam, 0.7px on a 345px band, so the band read as one slab.
     The prototype's rhythm is a gap you can see (3px; 2px on the mini band) and a 3px corner. The viewBox is
     stretched non-uniformly, so the gap and the rx are converted from rendered px, and ry from the band's height.
     MUTATIONS: make tactileBandGap return 2 -> the gap-in-px assertion fails at 345 and 412; make
     tactileBandRadius return `rx: 2` -> the rendered-px radius assertion fails; drop the `Math.max(2, ...)` floor ->
     the 400-clip case (where gaps would otherwise eat the band) fails assertLayout's 2-unit minimum. */
  for (const width of [345, 361, 412]) {
    const boxes = p.tactileBandLayout(p.tactileBandSegments(segments), width, "scrub");
    for (let i = 1; i < boxes.length; i += 1) {
      const gapPx = (boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width)) / 1000 * width;
      assert.ok(Math.abs(gapPx - 3) < 0.01, `${width}px: bars ${i - 1} and ${i} sit ${gapPx.toFixed(2)}px apart, not 3`);
    }
    const html = p.tactileBand({ id: "round-" + width, kind: "scrub", segments, renderWidth: width });
    const first = /<rect class="t-band__bar t-band__bar--c\d" data-segment-index="0" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" rx="([\d.]+)" ry="([\d.]+)"/.exec(html);
    assert.ok(first, "the first bar carries rx and ry");
    assert.ok(Math.abs(Number(first[3]) / 1000 * width - 3) < 0.02, `${width}px: rx is 3 rendered px (${first[3]} units)`);
    assert.ok(Math.abs(Number(first[4]) * 64 / 60 - 3) < 0.02, `${width}px: ry is 3 rendered px on the 64px stage (${first[4]} units)`);
    /* The prototype's scrub bar: 6px down the 64px stage, 28px tall, so the codes sit 4px under it
       and 10px of well remain beneath them (the build once drew 8.5px / 29.9px).
       MUTATION: set TACTILE_BAND_BAR.scrub back to { y: 8, h: 28 } in ui/primitives.js -> 8.53px / 29.87px fails. */
    assert.ok(Math.abs(Number(first[1]) * 64 / 60 - 6) < 0.02, `${width}px: the bar starts 6px down the stage (${first[1]} units)`);
    assert.ok(Math.abs(Number(first[2]) * 64 / 60 - 28) < 0.02, `${width}px: the bar is 28px tall (${first[2]} units)`);
  }
  const mini = p.tactileBandLayout(p.tactileBandSegments(segments), 345, "mini");
  assert.ok(Math.abs((mini[1].x - (mini[0].x + mini[0].width)) / 1000 * 345 - 2) < 0.01, "the 8px mini band keeps a 2px gap");
  /* A crowd of clips never takes more than a quarter of the band for gaps until it hits the 2-unit floor. */
  const dense = p.tactileBandSegments(Array.from({ length: 60 }, (_, i) => ({ showId: "s" + (i % 5), show: "Show " + (i % 5), duration: 60 })));
  const denseBoxes = p.tactileBandLayout(dense, 345, "scrub");
  const gaps = denseBoxes[denseBoxes.length - 1].x + denseBoxes[denseBoxes.length - 1].width - denseBoxes.reduce((sum, b) => sum + b.width, 0);
  assert.ok(gaps <= 250.001, `sixty clips spend ${gaps.toFixed(1)} units on gaps, a quarter of the band at most`);
});

test("the narration hatch is drawn in screen pixels, 45 degrees, ultramarine on its soft tint", () => {
  /* The 0-1000 viewBox is stretched to the band's width and height, so a pattern in raw units skews: the old 12-unit
     pattern drew 4px-wide steep slivers at 345px. The pattern now counter-scales by the render width and the stage
     height, then rotates, so 3px lines and 3px gaps stay 45 degrees at any width, over a soft ultramarine ground.
     MUTATIONS: drop the `scale(...)` from patternTransform -> the scale assertion fails; remove the
     `t-band__hatch-bg` rect -> the ground assertion fails; delete the `.t-band__hatch-bg` CSS rule -> the token
     assertion fails. */
  for (const [kind, stage] of [["detail", 44], ["scrub", 64]]) {
    const html = p.tactileBand({ id: "hatch-" + kind, kind, segments, renderWidth: 400 });
    const m = /<pattern id="hatch-[a-z]+-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="scale\(([\d.]+) ([\d.]+)\) rotate\(45\)">/.exec(html);
    assert.ok(m, `${kind}: a 6px pattern, scaled then rotated 45 degrees`);
    assert.ok(Math.abs(Number(m[1]) * 400 / 1000 - 1) < 0.001, `${kind}: x is counter-scaled by the 400px render width`);
    assert.ok(Math.abs(Number(m[2]) * stage / 60 - 1) < 0.001, `${kind}: y is counter-scaled by the ${stage}px stage`);
    assert.match(html, /<rect width="6" height="6" class="t-band__hatch-bg"><\/rect><rect width="3" height="6" class="t-band__hatch"><\/rect>/, `${kind}: 3px line over a full ground`);
  }
  assert.match(rule(".t-band__hatch-bg"), /fill:\s*var\(--ultramarine-soft\)/);
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
  scrubber.listeners.pointermove({ clientX: 90, pointerId: 7, preventDefault() {} });
  /* 80% of a 100px well with 3px gaps (30 units each at this width) lands 0.574 of the way through the last bar:
     79 s, not the 80 the old 2-unit hairline gaps gave. */
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
