/* CH-1 (#1071) — chapters on the episode page, visible.
 *
 * Before this card `item.chapters` was null on every production episode, so
 * the chapter section never rendered, and the only chapter rows that existed
 * were inside the collapsed "Episode notes". WHAT THIS PROVES:
 *  a. Feed chapters win over stamps typed into the notes.
 *  b. With no feed chapters, a notes chapter list (2+ stamps, ascending) is a
 *     visible section OUTSIDE details.ep-description.
 *  c. One stamp, or stamps out of order, is prose: no section.
 *  d. Six rows show; the rest sit in "All N chapters".
 *  e. Times are honest: the real player/seek-policy.js decides, an unknown
 *     DAI class reads approximate, and so does a page with no policy loaded.
 *  g. A starred long episode keeps chapters past the 4000-character cut.
 *  h. The phone reads the chapters (founder on #1071, "Phone reads the MP3"):
 *     podcast:chapters JSON through CapacitorHttp, then the ID3 reader; once
 *     per episode per session, silent on failure, never after the route moved.
 *  i. window.ForayChapters.forItem is the list the page renders.
 * Each test names the one-line mutation that kills it, and each was run.
 *
 * Harness: the node:vm DOM stub of test/show-page.test.js, plus a #view that
 * answers `[data-ts]` from the markup the render wrote (episode-deeplink's
 * shape) and `.ep-chapters` with a node whose outerHTML setter rewrites that
 * markup, as a browser's does.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const seekPolicy = () => import(pathToFileURL(path.join(ROOT, "player", "seek-policy.js")).href);

process.on("unhandledRejection", () => {});

/* The real seek policy, loaded once: approximate chapter rows render only once
   it is published (code-health CH-33), as on a device, where client.js imports
   it before the first route renders. `mount({ policy: null })` is the page
   before the module has run. */
let POLICY = null;
before(async () => { POLICY = await seekPolicy(); });

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const SECTION_RE = /<section class="ep-chapters">[\s\S]*?<\/section>/;

function mount({ hash = "#/", native = null, policy } = {}) {
  const byId = new Map();
  const el = (id) => { if (!byId.has(id)) { const e = makeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id); };
  const view = el("view");
  view.querySelectorAll = (sel) => {
    if (sel !== "[data-ts]") return [];
    return [...view.innerHTML.matchAll(/<button\b([^>]*\bdata-ts="([^"]*)"[^>]*)>/g)].map((m) => ({
      attrs: m[1], dataset: { ts: m[2] }, addEventListener() {},
    }));
  };
  view.querySelector = (sel) => {
    if (sel === ".ep-chapters" && SECTION_RE.test(view.innerHTML)) {
      return { set outerHTML(h) { view.innerHTML = view.innerHTML.replace(SECTION_RE, h); } };
    }
    if (sel === ".ep-description" && view.innerHTML.includes('class="ep-description"')) {
      return { insertAdjacentHTML(_where, h) { view.innerHTML = view.innerHTML.replace(/<\/details>/, `</details>${h}`); } };
    }
    return null;
  };
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {}, info() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => (/^#[\w-]+$/.test(String(sel)) ? el(String(sel).slice(1)) : null),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" + hash, protocol: "https:" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  if (native) ctx.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", nativePromise: native };
  if (native) ctx.ForayId3Chapters = id3Stub();
  if (policy !== null) ctx.ForaySeekPolicy = policy ?? POLICY;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  return {
    ctx, state, view,
    html: () => view.innerHTML,
    section: () => (SECTION_RE.exec(view.innerHTML) || [""])[0],
    render(item) { state.itemIndex[item.id] = item; ctx.renderEpisode(item.id); },
  };
}

/* What client.js publishes as window.ForayId3Chapters, minus the MP3 read: the
   transport rules readDeviceChapters takes (CH-33) and a reader that finds no
   tag. A test that reads ID3 replaces it. */
const id3Stub = (over = {}) => ({ forUrl: async () => [], CALL_TIMEOUT_MS: 10_000, shellUserAgent: () => null, ...over });

const ticks = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const titles = (html) => [...html.matchAll(/<span class="ep-chapter-title">([^<]*)<\/span>/g)].map((m) => m[1]);
const NOTES3 = "Welcome to the show.\n0:00 Cold open\n12:30 The main story\n45:10 Listener mail\nThanks for listening.";
const ep = (over = {}) => ({ id: "ep-1", title: "Ep", show: "Show", hook: "hook", audio_url: "https://x.test/a.mp3", duration_sec: 3600, ...over });

