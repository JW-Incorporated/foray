/* The words a listener reads and hears (audit 2026-09-22, docs/audit/
 * persona-synthesis.md §2 "jargon ledger" and qa-synthesis.md theme H,
 * "sticky copy").
 *
 * WHY THIS EXISTS. Two kinds of copy defect, and neither was caught by anything:
 *
 *  1. PRODUCTION VOCABULARY. One object had five names in listener-facing copy
 *     — segment, clip, piece, part, beat — and the strip's spoken label read
 *     "Running order: 11 segments … and 40 narrator bridges … Now on piece 10
 *     of 56". The ruling (overlord default R3, from the founder's standing
 *     Apple-parity intent): a Foray's pieces are CLIPS, its titled sections are
 *     PARTS, "running order" is "this foray". Code identifiers are unchanged.
 *     `backend/test/copyRules.test.ts` gates data/*.json; nothing gated the
 *     app's own chrome, so this does, for app.js and the player modules.
 *
 *  2. STRINGS THAT OUTLIVED WHAT THEY DESCRIBED. "Pull to refresh" with no such
 *     gesture; "build one from the home screen" after the builder left Home;
 *     "your browser" / "reload the page" inside a native shell with neither; a
 *     returning-user popup describing a retired four-card Home; a raw resolver
 *     reason naming data/segments.json to a listener.
 *
 * Each test names the mutation that kills it.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = read("app.js");
const SEARCH_SRC = read("search-engine.js");

/* ------------------------------------------------------------------ */
/* A small lexer: every string a file can show, and nothing else.      */
/* ------------------------------------------------------------------ */

/* Returns the static text of every string and template literal in `src`
   (an interpolation reads as a placeholder, comments are skipped), with its
   starting line. A regex literal is skipped too, so a pattern like /segment/
   in code is not "copy". Deliberately simple — it only has to be right for
   this repo's own style, and the next-but-one test checks it against strings
   it must find. */
