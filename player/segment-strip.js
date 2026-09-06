/* SegmentStrip — one Foray, at a glance (#128).

   ── What this element is for ──────────────────────────────────────────────
   A Foray is an ORDERED SEQUENCE OF SEGMENTS CUT FROM DIFFERENT EPISODES. That
   is the whole product thesis, and until this element existed the running order
   rendered as a list, which reads as a playlist. Founder feedback on the live
   site, verbatim: "it's certainly not clear that it's more than one podcast...
   I have no clue how they relate." This strip is the answer to that sentence.

   So the ONE thing it must show is the seam: where one episode stops and
   another starts. Everything else here is in service of that.

   ── How a seam reads, and why it is not a colour ──────────────────────────
   Consecutive segments from the SAME episode are butted together with a
   hairline between them and rounded on the outside only, so a run of them reads
   as ONE CAPSULE. A cross-episode seam is a real GAP — several pixels of page
   showing through — which ends one capsule and starts the next.

   That means the strip's primary statement ("seven shows, stitched, in this
   order") is carried by GEOMETRY, not by hue. Turn the whole thing greyscale
   and the seven capsules are still seven capsules. Colour is a second,
   redundant channel on top: it names WHICH show, which is exactly the kind of
   information colour is allowed to carry alone-ish, because the running order
   below the strip names every show in words.

   The gap is also why the strip stays honest at phone width. `capital-types-1`
   is 22 segments over 51 minutes with 10 cross-episode seams among its 21
   boundaries; a per-SEGMENT gap would spend a fifth of a 360px screen on
   whitespace and distort every proportion. A per-CAPSULE gap spends about 9%,
   and spends it on the one distinction the element exists to make.

   ── Narration is a first-class item, not a gap ────────────────────────────
   A narrator bridge (`kind: "tts"`) is its own capsule, in its own violet, with
   a diagonal hatch over it — hatch, because the bridges are 6-20 s inside an
   hour and at 5px tall a hue difference on a 3px sliver is not a signal. It is
   sized by `itemRuntimeSec` like everything else and floored at a visible
   minimum width in CSS, because a bridge that renders as nothing is a bridge
   the listener hears and cannot see. #287 landed the narration architecture and
   these will grow; the strip must not treat them as seams in the tape.

   ── What is pure and what touches the DOM ─────────────────────────────────
   `stripModel` is the whole element as data — widths, capsule boundaries,
   past/current/upcoming, the fill fraction, the summary sentence. It has no
   DOM, no `document`, and it is where the arithmetic is tested. `renderStrip`
   and `mountStrip` turn that data into elements and know nothing else.

   ── Constraints this file lives under ─────────────────────────────────────
     - NO INLINE STYLES. The page CSP is `style-src 'self'` and
       test/app-security.test.js fails the build on a `style="..."` attribute.
       Everything variable is a CSS custom property set through
       `style.setProperty()`, which is a CSSOM call and not an attribute.
     - DOM is built with `createElement`/`setAttribute`, never HTML strings.
       Show names and episode titles come from third-party RSS.
     - Lengths come from `itemRuntimeSec` and positions from `segmentAtElapsed`,
       imported rather than re-derived. `player/foray-queue.js`'s header records
       what happened the last time this subtraction had three private copies:
       narration was worth 0 s in all of them.
*/

import { itemRuntimeSec } from "./foray-queue.js";
import { segmentStarts, segmentAtElapsed, fmtClock, fmtSpan } from "./foray-resolve.js";

/** How many show tones the palette holds. `styles.css` defines `--seg-c0` …
    `--seg-c7` for both themes, and every one of them is measured against the
    page background there — see the contrast note above the palette. */
export const TONE_COUNT = 8;

/** The narrator is a source like any other for grouping purposes, and must
    never collide with a show or an episode id. A SYMBOL rather than a
    sentinel string, because "equal to nothing else" is the whole requirement
    and a string has to buy it with a character no id would use — the first
    attempt used a literal NUL, which git reads as a binary file, so the
    module would have landed with no reviewable diff. Symbols are legal Map
    and Set keys, which is all this value is ever used as. */