/* ---------- a/b/c: the source ---------- */

test("(a) feed chapters win over stamps typed into the notes", () => {
  /* MUTATION: in episodeChapterList, `if (feed.length)` -> `if (false && feed.length)`
     (prefer the description) — the section lists the notes' rows; red. */
  const m = mount();
  m.render(ep({ description: NOTES3, chapters: [{ title: "Feed one", start_time_seconds: 0 }, { title: "Feed two", start_time_seconds: 90 }] }));
  assert.deepStrictEqual(titles(m.section()), ["Feed one", "Feed two"]);
});

test("(b) no feed chapters + three ascending stamp lines: a visible section outside the collapsed notes", () => {
  /* MUTATION: make episodeChapterList end `return [];` (today's empty
     item.chapters -> "") — no section; red. */
  const m = mount();
  m.render(ep({ description: NOTES3, chapters: null }));
  const html = m.html();
  const sec = m.section();
  assert.ok(sec, "a chapters section renders");
  assert.deepStrictEqual(titles(sec), ["Cold open", "The main story", "Listener mail"]);
  const notesEnd = html.indexOf("</details>", html.indexOf('class="ep-description"'));
  assert.ok(notesEnd > 0 && html.indexOf(sec) > notesEnd, "the section is not inside details.ep-description");
  assert.match(sec, /data-ts="750"/, "rows are data-ts seek controls");
});

test("(c) one stamp line, or stamps out of order, is prose: no section", () => {
  /* MUTATION: drop the guard in descriptionChapters (`if (rows.length < 2 || …) return [];`
     -> `if (false)`) — both cases render a section; red. */
  const m = mount();
  m.render(ep({ description: "We talk at length.\n12:30 The main story\nBye." }));
  assert.strictEqual(m.section(), "", "a single stamp is not a chapter list");
  m.render(ep({ id: "ep-2", description: "0:00 Open\n30:00 Late\n10:00 Back in time" }));
  assert.strictEqual(m.section(), "", "stamps out of order are not a chapter list");
});

/* ---------- d: the cap ---------- */

test("(d) ten chapters: six rows visible, the other four inside 'All 10 chapters'", () => {
  /* MUTATION: `const CHAPTERS_VISIBLE = 7;` — seven visible, three folded; red. */
  const m = mount();
  const chapters = Array.from({ length: 10 }, (_, i) => ({ title: `C${i + 1}`, start_time_seconds: i * 60 }));
  m.render(ep({ chapters }));
  const sec = m.section();
  const [visible, folded = ""] = sec.split('<details class="ep-chapters-more">');
  assert.strictEqual(titles(visible).length, 6);
  assert.match(folded, /<summary>All 10 chapters<\/summary>/);
  assert.deepStrictEqual(titles(folded), ["C7", "C8", "C9", "C10"]);
  m.render(ep({ id: "ep-6", chapters: chapters.slice(0, 6) }));
  assert.doesNotMatch(m.section(), /ep-chapters-more/, "six chapters need no disclosure");
});

/* ---------- e: precision ---------- */

test("(e) precision: stitched and unclassified read '~68 min', a classified static show '1:08:00'; with no policy loaded nothing guesses", async () => {
  /* MUTATION 1: `source: p.FOREIGN` -> `source: "own"` in chapterPrecision — the
     stitched row reads 1:08:00; red.
     MUTATION 2: drop `|| item?.dai_known === false` — the unclassified row reads
     1:08:00; red.
     MUTATION 3: chapterPrecision's catch `return "exact"` — with no policy the
     row reads 1:08:00; red.
     MUTATION 4 (CH-33, P2-13): put back an inline `~${mins} min` fallback in
     chapterStamp/episodeChaptersHtml — the page before the policy loads prints
     app.js's own copy of the approximate wording; red. */
  const chapters = [{ title: "Intro", start_time_seconds: 0 }, { title: "The turn", start_time_seconds: 4080 }];
  const bare = mount({ policy: null });
  bare.render(ep({ id: "bare", chapters, dai_known: true, dai_suspected: false }));
  assert.strictEqual(bare.section(), "", "no policy loaded: no row guesses at its wording, and none reads exact");
  assert.doesNotMatch(bare.html(), /~68 min|around minute|1:08:00/);

  const m = mount();
  m.render(ep({ id: "dai", chapters, dai_known: true, dai_suspected: true }));
  let sec = m.section();
  assert.match(sec, /<span class="ep-chapter-time">~68 min<\/span>/);
  assert.match(sec, /aria-label="Play from around minute 68, The turn"/);
  assert.match(sec, /<p class="ep-chapters-note">Times are approximate on this show\.<\/p>/);

  m.render(ep({ id: "clean", chapters, dai_known: true, dai_suspected: false }));
  sec = m.section();
  assert.match(sec, /<span class="ep-chapter-time">1:08:00<\/span>/);
  assert.match(sec, /aria-label="Play from 1:08:00, The turn"/);
  assert.doesNotMatch(sec, /ep-chapters-note/, "exact times carry no caveat");

  m.render(ep({ id: "unknown", chapters, dai_known: false, dai_suspected: false }));
  assert.match(m.section(), /~68 min/, "an unclassified show reads approximate");
});

