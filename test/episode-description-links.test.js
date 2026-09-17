/* Episode descriptions that are worth reading — founder, 2026-09-17:
 *
 *   "For episodes that have good descriptions with links and timestamps for
 *    chapters through the conversation, the formatting in 4a needs to improve
 *    dramatically, such that it's readable and I can click the links, including
 *    to time stamps within the episode (those then result in jumping to that
 *    timestamp in 4a)."
 *
 * Before this, `renderEpisode` wrote `esc(item.description)` into one <p>: every
 * URL a publisher had written was dead text and so was every timestamp.
 *
 * WHAT THIS FILE IS FOR, beyond the happy path. `episodeDescriptionHtml` is the
 * one function in app.js that turns UNTRUSTED PUBLISHER TEXT into markup, which
 * makes it the highest-value injection surface added in a long time. The rule it
 * has to hold is "the only HTML in the output is the HTML this function writes",
 * and roughly half the tests below are that rule under attack rather than the
 * feature working.
 *
 * Same dependency-free harness as test/episode-page.test.js (node:vm, no jsdom)
 * — see that file's header.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

function loadApp() {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: () => makeEl(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  return ctx;
}

const app = loadApp();
const html = (text, dur) => app.episodeDescriptionHtml(text, dur);

/* ---------- parseTimestampSeconds: the arithmetic, and what is NOT one ---- */

test("parseTimestampSeconds reads mm:ss and h:mm:ss", () => {
  // MUTATION: drop the `h * 3600` term -> the third and fourth go red.
  assert.strictEqual(app.parseTimestampSeconds("0:00"), 0);
  assert.strictEqual(app.parseTimestampSeconds("12:34"), 754);
  assert.strictEqual(app.parseTimestampSeconds("1:02:45"), 3765);
  assert.strictEqual(app.parseTimestampSeconds("10:00:00"), 36000);
});

test("parseTimestampSeconds refuses an out-of-range minute or second", () => {
  /* This is what keeps a score, a ratio or a date out of the seek controls.
     MUTATION: relax `[0-5]\d` to `\d\d` -> both of these start parsing. */
  assert.strictEqual(app.parseTimestampSeconds("65:40"), null, "no 65th minute");
  assert.strictEqual(app.parseTimestampSeconds("12:75"), null, "no 75th second");
});

test("parseTimestampSeconds refuses things that merely contain digits and a colon", () => {
  for (const notATime of ["", "abc", "12", "1:2:3:4", "::", "12:", ":34", "1.2:34"]) {
    assert.strictEqual(app.parseTimestampSeconds(notATime), null, `"${notATime}" is not a timestamp`);
  }
});

/* ---------- the feature: links and timestamps ---------------------------- */

test("a bare http(s) URL becomes a link that opens off-origin safely", () => {
  const out = html("Notes at https://example.com/ep/12 for more.");
  assert.match(out, /<a href="https:\/\/example\.com\/ep\/12"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer"/, "an off-origin link must not hand over window.opener");
  assert.match(out, />https:\/\/example\.com\/ep\/12<\/a>/, "the link text is the URL the publisher wrote");
});

test("a timestamp becomes a button carrying its position in seconds", () => {
  const out = html("12:34 The interesting bit");
  assert.match(out, /<button type="button" class="ep-ts" data-ts="754"/);
  assert.match(out, />12:34<\/button>/);
  assert.match(out, /aria-label="Play from 12:34"/, "a bare number read aloud says nothing about what it does");
});

test("a full description keeps its other text verbatim and in order", () => {
  const out = html("Sponsored by https://a.example/x\n\n00:00 Intro\n1:02:45 Tokamaks");
  const order = [out.indexOf("Sponsored by"), out.indexOf("a.example"), out.indexOf('data-ts="0"'), out.indexOf('data-ts="3765"')];
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), "source order must survive");
  assert.ok(order.every((i) => i >= 0), "every piece must be present");
  assert.match(out, /\n\n/, "blank lines survive for `white-space: pre-line` to render");
});

test("an empty or absent description produces nothing at all", () => {
  for (const empty of ["", null, undefined]) assert.strictEqual(html(empty), "");
});

/* ---------- the honesty guard on a timestamp past the end ---------------- */

