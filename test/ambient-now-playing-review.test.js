/* Redesign 2026, ambient Now Playing: the review round's two correctness fixes, run against the shipped code.
 *   - Follow in "Where this came from" is the library's real follow (no decorative control).
 *   - Up Next's "4a added" comes from the pick's source, never from a catalogue hook existing.
 * ui/now-playing.js runs in a vm against a small fake DOM; app.js's nextItem getter is cut out of the source and run
 * with stubs for the continuation plan. Every test names its one-line mutation. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const ui = read("ui/now-playing.js");

class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = new Map(); this.dataset = {}; this.listeners = []; this.className = ""; this.hidden = false; this.style = { setProperty() {} }; this._text = null; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  click() { for (const l of this.listeners.filter((x) => x.type === "click")) l.fn({ preventDefault() {}, stopPropagation() {} }); }
  get textContent() { return this._text !== null ? this._text : this.children.map((c) => (c && c.text !== undefined ? c.text : c.textContent)).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  all() { return this.children.flatMap((c) => (c instanceof FakeNode ? [c, ...c.all()] : [])); }
  querySelectorAll(sel) {
    const attr = /^\[data-([a-z-]+)\]$/.exec(sel);
    const key = attr && attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return this.all().filter((n) => key && n.dataset[key] !== undefined);
  }
}

function loadNowPlaying({ follow } = {}) {
  const document = {
    createElement: (t) => new FakeNode(t),
    createElementNS: (_ns, t) => new FakeNode(t),
    createTextNode: (text) => ({ text }),
  };
  const ctx = {
    document, setTimeout, clearTimeout,
    safeUrl: (u) => u,
    /* app.js's setControlLabel, verbatim in behaviour. */
    setControlLabel(btn, text, label) {
      if (!btn) return;
      if (text != null && btn.textContent !== text) btn.textContent = text;
      if (label && label !== text) btn.setAttribute("aria-label", label); else btn.removeAttribute("aria-label");
    },
    window: { ForayNav: follow ? { showFollow: follow } : {} },
  };
  vm.createContext(ctx);
  vm.runInContext(ui, ctx, { filename: "ui/now-playing.js" });
  return ctx;
}

/** The real follow store's contract in miniature: a set the tap writes and the label reads back. */
function fakeFollowStore(known) {
  const held = new Set();
  return {
    held,
    followable: (id) => known.includes(id),
    isFollowing: (id) => held.has(id),
    toggle: (id) => { if (!known.includes(id)) return false; if (held.has(id)) held.delete(id); else held.add(id); return held.has(id); },
  };
}

function paintSources(ctx, items) {
  const grid = new FakeNode("div");
  const sheetUi = {
    segmentsSection: { querySelector: () => new FakeNode("div") },
    sourcesSection: { querySelector: () => grid },
  };
  ctx.agNpPaintDetails(sheetUi, items, () => {}, { segments: [] });
  return grid;
}

test("Where this came from: Follow writes the library's follow store, and a show the catalogue lacks gets no button", () => {
  /* MUTATION 1: put the old body back in the click handler (flip aria-pressed and the label only, never call
       follows.toggle) -> red: the store never gains the show, so the Library would not list it.
     MUTATION 2: drop the `follows.followable(item?.show_id)` guard -> red: the unknown show gets a button that changes
       only its own label, a decorative control.
     MUTATION 3: paint the label from the old aria-pressed instead of follows.isFollowing -> red on the stale-tile step. */
  const store = fakeFollowStore(["show-a"]);
  const ctx = loadNowPlaying({ follow: store });
  const grid = paintSources(ctx, [
    { show: "Alpha", show_id: "show-a", title: "A1" },
    { show: "Ghost", show_id: "ghost", title: "G1" },
    { show: "Nameless", title: "N1" },
  ]);
  assert.strictEqual(grid.children.length, 3, "one tile per show");
  const buttons = grid.querySelectorAll("[data-np-follow]");
  assert.strictEqual(buttons.length, 1, "only the show the catalogue knows is followable; the other tiles carry no control");
  const btn = buttons[0];
  assert.strictEqual(btn.getAttribute("aria-pressed"), "false");
  assert.strictEqual(btn.textContent, "Follow");
  btn.click();
  assert.ok(store.held.has("show-a"), "the tap reached the real follow store");
  assert.strictEqual(btn.getAttribute("aria-pressed"), "true");
  assert.strictEqual(btn.textContent, "Following");
  assert.strictEqual(btn.getAttribute("aria-label"), "Following Alpha");
  /* Unfollowed elsewhere (the Library) while this tile stays painted: the next tap reads the store, not the stale label. */
  store.held.delete("show-a");
  btn.click();
  assert.ok(store.held.has("show-a"), "a stale 'Following' tile follows again instead of silently doing nothing");
  assert.strictEqual(btn.getAttribute("aria-pressed"), "true");
  /* A tile painted while the show is already followed starts as Following. */
  const again = paintSources(ctx, [{ show: "Alpha", show_id: "show-a", title: "A1" }]).querySelectorAll("[data-np-follow]")[0];
  assert.strictEqual(again.getAttribute("aria-pressed"), "true");
  assert.strictEqual(again.textContent, "Following");
});

test("Where this came from: with no follow store published there is no Follow button at all", () => {
  /* MUTATION: have agNpFollowStore return an inert stub instead of null -> red (a button with nothing behind it). */
  const grid = paintSources(loadNowPlaying(), [{ show: "Alpha", show_id: "show-a", title: "A1" }]);
  assert.strictEqual(grid.children.length, 1);
  assert.strictEqual(grid.querySelectorAll("[data-np-follow]").length, 0);
});