test("chapter rows: blank titles are numbered, \\r is trimmed, art only over https, a chapter with no start is dropped", async () => {
  /* MUTATION: drop `c.start_time_seconds != null &&` in episodeChapterList —
     the null-start chapter seeks to 0:00 as "Chapter 1"; red on the titles.
     MUTATION 2: drop `/^https:/i.test(c.img) &&` in chapterEntry — the http art
     renders; red.
     MUTATION 3: render `safeUrl(c.img)` without artUrl in episodeChaptersHtml —
     Apple's 600 px chapter art is fetched for a 40 px box; red here and in
     boot-path perf-2 (sweep). */
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  m.render(ep({
    dai_known: true,
    chapters: [
      { title: "No start", start_time_seconds: null },
      { title: "Opening\r", start_time_seconds: 5, img: "https://img.test/a.jpg" },
      { title: "  ", start_time_seconds: 65, img: "http://img.test/b.jpg" },
      { title: "Apple art", start_time_seconds: 90, img: "https://is1-ssl.mzstatic.com/image/thumb/P/v4/mza_1.jpg/600x600bb.jpg" },
    ],
  }));
  const sec = m.section();
  assert.deepStrictEqual(titles(sec), ["Opening", "Chapter 2", "Apple art"]);
  assert.match(sec, /<img class="ep-chapter-img" src="https:\/\/img\.test\/a\.jpg" alt="" loading="lazy" decoding="async" width="40" height="40">/,
    "a publisher's own chapter art is left at its address");
  assert.doesNotMatch(sec, /img\.test\/b\.jpg/);
  assert.match(sec, /mza_1\.jpg\/120x120bb\.jpg"/, "Apple's chapter art is asked for at the 40 px box's size, not 600 px");
});

/* ---------- g: the saved copy ---------- */

test("(g) a starred long episode keeps the chapters written past the 4000-character cut", () => {
  /* MUTATION: derive from the cut text — `descriptionChapters(d, …)` ->
     `descriptionChapters(out.description, …)` in savableEpisode — only the
     first stamp survives, which is no list; red. */
  const m = mount();
  const description = `0:00 Intro\n${"word ".repeat(1100)}\n20:00 Middle\n40:00 End\n${"x".repeat(900)}`;
  assert.ok(description.length > 6000 && description.indexOf("20:00") > 4000, "fixture: stamps after char 4000");
  const saved = m.ctx.savableEpisode(m.ctx.snapshot("long", ep({ id: "long", description })));
  assert.ok(saved.description.length <= 4000, "the notes are still cut");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.chapters)), [
    { title: "Intro", start_time_seconds: 0, source: "description" },
    { title: "Middle", start_time_seconds: 1200, source: "description" },
    { title: "End", start_time_seconds: 2400, source: "description" },
  ], "no null img/url keys: 100 of them on every star broke boot-path app-1-8's size bound");
  m.render(saved);
  assert.deepStrictEqual(titles(m.section()), ["Intro", "Middle", "End"], "the saved copy renders all three");
});