test("a timestamp past the episode's duration stays plain text", () => {
  /* A control that seeks past the end of the audio is worse than no control.
     MUTATION: drop the `secs <= durationSec` clause -> this goes red. */
  const out = html("2:00 early and 59:00 late", 30 * 60);
  assert.match(out, /data-ts="120"/, "2:00 is inside a 30-minute episode");
  assert.ok(!out.includes('data-ts="3540"'), "59:00 is not");
  assert.match(out, /59:00/, "and it is still readable as text");
});

test("an unknown duration filters nothing — the default is not to throw them away", () => {
  const out = html("59:00 late", null);
  assert.match(out, /data-ts="3540"/);
});

/* ---------- untrusted text cannot become markup -------------------------- */

test("HTML in the description is escaped, not rendered", () => {
  /* The whole reason this function exists rather than an innerHTML assignment.
     MUTATION: return the raw slice instead of `esc(...)` for plain runs. */
  const out = html('<img src=x onerror="alert(1)"> and <b>bold</b>');
  assert.ok(!out.includes("<img"), "no tag from the source may reach the output");
  assert.ok(!out.includes("<b>"));
  /* NOTE the shape of this assertion. `onerror=` DOES still appear in the
     output — as escaped, visible text, which is the correct outcome and not a
     defect. What must not exist is a TAG carrying it. Asserting on the bare
     substring would have been the easier line to write and would have failed
     on a description that merely discusses an onerror attribute. */
  assert.ok(!/<[^>]*\sonerror/i.test(out), "no tag may carry an event-handler attribute");
  assert.match(out, /&lt;img/, "it is shown to the reader as the text it is");
});

test("a javascript: or data: URL never becomes a link", () => {
  for (const hostile of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
    const out = html(`click ${hostile} now`);
    assert.ok(!out.includes("<a "), `${hostile} must stay text`);
    // Again: the scheme may appear as text. What it may not be is an href.
    assert.ok(!/href="[^"]*(?:javascript|data):/i.test(out), "and never as an href");
  }
});

test("a quote inside a URL cannot break out of the href attribute", () => {
  /* The classic escape: a URL containing `"` terminating the attribute early.
     The regex excludes quotes from a match, and `esc()` covers the rest;
     this test is what proves BOTH halves rather than assuming either. */
  const out = html('https://example.com/a"onmouseover="alert(1)');
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(!/<[a-z][^>]*\sonmouseover/i.test(out), "no tag may be given an injected attribute");
  for (const h of hrefs) assert.ok(!h.includes('"'), "an href must contain no raw quote");
});

test("a timestamp inside a URL is left alone — the URL wins the alternation", () => {
  /* MUTATION: put the timestamp branch first in DESC_TOKEN_RE -> this goes red,
     because the URL is torn in half around its own `12:34`. */
  const out = html("https://example.com/watch?t=12:34");
  assert.ok(!out.includes("ep-ts"), "no seek button may be cut out of a URL");
  assert.match(out, /href="https:\/\/example\.com\/watch\?t=12:34"/);
});