test("app.js publishes the follow store on ForayNav, backed by the real star functions", () => {
  /* MUTATION: point `toggle` at a local no-op instead of toggleShowStar -> red. */
  const app = read("app.js");
  assert.match(app, /showFollow: \{\s*followable: \(id\) => typeof id === "string" && id !== "" && Boolean\(showById\(id\)\),\s*isFollowing: \(id\) => isShowStarred\(id\),\s*toggle: \(id\) => \{ toggleShowStar\(id\); return isShowStarred\(id\); \},/);
});

test("Up Next says '4a added' by the pick's source, not by whether a hook exists", () => {
  /* MUTATION 1: in app.js nextItem put `why: whyFor(id, item) || item.hook || ""` back for every source -> the app.js
       test below goes red (the listener's own queue entry carries a reason).
     MUTATION 2: in agNpPaintUpNext read `item.why` without the `item.source === "tail"` guard -> the queue case with a
       stray why goes red. */
  const ctx = loadNowPlaying();
  const paint = (item) => {
    const up = { ag: true, upNextSection: new FakeNode("section"), upNextRow: new FakeNode("div"), queueLink: new FakeNode("a") };
    ctx.agNpPaintUpNext(up, item, 1);
    return up.upNextRow.all().map((n) => n.textContent).join("|");
  };
  const base = { title: "Lamp", show: "Show", duration_sec: 600, hook: "A hook that exists for almost everything" };
  const queued = paint({ ...base, source: "queue", why: "stray reason" });
  assert.match(queued, /In your queue/);
  assert.doesNotMatch(queued, /4a added|stray reason/);
  const listed = paint({ ...base, source: "list", why: "stray reason" });
  assert.match(listed, /Next in your list/);
  assert.doesNotMatch(listed, /4a added|stray reason/);
  const picked = paint({ ...base, source: "tail", why: "Because you finished the last one" });
  assert.match(picked, /4a added/);
  assert.match(picked, /Because you finished the last one/);
  const bare = paint({ ...base, source: "tail", why: "" });
  assert.doesNotMatch(bare, /4a added/, "a 4a pick with no written reason claims nothing");
});

test("app.js nextItem hands the sheet the pick's source, and only a tail pick keeps a why-line", () => {
  /* MUTATION: derive the why-line from `whyFor(id, item) || item.hook` for every source (the old shape) -> the queue
     and list cases go red; for the tail only -> the stretch case goes red. */
  const app = read("app.js").replace(/\r\n/g, "\n");
  const m = /get nextItem\(\) \{([\s\S]*?)\n  \},\n  isSaved/.exec(app);
  assert.ok(m, "the nextItem getter is where the sheet reads it");
  /* The REAL chainedWhy, cut from the same source and run over stubs, so the preview and the play share one function
     here as they do in the app. `tailReason` is what the nightly tail-fill says about the pick. */
  const cw = /function chainedWhy\(nextId, nextItem, fromTail\) \{[\s\S]*?\n\}\n/.exec(app);
  assert.ok(cw, "chainedWhy is the line startChained gives the same pick on play");
  let tailReason = () => null;
  const run = (plan, queueFirst) => {
    const win = {
      ForayPlayer: { currentEpisodeId: () => (plan ? "cur" : null) },
      forayTailFill: { tailReason: (...a) => tailReason(...a) },
    };
    const whyFor = () => "curated or hook why";
    const chainedWhy = new Function("window", "state", "stretchBridgeText", "subjectLabel", "whyFor", `${cw[0]}; return chainedWhy;`)(
      win, { cardSlots: [] }, (label) => `Bridge via ${label}`, (b) => `subject ${b}`, whyFor,
    );
    return new Function("window", "planAfterEnded", "queueIds", "episode", "chainedWhy", m[1])(
      win, () => plan, () => queueFirst, (id) => ({ id, title: id, hook: "hook" }), chainedWhy,
    );
  };
  const queued = run({ nextId: "q1", fromList: false, fromTail: false }, ["q1"]);
  assert.strictEqual(queued.source, "queue");
  assert.strictEqual(queued.why, "", "a catalogue hook is not provenance");
  const listed = run({ nextId: "l1", fromList: true, fromTail: false }, []);
  assert.strictEqual(listed.source, "list");
  assert.strictEqual(listed.why, "");
  const tail = run({ nextId: "t1", fromList: false, fromTail: true }, []);
  assert.strictEqual(tail.source, "tail");
  assert.strictEqual(tail.why, "curated or hook why");
  /* A STRETCH pick states its bridge in the preview, the same line the play will give it (copy rule: stretch picks
     state their bridge). MUTATION: put `whyFor(id, item)` back in nextItem's tail branch -> this goes red (the hook
     shows with no bridge, and the preview disagrees with the play). */
  tailReason = () => ({ role: "stretch", branch: "geology" });
  const stretch = run({ nextId: "t2", fromList: false, fromTail: true }, []);
  assert.strictEqual(stretch.why, "Bridge via subject geology");
  assert.notStrictEqual(stretch.why, "curated or hook why", "not the hook that whyFor falls back to");
  tailReason = () => null;
  const idle = run(null, ["q9"]);
  assert.strictEqual(idle.source, "queue", "nothing playing: the head of Up Next is the listener's own entry");
  assert.strictEqual(idle.why, "");
});