test("(g2) a starred episode's feed chapters keep their art and link, and only the keys that carry a value", () => {
  /* MUTATION: write `img: c?.img ?? null, url: c?.url ?? null` again in
     savableEpisode — every chapter carries two null keys; red on the shape.
     MUTATION 2: drop the `img` spread in savableEpisode — the saved copy loses
     the chapter art; red. */
  const m = mount();
  const chapters = [
    { title: "Art", start_time_seconds: 0, img: "https://img.test/a.jpg", url: "https://pub.test/a", extra: "dropped" },
    { title: "Plain", start_time_seconds: 60 },
  ];
  const saved = m.ctx.savableEpisode(m.ctx.snapshot("feed", ep({ id: "feed", dai_known: true, chapters })));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.chapters)), [
    { title: "Art", start_time_seconds: 0, img: "https://img.test/a.jpg", url: "https://pub.test/a" },
    { title: "Plain", start_time_seconds: 60 },
  ]);
  m.render(saved);
  assert.match(m.section(), /src="https:\/\/img\.test\/a\.jpg"/, "the saved copy still draws the chapter art");
});

/* ---------- h: the device reads the chapters ---------- */

const JSON_BODY = { version: "1.2.0", chapters: [{ startTime: 0, title: "Json one" }, { startTime: 30, title: "Silent", toc: false }, { startTime: 95.5, title: "Json two" }] };

test("(h) podcast:chapters JSON is read once per episode, across renders, and replaces only the chapter section", async () => {
  /* MUTATION: in hydrateFeedChapters, drop the memo — `if (!deviceChapterMemo.has(item.id))`
     -> `if (true)` — two renders make two requests; red. */
  let resolve;
  const calls = [];
  const m = mount({ hash: "#/episode/ep-h", native: (plugin, method, opts) => { calls.push([plugin, method, opts.url]); return new Promise((r) => { resolve = r; }); } });
  const item = ep({ id: "ep-h", description: NOTES3, chapters_url: "https://pub.test/ch.json" });
  m.render(item);
  m.render(item);
  assert.deepStrictEqual(calls, [["CapacitorHttp", "request", "https://pub.test/ch.json"]], "one request across two renders");
  assert.deepStrictEqual(titles(m.section()), ["Cold open", "The main story", "Listener mail"], "the notes' list shows meanwhile");
  resolve({ status: 200, data: JSON_BODY });
  await ticks();
  assert.deepStrictEqual(titles(m.section()), ["Json one", "Json two"], "`toc: false` is not a row");
  assert.match(m.html(), /class="ep-description"/, "the notes stay");
  assert.strictEqual(m.state.itemIndex["ep-h"].chapters[1].start_time_seconds, 95.5);
  m.render(item);
  await ticks();
  assert.strictEqual(calls.length, 1, "a later visit makes no request");
});

test("(h) a 404 is silent and the notes' chapters stay", async () => {
  /* The 404 carries a body shaped like chapters, as an API error page can.
     MUTATION: `if (res?.status === 200)` -> `if (res)` in readDeviceChapters —
     the error body is painted as the chapter list; red. (Dropping
     `!rows.length ||` from the hydrate guard instead never settles: an empty
     answer repaints and re-asks the memo forever, so that mutation hangs the
     suite rather than failing an assert.) */
  const m = mount({ hash: "#/episode/ep-404", native: async () => ({ status: 404, data: { chapters: [{ startTime: 0, title: "Not" }, { startTime: 9, title: "Found" }] } }) });
  const item = ep({ id: "ep-404", description: NOTES3, chapters_url: "https://pub.test/missing.json", chapters: null });
  m.render(item);
  await ticks();
  assert.strictEqual(item.chapters, null);
  assert.deepStrictEqual(titles(m.section()), ["Cold open", "The main story", "Listener mail"]);
});

test("(h) an answer that lands after the listener left the page writes nothing", async () => {
  /* MUTATION: drop `|| !m || safeDecode(m[1]) !== item.id` from the hydrate
     guard — the late answer is written into an episode the listener left; red. */
  let resolve;
  const m = mount({ hash: "#/episode/ep-r", native: () => new Promise((r) => { resolve = r; }) });
  const item = ep({ id: "ep-r", description: NOTES3, chapters_url: "https://pub.test/ch.json" });
  m.render(item);
  const before = m.html();
  m.ctx.location.hash = "#/shows";
  resolve({ status: 200, data: JSON_BODY });
  await ticks();
  assert.strictEqual(item.chapters, undefined, "no write to the item");
  assert.strictEqual(m.html(), before, "no write to the page");
});

