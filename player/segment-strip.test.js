/* The SegmentStrip (#128), against the REAL running orders.
 *
 * WHY REAL DATA, NOT FIXTURES
 * This element exists to answer one founder sentence about the live site — "it's
 * certainly not clear that it's more than one podcast... I have no clue how they
 * relate" — and a hand-made fixture is exactly the thing that cannot fail that
 * way. `data/forays.json` has two running orders with the shape the element is
 * for, and they are not interchangeable:
 *
 *   grilling-history-2   10 segments, 22 min, 6 episodes, every seam a new one
 *   capital-types-1      22 segments, 51 min, 8 episodes, 10 of the 21 seams
 *                        cross-episode — and three separate runs of THE SAME
 *                        SHOW from two different episodes, which is the case a
 *                        strip that groups by show gets wrong and cannot notice
 *
 * Counts are read off the resolved Foray rather than pinned, following
 * foray-playback.test.js (#236): a curator must be able to change a running
 * order without editing this file. Where a specific real property is the point
 * of the test — that some seams are within an episode and some are not — it is
 * asserted as a property ("both kinds occur"), not as a number.
 *
 * WHY THE ASSERTIONS ARE ON SERIALIZED DOM
 * The trap for a rendering component is asserting on a string the source merely
 * CONTAINS: a test that greps for `is-run-start` passes when the only
 * `is-run-start` in the file is in a comment. So the DOM tests below render
 * through a stub and assert on `html(el)` — the tree that was actually built.
 * The stub is deliberately hostile in one direction: `setAttribute("style", …)`
 * throws, because the page CSP is `style-src 'self'` and a component that
 * reached for a style attribute must fail here rather than in a browser.
 *
 * EVERY TEST BELOW NAMES THE MUTATION THAT KILLS IT, and every one of those was
 * applied and run (CLAUDE.md § "A green test is not evidence until you have
 * broken it").
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveForay, indexSegments, indexSources, findForay, segmentStarts,
} from "./foray-resolve.js";
import { itemRuntimeSec } from "./foray-queue.js";
import {
  stripModel, stripSummary, mountStrip, renderStrip, assignTones, toneSeed,
  sourceKeyOf, isNarration, growOf, TONE_COUNT, NARRATOR_SOURCE, SIZES,
} from "./segment-strip.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const FORAYS = readJson("data/forays.json");
const SEGMENTS = readJson("data/segments.json");
const SOURCES = readJson("data/segment-sources.json");

/** Both committed running orders, by id. Drafts, so each is opened by name. */
const REAL_IDS = ["grilling-history-2", "capital-types-1"];

function realDoc(id) {
  const doc = findForay(FORAYS, id, { unlocked: [id] });
  assert.ok(doc, `${id} must exist in data/forays.json`);
  return doc;
}

function resolveDoc(doc) {
  return resolveForay(doc, {
    segments: indexSegments(SEGMENTS),
    sources: indexSources(SOURCES),
  });
}

const real = (id) => resolveDoc(realDoc(id));

/** A narrator bridge in the shape `data/forays.json` authors one (#260/#287):
    `type: "narration"` with an asset, which is what `buildForayQueue` requires
    and what turns into `kind: "tts"` on the queue. No committed Foray has one
    yet, so the running orders below are REAL orders with bridges inserted —
    real tape, real seams, authored narration on top. */
const bridge = (id, slot) => ({
  type: "narration", id, slot,
  asset: `https://cdn.test/${id}.mp3`,
  duration_sec: 9,
});

/** The real running order with bridges spliced in BEFORE the named positions.
    A position repeated in the list inserts that many bridges there, which is how
    the consecutive-bridges case below gets two in a row. */
function withBridges(id, positions) {
  const doc = realDoc(id);
  const items = [];
  doc.items.forEach((item, i) => {
    positions.filter((p) => p === i)
      .forEach((_, n) => items.push(bridge(`nar-${i}-${n}`, item.slot)));
    items.push(item);
  });
  return resolveDoc({ ...doc, items });
}

/** Cross-episode boundaries counted INDEPENDENTLY of the strip: off the
    hydrated entries' `item_id`, which is a different field on a different
    object from the `source_item_id` the strip groups on. Two paths to the same
    number, so the test is not the implementation restated. */
function crossEpisodeBoundaries(r) {
  const eps = r.entries.filter((e) => e.playable).map((e) => e.item_id ?? null);
  let n = 0;
  for (let i = 1; i < eps.length; i++) if (eps[i] !== eps[i - 1]) n++;
  return n;
}

/* ---------- a strict, serializable DOM ---------- */

class StubStyle {}

class StubEl {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.attrs = new Map();
    this.children = [];
    this.style = new StubStyle();
  }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) {
    if (String(name).toLowerCase() === "style") {
      throw new Error(
        "a style attribute is blocked by the page CSP (style-src 'self') and by " +
        "test/app-security.test.js — set a CSSOM property instead"
      );
    }
    this.attrs.set(String(name), String(value));
  }
  getAttribute(name) { return this.attrs.has(String(name)) ? this.attrs.get(String(name)) : null; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error("removeChild: not a child of this node");
    this.children.splice(i, 1);
    return child;
  }
  get classList() {
    const el = this;
    const list = () => (el.className ? el.className.split(/\s+/).filter(Boolean) : []);
    const write = (arr) => { el.className = [...new Set(arr)].join(" "); };
    return {
      add: (...c) => write([...list(), ...c]),
      remove: (...c) => write(list().filter((x) => !c.includes(x))),
      contains: (c) => list().includes(c),
      toggle: (c, force) => {
        const on = force === undefined ? !list().includes(c) : Boolean(force);
        write(on ? [...list(), c] : list().filter((x) => x !== c));
        return on;
      },
    };
  }
}