export const NARRATOR_SOURCE = Symbol("narrator");

/** The three sizes #128 asks for: a list row, a card, the player. */
export const SIZES = ["sm", "md", "lg"];

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const clamp01 = (n) => (isNum(n) ? Math.min(1, Math.max(0, n)) : 0);

/** A narrator bridge, in either of the two shapes it travels in: `kind: "tts"`
    on a built queue item, `type: "narration"` on an authored/hydrated one. Both
    reach this element — the player page hands over `resolved.playable`, a card
    may hand over `resolved.entries` — and a strip that recognised only one of
    them would render the other as a silent segment of an unnamed show. */
export function isNarration(item) {
  return item?.kind === "tts" || item?.type === "narration";
}

/**
 * Which SOURCE EPISODE this item was cut from — the value the capsules group
 * on, and therefore the definition of a seam.
 *
 * The episode, not the show: a Foray that runs two different episodes of the
 * same podcast back to back has a real seam there, the listener hears a hard
 * cut, and grouping by show would paint over it. `source_item_id` is what
 * `buildForayQueue` carries for exactly this purpose; the rest of the chain is
 * for items that arrive in a different shape, ending at the audio URL, which is
 * the last thing that is still per-episode.
 */
export function sourceKeyOf(item) {
  if (isNarration(item)) return NARRATOR_SOURCE;
  for (const k of [item?.source_item_id, item?.item_id, item?.audio_url]) {
    if (nonEmpty(k)) return k;
  }
  /* NOT `item.id`. On a built queue item that is `${forayId}#${ord}` — a
     POSITION, unique per item — so falling back to it would make every segment
     its own capsule and spend a seam gap on all 22 of them, which is the
     whitespace failure this file's header rejects. An item whose episode cannot
     be identified joins the run it is next to: one capsule is a less wrong
     picture than twenty-two. */
  return "";
}

/** FNV-1a, 32-bit. Any stable hash would do; this one is four lines and has no
    dependency. It is the PREFERENCE for a show's tone, not the final answer —
    see `assignTones`. */