test("(h) source order: JSON beats ID3; with no chapters_url the MP3's ID3 chapters are read; off the shell nothing is requested", async () => {
  /* MUTATION 1: delete the ID3 block in readDeviceChapters — the second page
     keeps the notes' rows; red.
     MUTATION 2: drop `!isNativeShell() ||` from the hydrate guard — the web
     page makes a request; red. */
  const id3Calls = [];
  const id3 = id3Stub({ forUrl: async (url, opts) => { id3Calls.push([url, opts.id]); return [{ secs: 0, title: "Tag one" }, { secs: 61, title: "Tag two", img: "https://img.test/t.jpg" }]; } });
  const m = mount({ hash: "#/episode/ep-j", native: async () => ({ status: 200, data: JSON.stringify(JSON_BODY) }) });
  m.ctx.ForayId3Chapters = id3;
  m.render(ep({ id: "ep-j", description: NOTES3, chapters_url: "https://pub.test/ch.json" }));
  await ticks();
  assert.deepStrictEqual(titles(m.section()), ["Json one", "Json two"], "a JSON string body parses too");
  assert.deepStrictEqual(id3Calls, [], "JSON answered, so the MP3 is not read");

  m.ctx.location.hash = "#/episode/ep-k";
  m.render(ep({ id: "ep-k", description: NOTES3, audio_url: "https://cdn.test/k.mp3" }));
  await ticks();
  assert.deepStrictEqual(id3Calls, [["https://cdn.test/k.mp3", "ep-k"]]);
  assert.deepStrictEqual(titles(m.section()), ["Tag one", "Tag two"]);

  let webCalls = 0;
  const web = mount({ hash: "#/episode/ep-w" });
  web.ctx.ForayId3Chapters = { forUrl: async () => { webCalls += 1; return []; } };
  web.ctx.Capacitor = { nativePromise: async () => { webCalls += 1; return { status: 200, data: JSON_BODY }; } };
  web.ctx.Capacitor.isNativePlatform = () => false;
  web.render(ep({ id: "ep-w", description: NOTES3, chapters_url: "https://pub.test/ch.json" }));
  await ticks();
  assert.strictEqual(webCalls, 0, "the web page asks no publisher for chapters");
});

/* ---------- i: one list ---------- */

test("(i) window.ForayChapters.forItem is exactly the list the page renders", async () => {
  /* MUTATION: publish `forItem: (it) => descriptionChapters(it.description)` —
     a second derivation that ignores the feed; red on the deep-equal. */
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  const item = ep({ description: NOTES3, dai_known: true, chapters: [{ title: "Feed one", start_time_seconds: 3 }, { title: "", start_time_seconds: 70, url: "https://pub.test/x" }] });
  m.render(item);
  const list = JSON.parse(JSON.stringify(m.ctx.ForayChapters.forItem(item)));
  const rows = [...m.section().matchAll(/data-ts="([^"]*)"[\s\S]*?<span class="ep-chapter-title">([^<]*)<\/span>/g)].map((r) => [Number(r[1]), r[2]]);
  assert.deepStrictEqual(list.map((c) => [c.secs, c.title]), rows);
  assert.deepStrictEqual(list, [
    { secs: 3, title: "Feed one", img: null, url: null, source: "feed" },
    { secs: 70, title: "Chapter 2", img: null, url: "https://pub.test/x", source: "feed" },
  ]);
  assert.strictEqual(m.ctx.ForayChapters.precision(item), "exact");
});

/* ---------- CH-33: characterization, pinned before the change ---------- */

const notesHtml = (html) => (/<details class="ep-description">[\s\S]*?<\/details>/.exec(html) || [""])[0];
const rowsOf = (html) => [...html.matchAll(/<button type="button" class="ep-chapter-row" data-ts="(\d+)" aria-label="([^"]*)">(?:<img[^>]*>)?<span class="ep-chapter-time">([^<]*)<\/span><span class="ep-chapter-title">([^<]*)<\/span><\/button>/g)]
  .map((r) => ({ ts: Number(r[1]), label: r[2], time: r[3], title: r[4] }));