function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = ""; // last significant code character, to tell a regex from a divide
  const push = (text, at) => out.push({ text, line: at });
  const readQuoted = (q) => {
    const at = line;
    let s = "";
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") { s += src[i + 1]; i += 2; continue; }
      if (src[i] === "\n") line++;
      s += src[i++];
    }
    i++;
    push(s, at);
  };
  const readTemplate = () => {
    const at = line;
    let s = "";
    i++;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { s += src[i + 1]; i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        /* An interpolation reads as a placeholder word, so the template is
           judged as the sentence it renders ("segment 3 of 9"), not as the
           fragments between its holes ("segment ", " of "). */
        s += "0"; i += 2;
        let depth = 1;
        while (i < src.length && depth) {
          const c = src[i];
          if (c === "`") { readTemplate(); continue; }
          if (c === '"' || c === "'") { readQuoted(c); continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          if (c === "\n") line++;
          i++;
        }
        continue;
      }
      if (src[i] === "\n") line++;
      s += src[i++];
    }
    i++;
    push(s, at);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'") { readQuoted(c); prev = "a"; continue; }
    if (c === "`") { readTemplate(); prev = "a"; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      i++;
      let inClass = false;
      while (i < src.length && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || "")) i++;
      prev = "a"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/* Prose, not code: a literal with a space in it that is not a selector, a
   CSS value or a diagnostics/console message. */
function isProse(text) {
  if (!/[A-Za-z] [A-Za-z0-9]/.test(text)) return false;
  if (/^\s*[\[.#][\w-]/.test(text)) return false; // a selector
  return true;
}

const LISTENER_FILES = ["app.js", "player/client.js", "player/segment-strip.js", "player/media-session.js"];
const JARGON = /\b(segments?|beats?|acts?|running order|pieces?|narrator bridges?)\b/i;

/* Literals that are prose in a CODE position — a console line, a thrown
   error, a diagnostics note — and never reach a listener. Keyed by the file and
   a fragment of the line, so a new listener-facing use of the same word is not
   covered by an old exemption. */
const NOT_LISTENER_FACING = [
  // (empty on 2026-09-22 — every hit the scan found was listener copy, and fixed)
];

/* MUTATION: put back any one of "Previous segment", "Jingle between segments",
   "Back to the running order", "part N of M"'s cousin "Now on piece …", or
   "N segments can't play". This fails and names the file and line. */
test("no listener-facing string in the app or the player uses the production vocabulary", () => {
  const hits = [];
  for (const file of LISTENER_FILES) {
    const src = read(file);
    const lines = src.split("\n");
    for (const { text, line } of literals(src)) {
      /* An HTML comment inside a template is markup, never rendered text. */
      const shown = text.replace(/<!--[\s\S]*?-->/g, "");
      if (!isProse(shown) || !JARGON.test(shown)) continue;
      const code = lines[line - 1] || "";
      if (/console\.|diag\.\w+\(|new Error\(/.test(code)) continue;
      if (NOT_LISTENER_FACING.some(([f, frag]) => f === file && code.includes(frag))) continue;
      hits.push(`${file}:${line}: "${text.trim().slice(0, 80)}"`);
    }
  }
  assert.deepStrictEqual(hits, [], `listener copy uses a production word (say "clip", "part", "this foray"):\n${hits.join("\n")}`);
});

/* THE SCANNER CAN SEE. A lexer that silently skipped template literals would
   pass the test above on any file. These are strings it MUST return from the
   real sources — including a multi-line template's static text and a string
   inside an interpolation. MUTATION: make readTemplate push nothing. */
test("the scanner reads plain strings, template text across lines, and strings inside interpolations", () => {
  const texts = (file) => literals(read(file)).map((l) => l.text);
  const app = texts("app.js");
  assert.ok(app.some((t) => t.includes("Nothing saved yet")), "a plain template-literal note");
  assert.ok(app.some((t) => t.includes("Nothing in this part yet.")), "static text of a multi-line template");
  assert.ok(app.some((t) => t === "Jingle between clips"), "a double-quoted argument");
  assert.ok(texts("player/client.js").some((t) => t === "Back to this foray"), "the player's back link");
  const synthetic = literals('x = `a ${cond ? "Previous segment" : `b`} c`;').map((l) => l.text);
  assert.ok(synthetic.includes("Previous segment"), `a string inside an interpolation: ${synthetic}`);
  assert.ok(!literals("const r = /segment is/;").some((l) => /segment/.test(l.text)), "a regex literal is code, not copy");
});

/* ------------------------------------------------------------------ */
/* Sticky copy — each string that outlived its cause                   */
/* ------------------------------------------------------------------ */

const STALE = [
  // [what, pattern, why it is wrong]
  ["pull to refresh", /pull to refresh/i, "there is no pull-to-refresh gesture anywhere in 4a"],
  ["home-screen builder", /build one from the home screen/i, "the playlist builder left Home on 2026-09-03"],
  /* "This browser has taken storage away." (deletionMessage) is left to the
     delete-my-data lane, which is rewriting that function's result copy. */
  ["browser copy", /your browser|reload the page|on this page, so the probe/i, "the same bytes run in a native shell with no visible browser"],
  ["four topic queues", /four topic queues/i, "Home has not been four topic cards since the U-11 cutover"],
  ["daily claim", /today's queue/i, "buildCards() re-deals on every load; nothing is daily"],
  ["raw resolver reason", /Can't play:/, "foray-resolve's reasons name our data files"],
  ["download plumbing", /so the download counts for them/i, "royalty plumbing a listener cannot act on"],
  ["Audition", /^Audition$|Tap Audition/m, "a casting word; every voice picker says Preview"],
  ["trial voices", /trial voices/i, "reads as a paid trial"],
  ["Reset to learned", /Reset to learned|overrule what 4a/i, "not English a listener uses"],
  ["seam gaps", /seam gaps|out-point overshoot|load deadlines/i, "diagnostics described in pipeline words"],
  ["usual topics", /usual topics/i, "the bridge line beneath it says 'subjects'"],
  /* docs/DECISIONS.md 2026-08-11 (the playback ruling): "clipping" and
     "stitching" read as the rejected Stitcher/Luminary behaviour, and "copy
     must follow the mechanism: no user-facing language implying we produce a
     new audio file". A foray plays each moment from the show's own feed. */
  ["stitching", /stitch/i, "the 2026-08-11 playback ruling: no copy implying we produce a new audio file"],
  ["clipping", /we clip|clip the best/i, "the 2026-08-11 playback ruling, same reason"],
];

/* MUTATION: restore any one of the stale strings (e.g. "Pull to refresh." in
   BODY_PLACEHOLDER). That row fails, by name, with its reason. The scan runs
   over the listener literals only, so a comment quoting the old copy — which
   this repo writes on purpose — cannot trip it. */
test("no string that outlived its cause is back in the app's copy", () => {
  const copy = literals(APP_SRC).map((l) => l.text).join("\n");
  const failures = [];
  for (const [what, re, why] of STALE) {
    if (re.test(copy)) failures.push(`${what}: ${why}`);
  }
  assert.deepStrictEqual(failures, []);
});

/* ------------------------------------------------------------------ */
/* Behaviour behind the copy                                           */
/* ------------------------------------------------------------------ */

function mountApp() {
  const store = new Map();
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: "", textContent: "", hidden: false, value: "", dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [], append() {}, appendChild(k) { return k; },
      });
    }
    return els.get(id);
  };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body: el("body"), documentElement: el("html"), readyState: "complete",
      addEventListener() {}, createElement: () => el(`x${els.size}`),
      querySelector: (sel) => (String(sel).startsWith("#") ? el(String(sel).slice(1)) : (sel === ".hv2-greeting-word" ? el("greeting") : null)),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" }, addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} }, CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.catalog = { shows: [] }; state.discover = { items: [] }; state.taxonomy = { nodes: [] };
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] }; state.cardSlots = [];
  return { ctx, el, state };
}

/* qa row 136: 210 of the pool's titles end in ? ! or ., and the card appended a
   full stop regardless ("…Save The World?."). MUTATION: always append ".". */
test("'Starts with' closes its sentence once, whatever the title ends with", () => {
  /* Typographic quotes since audit round 2 (copy-8): one `quoteQuery` helper
     for every quoted listener string. */
  const { ctx } = mountApp();
  assert.strictEqual(ctx.startsWithLine("Can Fusion Save The World?"), "Starts with “Can Fusion Save The World?”");
  assert.strictEqual(ctx.startsWithLine("Gearboxes, alive!"), "Starts with “Gearboxes, alive!”");
  assert.strictEqual(ctx.startsWithLine("The Fed"), "Starts with “The Fed.”");
});

/* qa row 148: on a short screen the hook clamps to one line, so the title — the
   one concrete fact on the card — must come first. MUTATION: put the blurb
   back in front of startsWithLine in miniCard's hook. */
test("the subject card's hook leads with the episode it starts with", () => {
  /* Up to the function's end, not a fixed width: L5 added a comment above the
     count at integration, which pushed the hook past a 900-character window. */
  const at = APP_SRC.indexOf("function miniCard(slot)");
  const body = APP_SRC.slice(at, APP_SRC.indexOf("\n}\n", at));
  assert.match(body, /<p class="mc-hook">\$\{startsWithLine\(item\.title\)\} \$\{esc\(subjectBlurb\(slot\)\)\}<\/p>/);
});

/* qa row 193: the greeting was computed once per render. MUTATION: drop the
   refreshGreeting() call from init()'s foreground hook, or make it recompute
   nothing. */
test("the greeting is recomputed when the app returns to the foreground", () => {
  const { ctx, el } = mountApp();
  ctx.refreshGreeting(new Date(2026, 8, 22, 7, 0));
  assert.strictEqual(el("greeting").textContent, "Good morning");
  ctx.refreshGreeting(new Date(2026, 8, 22, 21, 0));
  assert.strictEqual(el("greeting").textContent, "Good evening");
  const hook = APP_SRC.slice(APP_SRC.indexOf('refreshForayDirectory("foreground");'), APP_SRC.indexOf('refreshForayDirectory("foreground");') + 80);
  assert.match(hook, /refreshGreeting\(\);/, "the foreground hook must refresh it");
});

/* qa row 103: clearing the search left "Showing shows available offline" up.
   MUTATION: drop the #sh-offline-note line from clearShowSearchResults. */
test("clearing the show search takes the offline note down with it", () => {
  const { ctx, el } = mountApp();
  el("sh-offline-note").hidden = false;
  ctx.clearShowSearchResults();
  assert.strictEqual(el("sh-offline-note").hidden, true);
});

/* qa row 138: both shell notices ended "Reload to get the current version.",
   and for a stale shell in a dead zone a reload reproduces the notice.
   MUTATION: give the two reasons one shared remedy again. */
test("each shell notice carries its own remedy", () => {
  const { ctx } = mountApp();
  const remedy = vm.runInContext("SHELL_REMEDY", ctx);
  assert.notStrictEqual(remedy["stale-shell"], remedy["generation-changed"]);
  assert.match(remedy["stale-shell"], /back online/);
  const notices = vm.runInContext("SHELL_NOTICE", ctx);
  for (const v of Object.values(notices)) assert.ok(!/this page/.test(v), `"this page" inside a native shell: ${v}`);
});

/* qa row 112: the playlist builder left the last query's failure note up while
   building the next. The one builder is Create's since audit round 2
   (p-first-6; #/playlists' form is gone). MUTATION: drop the staleNote hide in
   bindCreateFormSubmit. */
test("the playlist builder hides the last query's note before building the next", () => {
  const body = APP_SRC.slice(APP_SRC.indexOf("function bindCreateFormSubmit"), APP_SRC.indexOf("function bindCreateFormSubmit") + 900);
  const hide = body.indexOf("staleNote.hidden = true");
  assert.ok(hide > 0, "the stale note must be hidden");
  /* The build is deferred by whenSearchDataReady since L5 (it waits for the
     search documents the first route no longer awaits). */
  assert.ok(hide < body.indexOf("whenSearchDataReady("), "and hidden BEFORE the build starts, not after");
});

/* qa row 62: the clear-search ✕ was bound to mousedown only; Enter and Space
   fire click. MUTATION: remove the click listener. */
test("the clear-search control answers the keyboard", () => {
  const body = APP_SRC.slice(APP_SRC.indexOf('const dismiss = $("#sh-dismiss");\n  if (dismiss) {'));
  const block = body.slice(0, 2400);
  assert.match(block, /dismiss\.addEventListener\("click", \(e\) => \{\s*if \(e && e\.detail !== 0\) return;\s*dismissShowSearch\(input\);/);
});

/* qa rows 73, 74: search results were silent to a screen reader, and six text
   fields were named by their placeholder only. MUTATION: drop aria-label from
   any of the inputs, or the live-region attributes from either note. */
test("every text field has a name that survives typing, and search notes are live regions", () => {
  const inputs = [...APP_SRC.matchAll(/<input [^>]*type="text"[^>]*>/g)].map((m) => m[0]);
  /* Four since audit round 2 (p-first-6): the #/playlists builder's field
     left with the builder; Create's is the one playlist field. */
  assert.ok(inputs.length >= 4, `expected the app's text inputs, found ${inputs.length}`);
  for (const i of inputs) assert.match(i, /aria-label="[^"]+"/, `a text field named only by its placeholder: ${i}`);
  assert.match(APP_SRC, /typedInput\.setAttribute\("aria-label", /);
  assert.match(APP_SRC, /<p id="sh-note" class="note" role="status" aria-live="polite" hidden><\/p>/);
  assert.match(APP_SRC, /data-show-ep-search-note role="status" aria-live="polite" hidden/);
  assert.match(APP_SRC, /<form id="sh-form" role="search"/);
});

/* Persona row 62: a Foray row that cannot play printed foray-resolve's raw
   reason. The reason stays on the row for a field report, off screen.
   MUTATION: render `entry.reason` as the row's text again. */
test("an unplayable clip says so in plain words and keeps the raw reason off screen", () => {
  const { ctx } = mountApp();
  const html = ctx.forayRow({ playable: false, why: "Why", show: "", reason: "segment x is not in data/segments.json", duration_sec: 0 });
  assert.ok(html.includes("This clip isn't available right now."));
  assert.ok(!/>[^<]*data\/segments\.json/.test(html), `a file path reached the listener: ${html}`);
  assert.ok(html.includes('data-reason="segment x is not in data/segments.json"'));
});

/* Persona row 68: taxonomy ids printed under every slider. MUTATION: put the
   `interest-row-path` span back. */
test("the Interests rows show a label, never a taxonomy id", () => {
  const { ctx, state } = mountApp();
  state.interests = { "engineering/energy-fusion": 0.7 };
  const html = ctx.interestSliderRow({ id: "engineering/energy-fusion", label: "Fusion", parent: "engineering", weight: 0.5 });
  assert.ok(!html.includes(">engineering/energy-fusion<"), html);
  assert.match(html, />Back to 4a's pick</);
  assert.match(html, /aria-label="Fusion: back to 4a(&#39;|')s pick"/, "each reset names its row");
});

test("REVIEW: the returning-listener popup claims a stretch pick only where Home actually has one", () => {
  /* It said playlists AND episodes each carry one pick outside the listener's
     subjects; Playlists for you has no stretch logic (and is mostly their own
     playlists), while Forays for you — which it did not name — does.
     MUTATION: put "playlists" back into the popup's stretch sentence. */
  const body = (name) => {
    const at = APP_SRC.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `app.js defines ${name}`);
    return APP_SRC.slice(at, APP_SRC.indexOf("\n}\n", at));
  };
  const hasStretch = {
    forays: /pickWithStretchFloor/.test(body("foraysForYouHtml")),
    playlists: /pickWithStretchFloor|stretch/.test(body("playlistsForYouHtml")),
    episodes: /miniCardV2/.test(body("episodesForYouHtml")) && /role !== "stretch"/.test(body("miniCardV2")),
  };
  assert.deepStrictEqual(hasStretch, { forays: true, playlists: false, episodes: true }, "fixture: where the stretch picks live");
  const popup = literals(APP_SRC).map((l) => l.text).find((t) => /outside your usual subjects/.test(t));
  assert.ok(popup, "the popup sentence exists");
  const claim = popup.split(/(?<=\.)\s+/).find((sentence) => /outside your usual subjects/.test(sentence));
  for (const [section, has] of Object.entries(hasStretch)) {
    const named = new RegExp(`\\b${section}\\b`, "i").test(claim);
    assert.strictEqual(named, has, `the stretch claim ${has ? "must" : "must not"} name ${section}: "${claim}"`);
  }
});