export function toneSeed(key) {
  let h = 0x811c9dc5;
  const s = String(key ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Source key -> tone index, for one Foray.
 *
 * #128 asks for "a deterministic assignment (hash the show id into a palette)
 * so the same show is the same colour everywhere". A bare hash into 8 buckets
 * does not survive contact with the data: `capital-types-1` draws on 7
 * episodes, and 7 items into 8 buckets collide about 98% of the time. Two
 * ADJACENT capsules painted the same colour is the one failure this element
 * cannot afford, because it is indistinguishable from one long capsule for
 * anybody reading colour rather than shape.
 *
 * So the hash is a preference and collisions probe forward. Assignment runs in
 * order of first appearance, which makes it deterministic for a given running
 * order, and a show keeps its hashed tone unless this particular Foray has
 * already spent it. Past `TONE_COUNT` distinct episodes tones do repeat — and
 * that is survivable precisely because the capsule gap, not the colour, is what
 * says "new episode".
 *
 * @param {string[]} keys  source keys in first-appearance order
 * @returns {Map<string, number>}
 */
export function assignTones(keys) {
  const out = new Map();
  const used = new Set();
  for (const key of keys ?? []) {
    if (key === NARRATOR_SOURCE || out.has(key)) continue;
    let tone = toneSeed(key) % TONE_COUNT;
    for (let probe = 0; probe < TONE_COUNT && used.size < TONE_COUNT && used.has(tone); probe++) {
      tone = (tone + 1) % TONE_COUNT;
    }
    used.add(tone);
    out.set(key, tone);
  }
  return out;
}

/**
 * How much of the strip one item takes.
 *
 * Integer seconds as a flex-grow, which is what the Foray page has always used:
 * `flex-grow: n; flex-basis: 0` divides the row by runtime, and the floor of 1
 * keeps a rounding-to-zero item from disappearing entirely. The visible floor
 * for a genuinely short item — a 6 s bridge — is a `min-width` in CSS, because
 * a floor expressed in flex units would distort every other bar to pay for it.
 */
export function growOf(lengthSec) {
  return Math.max(1, Math.round(isNum(lengthSec) && lengthSec > 0 ? lengthSec : 0));
}

/**
 * The whole element, as data.
 *
 * @param {object[]} items  a player queue (`resolved.playable`) or hydrated entries
 * @param {object} [opts]
 * @param {number|null} [opts.elapsed]  seconds into the WHOLE Foray, or null to
 *   render the browsing state. Null and 0 are different: 0 means "at the very
 *   start of a Foray somebody is listening to", null means "nobody is here".
 * @returns {{
 *   totalSec: number, positioned: boolean, currentIndex: number|null,
 *   elapsedSec: number,
 *   segments: object[], runs: object[],
 *   segmentCount: number, narrationCount: number, sourceCount: number,
 *   shows: string[],
 * }}
 */
export function stripModel(items, { elapsed = null } = {}) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i === "object") : [];
  // `itemRuntimeSec` already answers 0 for anything it cannot measure, so this
  // is its answer rather than a second opinion about it.
  const lengths = list.map((i) => itemRuntimeSec(i));
  const starts = segmentStarts(list);
  const totalSec = lengths.reduce((t, n) => t + n, 0);

  const keys = list.map(sourceKeyOf);
  const tones = assignTones(keys);

  /* Where the listener is. `segmentAtElapsed` is the same function the scrubber
     and the resume path use, so the bar that fills and the second the clock
     reports cannot drift apart. */
  const positioned = isNum(elapsed) && elapsed >= 0 && list.length > 0;
  const at = positioned ? segmentAtElapsed(list, elapsed) : null;
  const currentIndex = at ? at.index : null;

  const segments = list.map((item, index) => {
    const key = keys[index];
    const narration = key === NARRATOR_SOURCE;
    const lengthSec = lengths[index];
    /* A capsule boundary is a change of source episode. The first and last
       items are boundaries by definition — a strip has two ends. */
    const runStart = index === 0 || keys[index - 1] !== key;
    const runEnd = index === list.length - 1 || keys[index + 1] !== key;

    let state = "idle";
    let progress = 0;
    if (positioned) {
      if (currentIndex != null && index < currentIndex) { state = "past"; progress = 1; }
      else if (index === currentIndex) {
        state = "current";
        progress = lengthSec > 0 ? clamp01(at.into / lengthSec) : 0;
      } else state = "upcoming";
    }

    return {
      index,
      kind: narration ? "narration" : "segment",
      sourceKey: key,
      show: narration ? "" : (nonEmpty(item.show) ? item.show : ""),
      label: nonEmpty(item.label) ? item.label : "",
      tone: narration ? null : (tones.get(key) ?? 0),
      lengthSec,
      startSec: starts[index] ?? 0,
      share: totalSec > 0 ? lengthSec / totalSec : 0,
      grow: growOf(lengthSec),
      runStart,
      runEnd,
      state,
      progress,
    };
  });

  const runs = [];
  for (const seg of segments) {
    if (seg.runStart) {
      runs.push({
        index: runs.length, kind: seg.kind, sourceKey: seg.sourceKey,
        show: seg.show, tone: seg.tone, from: seg.index, to: seg.index,
        lengthSec: seg.lengthSec,
      });
    } else {
      const run = runs[runs.length - 1];
      run.to = seg.index;
      run.lengthSec += seg.lengthSec;
    }
  }

  const tape = segments.filter((s) => s.kind === "segment");
  return {
    totalSec,
    positioned,
    currentIndex,
    elapsedSec: positioned ? Math.min(Math.max(0, elapsed), totalSec) : 0,
    segments,
    runs,
    segmentCount: tape.length,
    narrationCount: segments.length - tape.length,
    sourceCount: new Set(tape.map((s) => s.sourceKey)).size,
    shows: [...new Set(tape.map((s) => s.show).filter(nonEmpty))],
  };
}