test("CH-33 characterization: feed chapters on a classified static show read exact, one row each", async () => {
  /* Pinned before CH-33 moved the stamp text into one helper: the exact
     branch keeps fmtChapterTime's clock. MUTATION: the exact branch prints
     formatTimestamp(…, precision) for an approximate-looking precision — any
     "~" here; red. */
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  m.render(ep({ id: "exact3", dai_known: true, dai_suspected: false, chapters: [
    { title: "Open", start_time_seconds: 0 }, { title: "Middle", start_time_seconds: 754 }, { title: "Late", start_time_seconds: 4092 },
  ] }));
  assert.deepStrictEqual(rowsOf(m.section()), [
    { ts: 0, label: "Play from 0:00, Open", time: "0:00", title: "Open" },
    { ts: 754, label: "Play from 12:34, Middle", time: "12:34", title: "Middle" },
    { ts: 4092, label: "Play from 1:08:12, Late", time: "1:08:12", title: "Late" },
  ]);
  assert.doesNotMatch(m.section(), /ep-chapters-note/);
});

test("CH-33 characterization: a DAI show's notes-derived chapters read '~N min' with the approximate note", async () => {
  const m = mount();
  m.ctx.ForaySeekPolicy = await seekPolicy();
  m.render(ep({ id: "dai-notes", dai_known: true, dai_suspected: true, duration_sec: 5400, chapters: null,
    description: "0:00 Cold open\n1:08:12 The turn" }));
  assert.deepStrictEqual(rowsOf(m.section()), [
    { ts: 0, label: "Play from around minute 0, Cold open", time: "~0 min", title: "Cold open" },
    { ts: 4092, label: "Play from around minute 68, The turn", time: "~68 min", title: "The turn" },
  ]);
  assert.match(m.section(), /<p class="ep-chapters-note">Times are approximate on this show\.<\/p>/);
});

test("CH-33 characterization: the podcast:chapters JSON request carries the shell's User-Agent", async () => {
  /* The reader is the real player/id3-chapters.js one, built over the same
     downloads surface client.js hands it, so this holds before CH-33 (app.js
     read window.forayDownloads.userAgent itself) and after (it asks the
     reader). MUTATION: send `headers: {}` in readDeviceChapters; red. */
  const { createId3Reader } = await import(pathToFileURL(path.join(ROOT, "player", "id3-chapters.js")).href);
  const seen = [];
  const m = mount({ hash: "#/episode/ep-ua", native: async (_p, _m, opts) => { seen.push(opts.headers); return { status: 200, data: JSON_BODY }; } });
  m.ctx.forayDownloads = { userAgent: "4a/1.2 (shell)" };
  m.ctx.ForayId3Chapters = createId3Reader({ getBridge: () => m.ctx.Capacitor, getDownloads: () => m.ctx.forayDownloads });
  m.render(ep({ id: "ep-ua", description: NOTES3, chapters_url: "https://pub.test/ch.json" }));
  await ticks();
  assert.deepStrictEqual(seen.map((h) => ({ ...h })), [{ "User-Agent": "4a/1.2 (shell)" }]);
  assert.deepStrictEqual(titles(m.section()), ["Json one", "Json two"]);
});

/* ---------- CH-33: chapter rows say one thing ---------- */

test("CH-33 (A2-05): a DAI show with chapters only in the notes — the Chapters section and Episode notes print the same time and label for every stamp", () => {
  /* The bug: the section read "~68 min" under "Times are approximate" while
     the notes' promoted rows printed the publisher's "1:08:12" exactly.
     MUTATION: chapterRowToken `if (precision == null) return row;` ->
     `return row;` (the notes keep the stamp as written) -> red on both
     shows. MUTATION 2: episodeDescriptionSectionHtml stops passing
     chapterPrecision(item) -> red the same way. */
  const description = "Welcome.\n00:00 Cold open\n1:08:12 The turn\nThanks.";
  for (const [id, cls, want] of [
    ["dai", { dai_known: true, dai_suspected: true }, ["~0 min", "~68 min"]],
    ["clean", { dai_known: true, dai_suspected: false }, ["0:00", "1:08:12"]],
  ]) {
    const m = mount();
    m.render(ep({ id, ...cls, duration_sec: 5400, chapters: null, description }));
    const section = rowsOf(m.section());
    const notes = rowsOf(notesHtml(m.html()));
    assert.deepStrictEqual(section.map((r) => r.time), want, `${id}: the section's clock`);
    assert.deepStrictEqual(notes, section, `${id}: the notes' rows are the section's rows, word for word`);
    assert.doesNotMatch(notesHtml(m.html()), id === "dai" ? /1:08:12|00:00/ : /00:00/, `${id}: no stamp as written survives in a row`);
  }
});