test("the ONLY tags in the output are the ones this function writes", () => {
  /* A single assertion standing behind every case above and every case nobody
     thought of: whatever the input, the output's tag vocabulary is closed. */
  const nasty = '<script>x</script> https://e.example/<svg/onload=1> 1:23 </p><iframe src=//evil>';
  const tags = [...html(nasty).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  assert.deepStrictEqual([...new Set(tags)].sort(), ["a", "button"]);
});

/* ---------- the section wrapper and the chapter list --------------------- */

test("episodeDescriptionSectionHtml renders nothing without a description", () => {
  assert.strictEqual(app.episodeDescriptionSectionHtml({ description: null }), "");
  assert.strictEqual(app.episodeDescriptionSectionHtml({ description: "" }), "");
});

test("episodeDescriptionSectionHtml passes the episode's duration through as the guard", () => {
  /* duration_min is MINUTES; the guard is in seconds. MUTATION: drop the `* 60`
     -> a 20-minute episode filters everything past 20 SECONDS and this fails. */
  const out = app.episodeDescriptionSectionHtml({ description: "5:00 in", duration_min: 20 });
  assert.match(out, /data-ts="300"/, "5:00 is inside a 20-minute episode");
});

test("chapter rows are seek controls carrying start_time_seconds", () => {
  const out = app.episodeChaptersHtml({ chapters: [{ start_time_seconds: 0, title: "Cold open" }, { start_time_seconds: 754, title: "The bit" }] });
  assert.match(out, /<button type="button" class="ep-chapter-row" data-ts="0"/);
  assert.match(out, /<button type="button" class="ep-chapter-row" data-ts="754"/);
  assert.match(out, /12:34/, "the human-readable time is still shown");
});

test("a chapter with no usable start time is rendered, but not as a control", () => {
  /* Losing the row entirely would hide a chapter the publisher wrote; making it
     a button that cannot seek would be a promise the markup cannot keep. */
  const out = app.episodeChaptersHtml({ chapters: [{ start_time_seconds: null, title: "Unplaceable" }] });
  assert.match(out, /Unplaceable/);
  assert.ok(!out.includes("ep-chapter-row"), "no seek control without a position");
});

test("a chapter title is escaped like any other publisher text", () => {
  const out = app.episodeChaptersHtml({ chapters: [{ start_time_seconds: 1, title: "<img src=x onerror=1>" }] });
  assert.ok(!out.includes("<img"), "no tag from a chapter title may reach the output");
  assert.ok(!/<[^>]*\sonerror/i.test(out));
  assert.match(out, /&lt;img/);
});

/* ---------- the page uses it ---------------------------------------------- */

test("renderEpisode goes through the linkifier, not esc(), for the description", () => {
  /* The regression this guards: someone "simplifies" the call site back to
     `esc(item.description)` and every link on every episode page dies silently,
     with this suite still green because it tests the function and not the page.
     MUTATION: restore the old `<p class="ep-description-text">${esc(...)}` line. */
  assert.match(SRC, /\$\{episodeDescriptionSectionHtml\(item\)\}/, "the episode page must render the section helper");
  assert.ok(
    !/class="ep-description-text">\$\{esc\(item\.description\)\}/.test(SRC),
    "the old escape-the-whole-blob path must be gone, not merely unused"
  );
  assert.match(SRC, /bindEpisodeSeeks\(\$\("#view"\), item\)/, "and the seek controls must be bound after render");
});

test("the seek controls are bound per element, not delegated from #view", () => {
  /* THE BUG THIS EXISTS FOR, found in review before it shipped. `#view` is the
     one node on an episode page that outlives the render — `renderEpisode`
     replaces its innerHTML, never the element. A delegated `#view` listener
     therefore survives every navigation and accumulates: visit three episodes,
     tap one timestamp, and three handlers run, two of them closing over an
     `item` the listener is no longer looking at and starting playback of it.

     `bindPlay` and `bindStars` already solved this — per element, with a
     `_bound` guard, so the listeners die with the markup they belong to. This
     test is what stops the delegated version coming back as a "simplification".

     MUTATION: replace the body with `scope.addEventListener("click", ...)`.
     This goes red. RUN: failed as named. */
  const fn = /function bindEpisodeSeeks\(scope, item\) \{([\s\S]*?)\n\}/.exec(SRC);
  assert.ok(fn, "bindEpisodeSeeks must still exist");
  assert.match(fn[1], /scope\.querySelectorAll\("\[data-ts\]"\)/, "it must walk the controls");
  assert.match(fn[1], /if \(btn\._bound\) return;/, "…with the same idempotence guard as bindPlay");
  assert.ok(
    !/scope\.addEventListener/.test(fn[1]),
    "it must not listen on the element that outlives the render"
  );
});

test("a seek does not restart an episode that is already the current one", () => {
  /* Restarting would throw away the position the listener is at — the control
     promises a jump, not a reload.
     MUTATION: drop the `isPlaying` guard and always call `play`. */
  const fn = /function bindEpisodeSeeks\(scope, item\) \{([\s\S]*?)\n\}/.exec(SRC);
  assert.match(fn[1], /if \(!window\.ForayPlayer\.isPlaying\(item\.id\)\) await window\.ForayPlayer\.play\(/);
  assert.match(fn[1], /await window\.ForayPlayer\.seekTo\(secs\)/, "…and the seek happens either way");
});