/**
 * What a screen reader hears instead of the picture.
 *
 * A strip of unlabelled bars is not a deliverable, and neither is 22 focus
 * stops: the running order underneath already lists every segment with its show
 * in words, and app.js's own comment calls those rows "the keyboard-reachable
 * half of this control". So the strip is a GRAPHIC — one focus stop, one label
 * — and the label says the thing the picture says: how many pieces, from how
 * many shows, how long, and where you are.
 *
 * `fmtSpan`/`fmtClock` rather than new formatters: a total worded one way here
 * and another way in the header is the page disagreeing with itself.
 */
export function stripSummary(model) {
  const m = model ?? {};
  const segs = m.segmentCount ?? 0;
  if (!segs && !(m.narrationCount ?? 0)) return "Running order: nothing to play.";

  /* SHOWS, not source episodes, and the difference is the point of the
     sentence. The strip draws one capsule per EPISODE — capital-types-1 has 11
     of them — but the fact the founder said was missing from the live site is
     "it's more than one podcast", and that is a count of shows. The capsules
     are the picture; this is the caption. An episode with no show name in the
     catalogue falls back to counting episodes rather than saying "0 shows". */
  const named = Array.isArray(m.shows) ? m.shows.length : 0;
  const shows = named > 0 ? named : (m.sourceCount ?? 0);
  const unit = named > 0 ? "show" : "episode";
  const parts = [`${segs} segment${segs === 1 ? "" : "s"} from ${shows} ${unit}${shows === 1 ? "" : "s"}`];
  if (m.narrationCount > 0) {
    parts.push(`${m.narrationCount} narrator bridge${m.narrationCount === 1 ? "" : "s"}`);
  }
  let out = `Running order: ${parts.join(" and ")}, ${fmtSpan(m.totalSec)} in all.`;

  if (m.positioned && m.currentIndex != null) {
    const cur = m.segments?.[m.currentIndex];
    const from = cur?.kind === "narration"
      ? "the narrator"
      : (nonEmpty(cur?.show) ? cur.show : "an unnamed show");
    out += ` Now on piece ${m.currentIndex + 1} of ${m.segments.length}, from ${from}, `
      + `${fmtClock(m.elapsedSec)} in.`;
  }
  return out;
}

/* ---------- the DOM half ---------- */

const SEG_CLASS = "fy-seg";

/**
 * One `<span class="fy-seg">` per item, appended to `parent`.
 *
 * The markup is EXACTLY what the Foray page's live painter already walks —
 * flat children in queue order, each holding a single `<i class="fy-seg-fill">`
 * — because `paintSegFill` and `paintForay` in app.js index `strip.children[i]`
 * and read `.children[0]`. Wrapping the capsules in group elements would have
 * been the obvious structure and would have silently broken both: `children[i]`
 * would stop being segment i, and the fill would stop moving. The capsule is
 * therefore expressed in CLASSES on a flat row, not in nesting.
 */
function paintSegments(doc, parent, model, playing) {
  for (const seg of model.segments) {
    const bar = doc.createElement("span");
    const classes = [SEG_CLASS];
    if (seg.kind === "narration") classes.push("fy-seg--narration");
    else classes.push(`fy-t${seg.tone}`);
    if (seg.runStart) classes.push("is-run-start");
    if (seg.runEnd) classes.push("is-run-end");
    if (seg.state === "past") classes.push("is-played");
    /* TWO classes for the current bar, and they are not the same claim.
       `is-here` is "this is the bar the listener is inside": full opacity and the
       progress fill hang on it, and a POSITION is all it needs. `is-playing` adds
       the ring and means "audio is running right now", which a position does not
       imply — a stored resume point is a position with nothing playing, and a
       ring around it would be the page claiming to play. So `is-playing` comes
       from the caller and defaults to false; only `is-here` is derived. */
    if (seg.state === "current") {
      classes.push("is-here");
      if (playing) classes.push("is-playing");
    }
    bar.className = classes.join(" ");
    bar.setAttribute("data-seg", String(seg.index));
    /* CSSOM, not a style attribute — the CSP is `style-src 'self'`. */
    bar.style.flexGrow = String(seg.grow);

    const fill = doc.createElement("i");
    fill.className = "fy-seg-fill";
    /* Only the current bar shows a fill; a past bar is full-opacity colour and
       an upcoming one is dimmed (#128's position spec). A fill painted to 100%
       on every past bar would cover the show colour on everything behind the
       listener, which is the half of the strip that has already earned its
       point. CSS hides it on anything but `.is-here`; the width is still
       written so that the Foray page's 4 Hz painter, which writes the same
       property, is writing to something that exists. */
    fill.style.width = `${Math.round(seg.progress * 1000) / 10}%`;
    bar.appendChild(fill);
    parent.appendChild(bar);
  }
}