test("CH-33 (A2-05): a lone stamp-led line in the notes is an inline seek stamp, not a 44 px chapter row — the section's two-ascending rule", () => {
  /* MUTATION: `const isList = isChapterList(…)` -> `const isList = true` in
     episodeNotesTokens -> the lone line is promoted to .ep-chapter-row; red. */
  const m = mount();
  m.render(ep({ id: "lone", dai_known: true, dai_suspected: false, chapters: null, description: "We talk at length.\n12:30 The main story\nBye." }));
  const notes = notesHtml(m.html());
  assert.strictEqual(m.section(), "", "the section ignores it");
  assert.doesNotMatch(notes, /ep-chapter-row/, "and so do the notes");
  assert.match(notes, /<button type="button" class="ep-ts" data-ts="750" aria-label="Play from 12:30">12:30<\/button>/, "it is still a seek stamp");
  const lines = m.ctx.ForayNotes.lines("12:30 The main story\nmore prose", 3600);
  assert.ok(!lines.some((t) => t.kind === "chapter"), "the Now Playing sheet's tokens agree");
  const outOfOrder = m.ctx.ForayNotes.lines("0:00 Open\n30:00 Late\n10:00 Back", 3600);
  assert.ok(!outOfOrder.some((t) => t.kind === "chapter"), "stamps out of order are prose there too");
});

test("CH-33 (A2-10): readDeviceChapters races the JSON request against ForayId3Chapters.CALL_TIMEOUT_MS, then falls through to the ID3 read", async () => {
  /* MUTATION: put back `setTimeout(() => r(null), 8000)` in
     readDeviceChapters -> the JSON request that never answers holds the page
     past this test's wait; the ID3 read never starts; red. */
  let id3Read = 0;
  const m = mount({ hash: "#/episode/ep-dl", native: () => new Promise(() => {}) });
  m.ctx.ForayId3Chapters = id3Stub({
    CALL_TIMEOUT_MS: 20,
    forUrl: async () => { id3Read += 1; return [{ secs: 0, title: "Tag one" }, { secs: 61, title: "Tag two" }]; },
  });
  m.render(ep({ id: "ep-dl", description: NOTES3, chapters_url: "https://pub.test/slow.json" }));
  await new Promise((r) => setTimeout(r, 250));
  await ticks();
  assert.strictEqual(id3Read, 1, "the JSON read gave up at the reader's deadline");
  assert.deepStrictEqual(titles(m.section()), ["Tag one", "Tag two"]);
});

test("CH-33 (A2-10): the JSON request's User-Agent is the reader's shellUserAgent(), not app.js's own lookup", async () => {
  /* MUTATION: `const ua = window.forayDownloads?.userAgent;` back in
     readDeviceChapters -> the request carries "page-copy"; red. */
  const seen = [];
  const m = mount({ hash: "#/episode/ep-ua2", native: async (_p, _m, opts) => { seen.push(opts.headers); return { status: 200, data: JSON_BODY }; } });
  m.ctx.forayDownloads = { userAgent: "page-copy" };
  m.ctx.ForayId3Chapters = id3Stub({ shellUserAgent: () => "4a/reader" });
  m.render(ep({ id: "ep-ua2", description: NOTES3, chapters_url: "https://pub.test/ch.json" }));
  await ticks();
  assert.deepStrictEqual(seen.map((h) => ({ ...h })), [{ "User-Agent": "4a/reader" }]);
});

test("CH-33: before client.js has published the ID3 reader nothing is asked and no miss is remembered; the next render asks", async () => {
  /* MUTATION: drop `if (!window.ForayId3Chapters) return;` from
     hydrateFeedChapters -> the first render memoises an empty answer and the
     second render asks nothing; red. */
  const calls = [];
  const m = mount({ hash: "#/episode/ep-late", native: async (_p, _m, opts) => { calls.push(opts.url); return { status: 200, data: JSON_BODY }; } });
  delete m.ctx.ForayId3Chapters;
  const item = ep({ id: "ep-late", description: NOTES3, chapters_url: "https://pub.test/ch.json" });
  m.render(item);
  await ticks();
  assert.deepStrictEqual(calls, [], "no transport rules yet: no request");
  m.ctx.ForayId3Chapters = id3Stub();
  m.render(item);
  await ticks();
  assert.deepStrictEqual(calls, ["https://pub.test/ch.json"]);
  assert.deepStrictEqual(titles(m.section()), ["Json one", "Json two"]);
});