const stubDocument = { createElement: (tag) => new StubEl(tag) };

/** The tree that was actually built. CSSOM properties are serialized as
    `cssom(...)` and deliberately NOT as `style="..."`, so a test looking for the
    absence of an inline style attribute is looking at something real. */
function html(el) {
  const cls = el.className ? ` class="${el.className}"` : "";
  const attrs = [...el.attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
  const css = Object.keys(el.style).map((k) => `${k}:${el.style[k]}`).join(";");
  const kids = el.children.map(html).join("");
  return `<${el.tagName}${cls}${attrs}${css ? ` cssom(${css})` : ""}>${kids}</${el.tagName}>`;
}

/** Every class on every bar, in order, from the RENDERED markup rather than
    from the model — the two are only the same if the renderer is correct, which
    is the thing under test. */
function renderedBarClasses(markup) {
  return [...markup.matchAll(/<span class="([^"]*)"/g)].map((m) => m[1].split(" "));
}

function mount(items, opts = {}) {
  const el = new StubEl("div");
  const model = mountStrip(el, items, { document: stubDocument, ...opts });
  return { el, model, markup: html(el) };
}

/* ---------- 1. the seam: the whole point of the element ---------- */

for (const id of REAL_IDS) {
  test(`${id}: a capsule boundary is exactly a cross-episode seam`, () => {
    const r = real(id);
    const model = stripModel(r.playable);
    const boundaries = crossEpisodeBoundaries(r);

    // Both kinds of seam must actually occur in this data, or the test is
    // asserting nothing: a running order where every seam crosses episodes
    // would pass a strip that drew a gap between every segment.
    assert.ok(boundaries > 0, `${id} has no cross-episode seam to show`);
    assert.ok(
      boundaries < r.playable.length - 1,
      `${id} has no WITHIN-episode seam, so it cannot show that a capsule holds together`
    );

    assert.equal(model.runs.length, boundaries + 1, "one capsule per source episode run");
    assert.equal(
      model.segments.filter((s) => s.runStart).length, boundaries + 1,
      "a capsule opens at each cross-episode seam and at the start"
    );
    /* MUTATION (killed): in stripModel, `const runStart = index === 0 || keys[index - 1] !== key;`
       -> `const runStart = index === 0;`. One capsule for the whole Foray:
       runs.length 1 vs 11 on capital-types-1, 1 vs 6 on grilling-history-2. */
  });
}

test("two episodes of the SAME show are two capsules, not one", () => {
  /* The case that makes "group by episode" different from "group by show", and
     it is real: capital-types-1 runs The Bootstrapped Founder, another episode
     of it, then back — three consecutive capsules, one show, two episodes. A
     strip grouped by show paints those as one block and silently deletes two of
     the hard cuts the listener hears. */
  const r = real("capital-types-1");
  const model = stripModel(r.playable);

  /* Counted twice from the queue itself, never from the model: once by source
     EPISODE, which is what a capsule is, and once by SHOW, which is what the
     tempting simplification would produce. */
  const runsOver = (values) => values.reduce((n, v, i) => (i > 0 && v !== values[i - 1] ? n + 1 : n), 1);
  const byEpisode = runsOver(r.playable.map((i) => i.source_item_id));
  const byShow = runsOver(r.playable.map((i) => i.show));

  // The data has to actually revisit a show, or this test asserts nothing.
  const episodesPerShow = new Map();
  for (const item of r.playable) {
    if (!item.show) continue;
    if (!episodesPerShow.has(item.show)) episodesPerShow.set(item.show, new Set());
    episodesPerShow.get(item.show).add(item.source_item_id);
  }
  const revisited = [...episodesPerShow].filter(([, eps]) => eps.size > 1);
  assert.ok(
    revisited.length > 0,
    "capital-types-1 is supposed to run two episodes of one show; if the data " +
    "changed, this test needs a running order that still does"
  );
  assert.ok(byShow < byEpisode, "the two groupings must actually disagree here");

  assert.equal(model.runs.length, byEpisode, "a capsule is a source episode");
  assert.notEqual(model.runs.length, byShow, "grouping by show erases real hard cuts");
  /* MUTATION (killed): in sourceKeyOf, put `item.show` first in the fallback
     chain. The three Bootstrapped Founder capsules merge into one, model.runs
     drops 11 -> 9, and both final assertions fail — 9 is exactly the by-show
     count, which is the point. */
});

test("the seam is visible in the rendered markup without any colour class", () => {
  const r = real("capital-types-1");
  const { markup, model } = mount(r.playable);
  // Strip every hue: what is left must still mark each capsule boundary. This
  // is the accessibility requirement stated as an assertion — the distinction
  // cannot be a difference in hue.
  const greyscale = markup.replace(/\bfy-t\d+\b/g, "");
  const opens = (greyscale.match(/\bis-run-start\b/g) || []).length;
  const closes = (greyscale.match(/\bis-run-end\b/g) || []).length;
  assert.equal(opens, model.runs.length);
  assert.equal(closes, model.runs.length);
  assert.ok(opens > 1, "a single capsule would prove nothing");
  /* MUTATION (killed): in paintSegments, delete
     `if (seg.runStart) classes.push("is-run-start");`. opens = 0 vs 11. */
});

/* ---------- 2. proportional to duration ---------- */

test("each bar's width is its item's runtime, measured by the player's own rule", () => {
  const r = real("capital-types-1");
  const model = stripModel(r.playable);
  assert.deepEqual(
    model.segments.map((s) => s.grow),
    r.playable.map((i) => Math.max(1, Math.round(itemRuntimeSec(i)))),
    "the strip must measure an item exactly as foray-queue.js does"
  );
  // And the proportion is real, not decorative: the longest item on this Foray
  // is over three times the shortest.
  const grows = model.segments.map((s) => s.grow);
  assert.ok(Math.max(...grows) > 3 * Math.min(...grows));
  /* MUTATION (killed): `growOf` -> `return 1;`. Every bar the same width; the
     deepEqual fails at index 0 (1 vs 137) and the ratio assertion fails too. */
});

test("shares are a partition of the runtime and match the cumulative starts", () => {
  const r = real("grilling-history-2");
  const model = stripModel(r.playable);
  const total = model.segments.reduce((t, s) => t + s.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}`);
  assert.deepEqual(
    model.segments.map((s) => s.startSec),
    segmentStarts(r.playable),
    "a bar's start must be the Foray clock's start for that item"
  );
  /* The per-bar check below is not redundant with the sum. `share: 1 / n` also
     sums to 1 — an equal-width strip that passes a total-only test while
     claiming a 238 s segment and an 80 s one are the same size. That is the
     whole failure this element exists to avoid, so it is asserted bar by bar. */
  for (const s of model.segments) {
    assert.ok(Math.abs(s.share - s.lengthSec / model.totalSec) < 1e-12, `share of bar ${s.index}`);
  }
  /* MUTATION (killed): in stripModel, `share: totalSec > 0 ? lengthSec / totalSec : 0`
     -> `share: 1 / list.length`. The sum stays 1; the per-bar loop fails at bar 0
     (0.1163 vs 0.1). */
});

/* ---------- 3. narration is an item, not a gap ---------- */

test("a narrator bridge is a first-class bar: sized, counted, its own capsule", () => {
  /* Spliced into the middle of a WITHIN-episode run (positions 3 and 5 of
     capital-types-1 sit inside runs of the same episode), which is the case
     that separates "narration is an item" from "narration is a seam". */
  const r = withBridges("capital-types-1", [3, 5]);
  const model = stripModel(r.playable);
  const bridges = model.segments.filter((s) => s.kind === "narration");

  assert.equal(bridges.length, 2, "both bridges reached the queue");
  assert.equal(model.narrationCount, 2);
  assert.equal(model.segmentCount, model.segments.length - 2, "a bridge is not tape");
  for (const b of bridges) {
    assert.equal(b.tone, null, "a bridge has no show tone");
    assert.ok(b.lengthSec > 0, "a bridge with no length is a bridge nobody can see");
    assert.ok(b.grow >= 1);
    assert.ok(b.runStart && b.runEnd, "a bridge between two segments is its own capsule");
    assert.ok(!model.shows.includes(b.show), "a bridge must not be credited as a show");
  }
  assert.equal(
    model.sourceCount, stripModel(real("capital-types-1").playable).sourceCount,
    "adding narration must not change how many source episodes the Foray draws on"
  );
  /* MUTATION (killed): `isNarration` -> `return false;`. The bridges are counted
     as tape (segmentCount 24 vs 22), get a tone, and sourceCount rises 8 -> 10. */
});

test("consecutive bridges are one capsule; a bridge never merges with a segment", () => {
  // Two bridges back to back are still "the narrator", so they read as one
  // block — the same rule that makes two segments of one episode one capsule.
  const r = withBridges("capital-types-1", [4, 4]);
  const model = stripModel(r.playable);
  const narr = model.segments.filter((s) => s.kind === "narration");
  assert.equal(narr.length, 2, "the fixture must actually produce two adjacent bridges");
  assert.equal(narr[1].index, narr[0].index + 1);
  assert.equal(narr[0].runStart, true);
  assert.equal(narr[0].runEnd, false, "the second bridge continues the first's capsule");
  assert.equal(narr[1].runEnd, true);
  assert.equal(model.segments[narr[0].index - 1].runEnd, true, "the segment before it closes");
  assert.equal(model.segments[narr[1].index + 1].runStart, true, "the segment after it opens");
  /* MUTATION (killed): in sourceKeyOf, delete
     `if (isNarration(item)) return NARRATOR_SOURCE;`. Each bridge then keys on
     its own asset URL, so two adjacent bridges become two capsules and
     `narr[0].runEnd` is true instead of false. */
});

test("a bridge renders hatched, not merely tinted", () => {
  const r = withBridges("grilling-history-2", [2]);
  const { markup } = mount(r.playable);
  const bars = renderedBarClasses(markup);
  const narrBars = bars.filter((c) => c.includes("fy-seg--narration"));
  assert.equal(narrBars.length, 1);
  assert.deepEqual(
    narrBars[0].filter((c) => /^fy-t\d+$/.test(c)), [],
    "a bridge must not also claim a show tone — styles.css hatches .fy-seg--narration, " +
    "and a tone class would paint over the one cue that survives greyscale"
  );
  /* MUTATION (killed): in paintSegments, `classes.push("fy-seg--narration")`
     -> `classes.push("fy-t2")`. narrBars.length 0 vs 1. */
});

test("an item with no identifiable episode joins the capsule it is next to", () => {
  /* `sourceKeyOf`'s last resort. It used to fall through to `item.id`, which on
     a built queue item is `${forayId}#${ord}` — a POSITION, unique per item — so
     a running order that lost its episode ids would render as one capsule per
     segment and spend a seam gap on every one of them. That is the whitespace
     failure the component's own header rejects, arrived at by accident.

     Not reachable from `data/forays.json` (every real item carries a
     `source_item_id`), which is exactly why it is constructed here: a decision no
     fixture can exercise is a decision no test protects. */
  const anonymous = [
    { kind: "episode", start_sec: 0, end_sec: 100 },
    { kind: "episode", start_sec: 0, end_sec: 200 },
    { kind: "episode", start_sec: 0, end_sec: 150 },
  ];
  assert.equal(sourceKeyOf({ id: "foray#3", kind: "episode" }), "");
  const model = stripModel(anonymous);
  assert.equal(model.runs.length, 1, "unidentifiable items must not each become a capsule");
  assert.deepEqual(model.segments.map((s) => s.runStart), [true, false, false]);
  // And an episode id still wins when there is one, so the fallback is a floor.
  assert.equal(sourceKeyOf({ source_item_id: "ep-a", id: "foray#3" }), "ep-a");
  /* MUTATION (killed): in sourceKeyOf, put `item?.id` back on the end of the
     chain. runs.length comes back 3 and every bar claims to open a capsule. */
});

/* ---------- 4. where the listener is ---------- */

test("position: past is full, current is partial, upcoming is empty", () => {
  const r = real("capital-types-1");
  const starts = segmentStarts(r.playable);
  const target = 5;
  const len = itemRuntimeSec(r.playable[target]);
  const model = stripModel(r.playable, { elapsed: starts[target] + len * 0.25 });

  assert.equal(model.positioned, true);
  assert.equal(model.currentIndex, target);
  assert.ok(Math.abs(model.segments[target].progress - 0.25) < 1e-9);
  assert.equal(model.segments[target].state, "current");
  for (let i = 0; i < target; i++) {
    assert.equal(model.segments[i].state, "past");
    assert.equal(model.segments[i].progress, 1);
  }
  for (let i = target + 1; i < model.segments.length; i++) {
    assert.equal(model.segments[i].state, "upcoming");
    assert.equal(model.segments[i].progress, 0);
  }
  /* MUTATION (killed): in stripModel,
     `progress = lengthSec > 0 ? clamp01(at.into / lengthSec) : 0;` -> `progress = 1;`.
     The current bar reads full at a quarter in (1 vs 0.25). */
});

test("no position and position zero are different states", () => {
  const r = real("grilling-history-2");

  const browsing = stripModel(r.playable, { elapsed: null });
  assert.equal(browsing.positioned, false);
  assert.equal(browsing.currentIndex, null);
  assert.deepEqual([...new Set(browsing.segments.map((s) => s.state))], ["idle"]);
  assert.deepEqual([...new Set(browsing.segments.map((s) => s.progress))], [0]);

  const atStart = stripModel(r.playable, { elapsed: 0 });
  assert.equal(atStart.positioned, true);
  assert.equal(atStart.currentIndex, 0);
  assert.equal(atStart.segments[0].state, "current");
  assert.equal(atStart.segments[1].state, "upcoming");
  /* MUTATION (killed): in stripModel,
     `const positioned = isNum(elapsed) && elapsed >= 0 && list.length > 0;`
     -> `const positioned = list.length > 0;`. Browsing renders as a progress
     meter with everything ahead dimmed: positioned true, states "current"/"upcoming". */
});

test("the model's own clock never runs past the Foray", () => {
  const r = real("grilling-history-2");
  const model = stripModel(r.playable, { elapsed: 99999 });
  assert.equal(model.elapsedSec, model.totalSec);
  assert.equal(model.currentIndex, model.segments.length - 1);
  /* MUTATION (killed): `elapsedSec: positioned ? Math.min(Math.max(0, elapsed), totalSec) : 0`
     -> `elapsedSec: positioned ? elapsed : 0`. 99999 vs 1315.93, and the
     accessible label then says "1:39:59 in" on a 22-minute Foray. */
});

test("rendered position: one ring, and the dimming only when somebody is here", () => {
  const r = real("capital-types-1");
  const starts = segmentStarts(r.playable);

  const live = mount(r.playable, { elapsed: starts[7] + 5, playing: true });
  assert.ok(live.el.classList.contains("has-position"));
  const bars = renderedBarClasses(live.markup);
  assert.equal(bars.filter((c) => c.includes("is-playing")).length, 1);
  assert.equal(bars.filter((c) => c.includes("is-played")).length, 7);
  /* `is-here` marks the bar the listener is INSIDE, which is a different claim
     from "audio is running". CSS hangs the progress fill and the full opacity on
     it, so a cold resume can show its position without the page claiming to be
     playing. */
  assert.deepEqual(
    bars.map((c, i) => (c.includes("is-here") ? i : -1)).filter((i) => i >= 0),
    [7]
  );

  /* A POSITION IS NOT PLAYBACK. Mounted from a stored resume point — a position,
     nothing running — the bar the listener is inside is `is-here` and must NOT
     be `is-playing`: the ring means audio, and a ring on a stopped Foray is the
     page claiming to play. This is the case #133 mounts from, so it is pinned
     before #133 rather than after it. */
  const stored = mount(r.playable, { elapsed: starts[7] + 5 });
  const storedBars = renderedBarClasses(stored.markup);
  assert.equal(storedBars.filter((c) => c.includes("is-playing")).length, 0);
  assert.deepEqual(
    storedBars.map((c, i) => (c.includes("is-here") ? i : -1)).filter((i) => i >= 0),
    [7]
  );

  const browsing = mount(r.playable);
  assert.equal(browsing.el.classList.contains("has-position"), false);
  const idle = renderedBarClasses(browsing.markup);
  assert.equal(idle.filter((c) => c.includes("is-playing")).length, 0);
  assert.equal(idle.filter((c) => c.includes("is-played")).length, 0);
  /* MUTATION (killed): in mountStrip,
     `el.classList.toggle("has-position", Boolean(model.positioned))` -> `..., true)`.
     The browsing strip claims a position, and CSS dims all 22 bars to 0.28.
     MUTATION (killed): in paintSegments, drop the `is-here` push. The fill and
     the full opacity then have nothing to hang on and the bar the listener is
     inside renders dim and empty.
     MUTATION (killed): in paintSegments, `if (playing) classes.push("is-playing")`
     -> `classes.push("is-playing")`. A strip mounted from a STORED position draws
     the ring, i.e. a stopped Foray drawn as a playing one. */
});

/* ---------- 5. tones: deterministic, and never two the same side by side ---------- */

for (const id of REAL_IDS) {
  test(`${id}: no two touching capsules share a tone`, () => {
    const model = stripModel(real(id).playable);
    for (let i = 1; i < model.runs.length; i++) {
      assert.notEqual(
        model.runs[i].tone, model.runs[i - 1].tone,
        `capsules ${i - 1} and ${i} are the same colour, which reads as one capsule`
      );
    }
    assert.ok(model.runs.every((x) => x.tone >= 0 && x.tone < TONE_COUNT));
    /* MUTATION (killed): in assignTones, delete the probe-forward loop
       (`for (let probe = 0; …) tone = (tone + 1) % TONE_COUNT;`). A bare hash of
       capital-types-1's 8 episodes puts tbf-328 and ftb-89 both on tone 2, and
       those two capsules are adjacent — 22 minutes of the Foray render as one
       colour across a seam. grilling-history-2 stays green, which is why both
       running orders are covered. */
  });
}

test("tone assignment is deterministic and prefers the hash", () => {
  const keys = [...new Set(real("grilling-history-2").playable.map(sourceKeyOf))];
  const a = assignTones(keys);
  const b = assignTones(keys);
  assert.deepEqual([...a], [...b], "the same running order must colour the same way twice");
  assert.equal(a.get(keys[0]), toneSeed(keys[0]) % TONE_COUNT,
    "an uncontested show keeps the tone its id hashes to");
  assert.equal(assignTones([NARRATOR_SOURCE]).size, 0, "the narrator does not spend a show tone");
  /* MUTATION (killed): in assignTones, `out.set(key, tone)` ->
     `out.set(key, used.size % TONE_COUNT)`. Still deterministic, so the first
     assertion survives; the hash preference is gone and the second fails
     (0 vs 2), which is what makes a show the same colour across Forays. */
});

/* ---------- 6. what it is to a screen reader, and to the CSP ---------- */

test("the strip is a labelled graphic, and the label says what the picture says", () => {
  const r = real("capital-types-1");
  const { el, model } = mount(r.playable);
  assert.equal(el.getAttribute("role"), "img");
  /* NOT focusable, deliberately. `role="img"` plus a label is reached by a
     browse cursor without a tab stop, so a tabindex buys a screen-reader user
     nothing and costs a sighted keyboard user a focus ring on an element with no
     keyboard action — the scrub is a pointer gesture and the per-segment jump is
     the running-order rows. Pinned so it is not added back as an
     "accessibility improvement". */
  assert.equal(el.getAttribute("tabindex"), null);
  const label = el.getAttribute("aria-label");
  assert.equal(label, stripSummary(model));
  assert.match(label, /^Running order: \d+ segments from \d+ shows, \d+ min in all\.$/);
  assert.ok(label.includes(`${model.segmentCount} segments`));
  assert.ok(label.includes(`${model.shows.length} shows`));
  /* MUTATION (killed): in mountStrip,
     `el.setAttribute("aria-label", stripSummary(model))` -> `…, "Segment strip")`.
     A screen reader hears the element's name and nothing about the Foray.
     MUTATION (killed): add `el.setAttribute("tabindex", "0")` back. */
});

test("the label carries the position and the bridges when there are any", () => {
  const r = withBridges("grilling-history-2", [2, 6]);
  const starts = segmentStarts(r.playable);
  const model = stripModel(r.playable, { elapsed: starts[4] + 10 });
  const label = stripSummary(model);
  assert.ok(label.includes("2 narrator bridges"), label);
  assert.ok(label.includes(`piece ${model.currentIndex + 1} of ${model.segments.length}`), label);
  assert.ok(label.includes(model.segments[model.currentIndex].show), label);

  const quiet = stripSummary(stripModel(real("grilling-history-2").playable));
  assert.ok(!quiet.includes("bridge"), "a Foray with no narration must not mention it");
  assert.ok(!quiet.includes("Now on"), "a Foray nobody is playing has no position to report");
  /* MUTATION (killed): in stripSummary, delete the
     `if (m.narrationCount > 0) parts.push(...)` block. The two bridges the
     listener hears are absent from the only description of the strip. */
});

test("nothing is ever written as a style attribute", () => {
  // The stub throws on setAttribute("style", …). This is the CSP invariant
  // (style-src 'self') expressed where it can actually fail.
  const r = real("capital-types-1");
  const { markup } = mount(r.playable, { elapsed: 300 });
  assert.ok(!markup.includes(' style="'), markup.slice(0, 200));
  assert.match(markup, /cssom\(flexGrow:\d+\)/, "widths must still be set, as CSSOM");
  /* MUTATION (killed): in paintSegments, `bar.style.flexGrow = String(seg.grow);`
     -> `bar.setAttribute("style", "flex-grow:" + seg.grow);`. The stub throws
     and the test errors with the CSP message. */
});

test("the markup is the flat shape app.js's live painter walks", () => {
  /* `paintSegFill`/`fillOf` in app.js reach `strip.children[i].children[0]` four
     times a second. Grouping the capsules in wrapper elements is the obvious
     structure and would break both silently — children[i] stops being segment i
     and the fill stops moving — so the flatness is a contract, pinned here. */
  const r = real("capital-types-1");
  const { el } = mount(r.playable);
  assert.equal(el.children.length, r.playable.length);
  el.children.forEach((bar, i) => {
    assert.equal(bar.tagName, "span");
    assert.ok(bar.classList.contains("fy-seg"), `bar ${i} is not a .fy-seg`);
    assert.equal(bar.getAttribute("data-seg"), String(i), "data-seg must be the queue index");
    assert.equal(bar.children.length, 1);
    assert.equal(bar.children[0].className, "fy-seg-fill");
    assert.equal(bar.children[0].children.length, 0);
  });
  /* MUTATION (killed): in paintSegments, append each bar to a per-run wrapper
     (`if (seg.runStart) group = doc.createElement("span"), parent.appendChild(group)`)
     instead of to `parent`. children.length 11 vs 22 and every index assertion
     fails — which is exactly what app.js would have done at runtime, silently. */
});

test("a re-mount replaces the strip rather than growing it", () => {
  const r = real("grilling-history-2");
  const el = new StubEl("div");
  mountStrip(el, r.playable, { document: stubDocument, size: "sm" });
  mountStrip(el, r.playable, { document: stubDocument, size: "lg" });
  assert.equal(el.children.length, r.playable.length, "the first render must be cleared");
  const sizes = SIZES.filter((s) => el.classList.contains(`fy-strip--${s}`));
  assert.deepEqual(sizes, ["lg"], "exactly one size class survives a re-mount");
  /* MUTATION (killed): in mountStrip, delete the
     `for (const other of SIZES) if (other !== chosen) el.classList.remove(...)` line.
     sizes comes back ["sm","lg"] and the strip is 5px and 12px tall at once. */
});

test("renderStrip builds a standalone strip at each of the three sizes", () => {
  const r = real("grilling-history-2");
  for (const size of SIZES) {
    const el = renderStrip(r.playable, { document: stubDocument, size });
    assert.ok(el, `no element at size ${size}`);
    assert.ok(el.classList.contains("fy-strip"));
    assert.ok(el.classList.contains(`fy-strip--${size}`));
    assert.equal(el.children.length, r.playable.length);
  }
  assert.equal(renderStrip(r.playable, {}), null, "no document, no element — and no throw");
  /* MUTATION (killed): in mountStrip,
     `const chosen = SIZES.includes(size) ? size : "md";` -> `const chosen = "md";`.
     Every size renders as the card size; the sm and lg assertions fail. */
});

test("an empty or broken running order renders nothing rather than throwing", () => {
  for (const input of [[], null, undefined, [null, 7, "x"]]) {
    const { el, model } = mount(input);
    assert.equal(el.children.length, 0);
    assert.equal(model.totalSec, 0);
    assert.equal(model.runs.length, 0);
    assert.equal(stripSummary(model), "Running order: nothing to play.");
  }
  /* MUTATION (killed): in stripModel, `const list = Array.isArray(items) ? items.filter(...)`
     -> `const list = items ?? [];`. `null ?? []` is `[]`, so the null case
     survives — what dies is `[null, 7, "x"]`, which renders three bars and throws
     reading `.show` off the null. Stated precisely, because a mutation note that
     names the wrong mechanism is one nobody can re-run. */
});

/* ---------- 7. the palette is measured, in both themes ---------- */

const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

/** The stylesheet with every `prefers-color-scheme: light` block removed — what
    a dark-theme browser sees. Brace-counted rather than regex-matched: the first
    version of this looked for a `}` newline `}` pair, which occurs ZERO times in
    styles.css because a nested block closes as two spaces, `}`, newline, `}`. The
    replace was a no-op, both themes read the same text, and the test named "in
    both themes" measured the light one twice — it would have passed a dark
    `--seg-c4` of #101820, which is 1.03:1 on #0d1117 and is a bar that is not
    there. Review caught that; the mutation battery had not, because the mutation
    tried was on the light side, the one that happened to be live. */
function withoutLightBlocks(css) {
  const marker = "@media (prefers-color-scheme: light)";
  let out = css;
  for (;;) {
    const start = out.indexOf(marker);
    if (start < 0) return out;
    let i = out.indexOf("{", start);
    assert.ok(i > 0, "a light media query with no body");
    let depth = 0;
    for (; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) break;
    }
    assert.equal(depth, 0, "unbalanced braces in styles.css");
    out = out.slice(0, start) + out.slice(i + 1);
  }
}