/**
 * Render the strip into an element that already exists — the Foray page owns
 * `#fy-strip` and its click handler, so the element must survive.
 *
 * @param {object} el       the container
 * @param {object[]} items  a player queue
 * @param {object} opts
 * @param {object} opts.document
 * @param {number|null} [opts.elapsed]
 * @param {boolean} [opts.playing]  is audio actually running? See below.
 * @param {string} [opts.size]  "sm" | "md" | "lg"
 * @returns {object} the model that was rendered
 */
export function mountStrip(el, items, { document: doc, elapsed = null, playing = false, size = "md" } = {}) {
  const model = stripModel(items, { elapsed });
  if (!el || !doc || typeof doc.createElement !== "function") return model;

  while (el.firstChild) el.removeChild(el.firstChild);

  const chosen = SIZES.includes(size) ? size : "md";
  el.classList.add("fy-strip", `fy-strip--${chosen}`);
  for (const other of SIZES) if (other !== chosen) el.classList.remove(`fy-strip--${other}`);
  el.classList.toggle("has-position", Boolean(model.positioned));

  /* A labelled graphic, and DELIBERATELY NOT A FOCUS STOP.
     `role="img"` makes the 22 bars presentational and gives a screen reader one
     description instead of 22 unlabelled stops — and a browse cursor reaches
     that description without a tab stop, so `tabindex="0"` buys a screen-reader
     user nothing. What it does buy a SIGHTED keyboard user is a focus ring on a
     control that does nothing on Enter or Space: the strip's gesture is a
     pointer scrub, and the ring would be a promise this element cannot keep.
     The operable, keyboard-reachable half of this control is the running-order
     rows, which are buttons and which app.js already names as such.
     Making the strip itself operable means `role="slider"` with `aria-valuenow`
     and arrow keys. That is real work and it belongs with #133's live position,
     not smuggled in behind a tabindex. */
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", stripSummary(model));

  paintSegments(doc, el, model, playing);
  return model;
}

/**
 * Build a standalone strip element — the shape a card or a list row wants,
 * where there is no container to decorate.
 */
export function renderStrip(items, opts = {}) {
  const doc = opts.document;
  if (!doc || typeof doc.createElement !== "function") return null;
  const el = doc.createElement("div");
  mountStrip(el, items, opts);
  return el;
}

/* ---------- U-04: the string half ---------- */

/**
 * `segmentStripHtml` exists for the callers `mountStrip`/`renderStrip` do not
 * fit: `app.js`'s Home cards (U-03) and the show/episode restyle (U-08) build
 * their markup as TEMPLATE STRINGS interpolated into `innerHTML`, the same way
 * every other card on the page does (`miniCard`, `foraySlotHtml`, …) — handing
 * them a live DOM node built by `renderStrip` would mean one card element built
 * two different ways, and the string half is the one that already fits how
 * `app.js` renders everything else.
 *
 * `<3 chars of HTML>` to escape: `esc()` in `app.js` cannot be imported here —
 * `app.js` is a classic script and this file is an ES module (`player/` is the
 * one directory scoped to module semantics; see `player/package.json`) — so
 * this file carries its own, matching `app.js`'s table exactly rather than
 * inventing a second escaping rule for one string.
 */
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The whole element as an HTML string, over a Foray's items.
 *
 * NO WIDTH IS WRITTEN HERE. The page CSP is `style-src 'self'` (no
 * `unsafe-inline`), which blocks a `style="..."` attribute exactly as it would
 * if this string were typed by hand — a pure function returning markup cannot
 * duck that by being a different file from `app.js`. Each bar instead carries
 * its proportion in `data-grow`, a plain data attribute, and the caller applies
 * it with `applyStripGrow` after the string lands in the DOM — one CSSOM write
 * per bar, the exact mechanism `mountStrip`'s `paintSegments` and `app.js`'s
 * `sizeForayStrip` already use for the same reason. Splitting the string from
 * the sizing is not a workaround here; it is the only way a *pure* function
 * can hand back something with a per-segment width at all under this CSP.
 *
 * Degrades to `""` for a Foray with no segments — `app.js`'s
 * `${maybeStrip || ""}` composes with that directly, no `if` needed at the
 * call site, matching how every other optional block in this codebase's
 * templates already reads.
 *
 * @param {object[]} items  a player queue (`resolved.playable`) or hydrated entries
 * @param {object} [opts]
 * @param {number|null} [opts.elapsed]  see `stripModel`
 * @param {boolean} [opts.playing]      see `mountStrip`
 * @param {string} [opts.size]          "sm" | "md" | "lg"
 * @returns {string}
 */