const CSS_DARK = withoutLightBlocks(CSS);

/** Strips `body.ui-v2 { ... }` blocks (U-01, docs/ui-transition-plan.md).
    That scope deliberately reuses several v1 token NAMES (`--bg`, `--surface`,
    `--text`, `--line`) with different values, so a naive last-match-wins scan
    over the whole file would start reading the v2 value for a v1 (flag-off)
    measurement the moment ui-v2 shipped. Everything in this suite measures the
    stylesheet a v1 page (no `body.ui-v2` class) actually resolves, so the v2
    scope must never be part of what `cssVar` sees. Brace-counted for the same
    reason `withoutLightBlocks` is above it. */
function withoutUiV2Blocks(css) {
  const marker = "body.ui-v2 {";
  let out = css;
  for (;;) {
    const start = out.indexOf(marker);
    if (start < 0) return out;
    let i = out.indexOf("{", start);
    assert.ok(i > 0, "a body.ui-v2 block with no body");
    let depth = 0;
    for (; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) break;
    }
    assert.equal(depth, 0, "unbalanced braces in styles.css");
    out = out.slice(0, start) + out.slice(i + 1);
  }
}

/** The stylesheet as one theme resolves it. Named once and used by everything
    below: two copies of this expression is how the light branch stayed inert in
    one of them while the other was fixed. Both branches also drop the ui-v2
    scope, per withoutUiV2Blocks above — a v1 page never carries `body.ui-v2`. */