export function segmentStripHtml(items, { elapsed = null, playing = false, size = "md" } = {}) {
  const model = stripModel(items, { elapsed });
  if (model.segments.length === 0) return "";

  const chosen = SIZES.includes(size) ? size : "md";
  const bars = model.segments.map((seg) => {
    const classes = [SEG_CLASS];
    if (seg.kind === "narration") classes.push("fy-seg--narration");
    else classes.push(`fy-t${seg.tone}`);
    if (seg.runStart) classes.push("is-run-start");
    if (seg.runEnd) classes.push("is-run-end");
    if (seg.state === "past") classes.push("is-played");
    if (seg.state === "current") {
      classes.push("is-here");
      if (playing) classes.push("is-playing");
    }
    /* `data-grow`, not a computed percentage: percentages drift the instant a
       sibling bar is added or removed (every share is `lengthSec / totalSec`),
       while the flex-grow ratio `applyStripGrow` reads off this attribute is
       exactly what `stripModel` already computed for the whole set — one
       number, no re-derivation at mount time. */
    return `<span class="${classes.join(" ")}" data-seg="${seg.index}" data-grow="${seg.grow}">`
      + `<i class="fy-seg-fill"></i></span>`;
  }).join("");

  /* `fy-strip--static`: this markup has no scrub-gesture listener bound to it
     (that binding lives in `app.js`, on the ONE `#fy-strip` the full player
     page owns) and a card sitting in a vertically-scrolling rail is exactly
     where `.fy-strip`'s base `touch-action: none` would fight the page's own
     scroll — the V1 zoom-to-scrub gesture that rule exists for has nowhere to
     attach on a card. See the modifier in styles.css. */
  const posClass = model.positioned ? " has-position" : "";
  return `<div class="fy-strip fy-strip--${chosen} fy-strip--static${posClass}"`
    + ` role="img" aria-label="${escHtml(stripSummary(model))}">${bars}</div>`;
}

/**
 * Apply `segmentStripHtml`'s `data-grow` widths to bars already in the DOM.
 *
 * CSSOM, not an attribute — see `segmentStripHtml`'s header. This is the same
 * write `mountStrip`'s `paintSegments` performs inline as it builds each bar;
 * here the bars already exist (the caller's `innerHTML` put them there) so the
 * write happens in a second pass instead of during construction. Safe to call
 * on a container that holds more than one strip (a rail of Foray cards) —
 * every `[data-grow]` under it is sized, not just the first.
 *
 * @param {object} container  an element containing one or more `.fy-strip`s
 *   built by `segmentStripHtml`
 */
export function applyStripGrow(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;
  const bars = container.querySelectorAll("[data-grow]");
  for (const bar of bars) {
    const raw = typeof bar.getAttribute === "function" ? bar.getAttribute("data-grow") : null;
    const grow = Number(raw);
    bar.style.flexGrow = String(Number.isFinite(grow) && grow > 0 ? grow : 1);
  }
}