const scopeFor = (light) => withoutUiV2Blocks(light ? CSS : CSS_DARK);

/** Declared value of a custom property as the named theme resolves it: the LAST
    winning declaration, which is how a browser cascades it. */
function cssVar(name, { light = false } = {}) {
  const scope = scopeFor(light);
  const hits = [...scope.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))];
  assert.ok(hits.length > 0, `${name} is not defined in styles.css (${light ? "light" : "dark"})`);
  return hits[hits.length - 1][1];
}

function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function contrast(a, b) {
  const lum = (hex) => {
    const ch = channels(hex).map((v) => v / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `rgb` at alpha `a` painted over the opaque colour `hex`, as a hex string. */
function composite(rgb, a, hex) {
  const base = channels(hex);
  const out = rgb.map((c, i) => Math.round(c * a + base[i] * (1 - a)));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

test("the two themes really are two palettes, not one read twice", () => {
  /* The guard on the guard. `cssVar`'s first version silently returned the light
     value for both themes, so the test below was one palette measured twice and
     a wrong DARK colour was unreachable by any mutation. Pin the separation
     itself, on values the two themes are known to disagree about. */
  assert.equal(cssVar("--bg", { light: false }), "#0d1117");
  assert.equal(cssVar("--bg", { light: true }), "#faf7f2");
  const differ = [...Array(TONE_COUNT).keys()]
    .filter((i) => cssVar(`--seg-c${i}`, { light: false }) !== cssVar(`--seg-c${i}`, { light: true }));
  assert.ok(
    differ.length >= TONE_COUNT - 1,
    `only ${differ.length} tones differ between the themes — the light palette is ` +
    "supposed to be darkened variants, so this is the scoping reading one twice"
  );
  /* MUTATION (killed): restore the old scoping in `cssVar` —
     `light ? CSS : CSS.replace(/@media ...light\)[\s\S]*?\n\}\n\}/g, "")`.
     Both themes then resolve to #faf7f2 and the first assertion fails. */
});

test("every show tone clears 3:1 against the page, in both themes (WCAG 1.4.11)", () => {
  /* Measured on the RAW value, which is the colour the strip actually paints for
     a bar that is browsing, played, or current — `.fy-seg` is opacity 1 in all
     three, pinned by the test below. The one state this does NOT cover is
     `upcoming` at 0.28, and that is deliberate rather than overlooked: an
     upcoming bar is the unfilled part of a progress meter and carries nothing
     the played and current bars do not. */
  const names = [...Array(TONE_COUNT).keys()].map((i) => `--seg-c${i}`).concat("--seg-narration");
  for (const light of [false, true]) {
    const bg = cssVar("--bg", { light });
    for (const name of names) {
      const tone = cssVar(name, { light });
      const ratio = contrast(tone, bg);
      assert.ok(
        ratio >= 3,
        `${name} is ${tone} on ${bg} in the ${light ? "light" : "dark"} theme — ` +
        `${ratio.toFixed(2)}:1, and a graphical object needs 3:1`
      );
    }
  }
  /* MUTATION (killed), one per theme, because a scoping bug in this file's own
     helper made the dark half unreachable once already:
       light: `--seg-c4: #ab8233` -> `#f0ece4`  (1.12:1 on #faf7f2)
       dark:  `--seg-c4: #D9A441` -> `#101820`  (1.03:1 on #0d1117)
     Both fail here, naming the property, the value and the ratio. */
});

test("a bar that carries information is painted at full opacity", () => {
  /* The contrast test above measures raw hex, and that is only the truth if the
     states carrying information are painted at opacity 1. The mockup specifies
     0.9 for browsing; over the light theme's #faf7f2 that drops eight of the
     nine tones under 3:1, so the strip deviates and this is where the deviation
     is held down. */
  assert.match(CSS, /\.fy-seg \{[^}]*opacity: 1;/, ".fy-seg must browse at full opacity");
  assert.match(
    CSS,
    /\.fy-strip\.has-position \.fy-seg\.is-played,\s*\.fy-strip\.has-position \.fy-seg\.is-here \{ opacity: 1; \}/,
    "a played bar and the bar the listener is inside must both be at full opacity"
  );
  /* The progress fill hangs on `is-here`, NOT on `is-playing`, and the two are
     different states on a cold resume. Asserted as a stylesheet pin rather than
     as rendered output, because nothing in this repo executes CSS — so it is
     also asserted in the NEGATIVE, which is what makes it more than a grep: the
     selector that caused the defect must not be present at all. */
  assert.match(CSS, /\.fy-seg\.is-here \.fy-seg-fill \{ opacity: 0\.78; \}/,
    "the fill must show on the bar the listener is inside, playing or not");
  assert.doesNotMatch(CSS, /\.fy-seg\.is-playing \.fy-seg-fill \{ opacity/,
    "keying the fill on is-playing leaves a cold resume pointing at an empty bar");
  /* AND THE FALLBACK TONE. A `.fy-seg` with no tone class is not hypothetical:
     it is what the plain bars in app.js's template render as when the page is
     paired with a module too old to have `stripInto`. It used to be `--surface-2`
     with a 1px border; the border went when the bars became coloured, and
     `--surface-2` alone is 1.2:1 against the page — a strip that is not there.
     So the fallback is read out of the stylesheet and measured like any tone. */
  const fallback = /background: var\(--seg-tone, var\((--[a-z0-9-]+)\)\);/.exec(CSS);
  assert.ok(fallback, ".fy-seg must declare a fallback tone for an untoned bar");
  for (const light of [false, true]) {
    const ratio = contrast(cssVar(fallback[1], { light }), cssVar("--bg", { light }));
    assert.ok(
      ratio >= 3,
      `an untoned bar is ${ratio.toFixed(2)}:1 in the ${light ? "light" : "dark"} theme`
    );
  }
  /* MUTATION (killed): in styles.css, `var(--seg-tone, var(--text-dim))` ->
     `var(--seg-tone, var(--surface-2))`, which is what this shipped with.
     1.23:1 dark, 1.07:1 light — the whole fallback strip invisible.
     MUTATION (killed): `.fy-seg { ... opacity: 1; ... }` -> `0.9`.
     The strip paints eight of the nine light tones under 3:1 while the test
     above still certifies them, which is the gap this exists to close.
     MUTATION (killed): `.fy-seg.is-here .fy-seg-fill` -> `.fy-seg.is-playing ...`,
     which is the exact regression #128 shipped and review caught. */
});

test("the narration hatch raises the bridge's contrast rather than spending it", () => {
  /* A hatch is paint OVER the tone, so the stripe is what the eye measures and
     the raw `--seg-narration` above is not the whole claim. The stripe therefore
     has to clear 3:1 as composited, in both themes — and the shipped-first
     version did not: rgba(0,0,0,0.42) over #A78BFA is 2.78:1 on the dark page.
     Both stripes are checked, because a hatch that alternates a legible band
     with an illegible one is a bar with holes in it. */
  for (const light of [false, true]) {
    const bg = cssVar("--bg", { light });
    const tone = cssVar("--seg-narration", { light });
    const scope = scopeFor(light);
    const hits = [...scope.matchAll(/--seg-hatch:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)];
    assert.ok(hits.length > 0, `--seg-hatch is not defined (${light ? "light" : "dark"})`);
    const [, rr, gg, bb, aa] = hits[hits.length - 1];
    const over = composite([+rr, +gg, +bb], +aa, tone);
    for (const [what, colour] of [["the bare tone", tone], ["the stripe", over]]) {
      const ratio = contrast(colour, bg);
      assert.ok(
        ratio >= 3,
        `${what} of a narrator bridge is ${ratio.toFixed(2)}:1 on ${bg} in the ` +
        `${light ? "light" : "dark"} theme`
      );
    }
  }
  /* MUTATION (killed): in styles.css, the dark `--seg-hatch` ->
     `rgba(0, 0, 0, 0.42)` (the value this shipped with). 2.78:1, and the failure
     names the theme and the ratio. */
});

test("every tone the renderer can emit has a colour, and both themes define it", () => {
  const emitted = new Set();
  for (const id of REAL_IDS) {
    for (const c of renderedBarClasses(mount(real(id).playable).markup).flat()) {
      if (/^fy-t\d+$/.test(c)) emitted.add(c);
    }
  }
  assert.ok(emitted.size > 1, "the real Forays should exercise several tones");
  for (const cls of emitted) {
    const n = Number(cls.slice(4));
    assert.ok(n >= 0 && n < TONE_COUNT, `${cls} is outside the palette`);
  }
  // And the palette is complete for every tone the code could reach, not only
  // the ones today's data happens to hit.
  for (let i = 0; i < TONE_COUNT; i++) {
    assert.match(CSS, new RegExp(`\\.fy-seg\\.fy-t${i}\\s*\\{[^}]*--seg-tone:\\s*var\\(--seg-c${i}\\)`),
      `.fy-t${i} has no rule binding it to --seg-c${i}`);
    cssVar(`--seg-c${i}`, { light: false });
    cssVar(`--seg-c${i}`, { light: true });
  }
  /* MUTATION (killed): in segment-strip.js, `TONE_COUNT = 8` -> `9`. Nothing
     renders differently on today's data, but `.fy-t8` has no rule, so a ninth
     show would render on `--surface-2` — an invisible bar. The loop fails at
     i=8, and so does the contrast test above, which then looks for an
     undeclared `--seg-c8`. */
});
