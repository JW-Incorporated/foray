/* The iOS shell's Dynamic Type bridge (audit round 2, a11y-1; founder question 5).
 *
 * WHAT THIS PROVES: that a Dynamic Type path EXISTS and does what the 2026-09-23
 * zoom ruling assumed one did — the ruling removed pinch-to-zoom on the ground
 * that "Dynamic Type already scales the page", and nothing did. Driven against a
 * fake document: a probe in `-apple-system-body` whose computed size is what the
 * test says it is. So it proves the arithmetic, the gating, the CSSOM-only writes
 * and the re-measure hooks, and nothing about a real WKWebView — that is the
 * device check docs/DECISIONS.md names.
 *
 * Every test names the mutation that kills it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTypeScale, typeScaleApplies, scaleFor, rootFontSize,
  PROBE_FONT, BASE_ROOT_PX, DEFAULT_BODY_PX, MIN_SCALE, MAX_SCALE, SCALE_PROPERTY, SCALED_ATTRIBUTE,
} from "../../mobile/web/foray-type-scale.js";
import { SHELL_ONLY_FILES, shellScriptTags } from "./prepare-webdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function fakeDoc({ bodyPx = 17 } = {}) {
  const listeners = new Map();
  const styleOf = () => {
    const props = new Map();
    const style = {
      setProperty: (k, v) => { props.set(k, String(v)); },
      removeProperty: (k) => { props.delete(k); },
      get: (k) => props.get(k),
    };
    return style;
  };
  const rootStyle = Object.assign(styleOf(), { fontSize: "" });
  const doc = {
    bodyPx,
    body: { children: [], appendChild(el) { this.children.push(el); el.parent = this; } },
    documentElement: {
      style: rootStyle, attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
    },
    visibilityState: "visible",
    createElement: (tag) => ({
      tag, attrs: {}, style: {}, textContent: "",
      setAttribute(k, v) { this.attrs[k] = v; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    }),
    addEventListener(t, fn) { listeners.set(t, fn); },
    removeEventListener(t) { listeners.delete(t); },
    fire(t) { const fn = listeners.get(t); if (fn) fn(); },
    listeners,
  };
  return doc;
}

const ios = { getPlatform: () => "ios", isNativePlatform: () => true };
const computedFor = (doc) => (el) => ({ fontSize: el.style.font === PROBE_FONT ? `${doc.bodyPx}px` : "16px" });

class FakeObserver {
  static instances = [];
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; FakeObserver.instances.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.disconnected = true; }
}

function setup({ bodyPx = 17, capacitor = ios, ResizeObserver = FakeObserver } = {}) {
  const doc = fakeDoc({ bodyPx });
  const logs = [];
  const ts = createTypeScale({ capacitor, doc, getComputedStyle: computedFor(doc), ResizeObserver, log: (m, e) => logs.push({ m, e }) });
  return { doc, ts, logs };
}

/* ------------------------------------------------------------- the arithmetic */

test("the factor is the body size over Apple's default, clamped to [1, 2]", () => {
  /* MUTATION: measure against BASE_ROOT_PX (16) instead of DEFAULT_BODY_PX (17)
     -> the default category reads 1.06 and every page grows at 1x. */
  assert.equal(DEFAULT_BODY_PX, 17, "Apple's Large body size");
  assert.equal(scaleFor(17), 1);
  assert.equal(scaleFor(21), 21 / 17, "xxxLarge");
  assert.equal(scaleFor(53), MAX_SCALE, "the accessibility sizes are clamped");
  assert.equal(scaleFor(14), MIN_SCALE, "below the default the page keeps its own scale");
  for (const bad of [0, -3, NaN, "x", null, undefined]) assert.equal(scaleFor(bad), 1, `${bad} is the default, never a guess`);
  assert.equal(rootFontSize(1), "16px");
  assert.equal(rootFontSize(21 / 17), "19.76px", "two decimals, so a re-measure writes the same string");
  assert.equal(BASE_ROOT_PX, 16);
});

/* ---------------------------------------------------------------- the gating */

test("the bridge applies to the iOS shell only", () => {
  /* Android's WebView scales fonts itself; macOS Safari resolves the keyword to
     13px and would SHRINK the web. MUTATION: return true for "android". */
  assert.equal(typeScaleApplies(ios), true);
  assert.equal(typeScaleApplies({ getPlatform: () => "android", isNativePlatform: () => true }), false);
  assert.equal(typeScaleApplies({ getPlatform: () => "web", isNativePlatform: () => false }), false);
  assert.equal(typeScaleApplies({ getPlatform: () => "ios", isNativePlatform: () => false }), false, "a web build reporting ios");
  assert.equal(typeScaleApplies({ getPlatform: () => { throw new Error("no bridge"); } }), false, "fails closed");
  assert.equal(typeScaleApplies(undefined), false);
  const { doc, ts } = setup({ bodyPx: 21, capacitor: { getPlatform: () => "android", isNativePlatform: () => true } });
  assert.equal(ts.install(), false);
  assert.equal(doc.documentElement.style.fontSize, "", "nothing written where it does not apply");
});

/* ------------------------------------------------------- the probe and the root */

test("install places a hidden -apple-system-body probe through the CSSOM and scales the root from it", () => {
  /* MUTATION: drop `st.font = PROBE_FONT` -> the probe reads 16px and the root
     stays at 1x. MUTATION 2: `probe.setAttribute("style", …)` -> the CSP
     assertion goes red. */
  const { doc, ts } = setup({ bodyPx: 21 });
  assert.equal(ts.install(), true);
  const probe = doc.body.children[0];
  assert.ok(probe, "a probe is in the document");
  assert.equal(probe.style.font, PROBE_FONT);
  assert.equal(probe.attrs["aria-hidden"], "true");
  assert.equal(probe.attrs.style, undefined, "no inline style attribute: the CSP forbids it");
  assert.equal(probe.style.visibility, "hidden");
  assert.equal(doc.documentElement.style.fontSize, "19.76px", "16px × 21/17");
  assert.equal(doc.documentElement.style.get(SCALE_PROPERTY), String(21 / 17), "--type-scale for the px chrome");
  assert.deepEqual(ts.inspect(), { installed: true, bodyPx: 21, scale: 21 / 17, observing: true });
});

test("at the default size the root is left alone, and a clamp writes 32px", () => {
  /* MUTATION: always write `rootFontSize(scale)` -> "16px" lands on the root
     at 1x (harmless today, a diff against styles.css tomorrow). */
  const a = setup({ bodyPx: 17 });
  a.ts.install();
  assert.equal(a.doc.documentElement.style.fontSize, "");
  assert.equal(a.doc.documentElement.style.get(SCALE_PROPERTY), undefined);
  const b = setup({ bodyPx: 53 });
  b.ts.install();
  assert.equal(b.doc.documentElement.style.fontSize, "32px");
});

/* ------------------------------------------------------------- re-measuring */

test("a ResizeObserver on the probe and visibilitychange both re-measure; uninstall restores the root", () => {
  /* The setting changes in Settings; WebKit re-resolves the keyword; the probe's
     box changes; the observer fires. MUTATION: drop `observer.observe(probe)`
     -> the instance has no target. MUTATION 2: drop the visibilitychange
     listener -> the second re-measure never happens. */
  FakeObserver.instances = [];
  const { doc, ts } = setup({ bodyPx: 17 });
  ts.install();
  const obs = FakeObserver.instances[0];
  assert.ok(obs && obs.targets[0] === doc.body.children[0], "the observer watches the probe");

  doc.bodyPx = 21;
  obs.cb();
  assert.equal(doc.documentElement.style.fontSize, "19.76px", "the observer's callback re-measures");

  doc.bodyPx = 23;
  doc.fire("visibilitychange");
  assert.equal(doc.documentElement.style.fontSize, "21.65px", "so does coming back to the app");

  doc.visibilityState = "hidden";
  doc.bodyPx = 17;
  doc.fire("visibilitychange");
  assert.equal(doc.documentElement.style.fontSize, "21.65px", "going hidden does not re-measure");

  assert.equal(ts.refresh(), 1, "refresh() is the same measure, for a device pass");
  assert.equal(doc.documentElement.style.fontSize, "");

  doc.bodyPx = 21;
  ts.refresh();
  assert.equal(ts.uninstall(), true);
  assert.equal(obs.disconnected, true);
  assert.equal(doc.body.children.length, 0, "the probe is gone");
  assert.equal(doc.documentElement.style.fontSize, "", "the root is back at 1x");
  assert.equal(doc.listeners.size, 0);
});

test("a computed-style read that throws costs nothing, and no ResizeObserver is not an error", () => {
  /* MUTATION: let the throw out of `measure` -> install() throws. */
  const doc = fakeDoc({ bodyPx: 21 });
  const logs = [];
  const ts = createTypeScale({
    capacitor: ios, doc, ResizeObserver: null,
    getComputedStyle: () => { throw new Error("no style"); },
    log: (m, e) => logs.push({ m, e }),
  });
  assert.equal(ts.install(), true);
  assert.equal(doc.documentElement.style.fontSize, "", "an unreadable probe changes nothing");
  assert.ok(logs.some((l) => /could not read the probe/.test(l.m)), "and says so");
  assert.equal(ts.inspect().observing, false);
});

/* ------------------------------------------- it SHIPS: the Dynamic Type path exists */

test("the bridge ships in the shell bundle, as a module tag, and the DECISIONS sentence no longer claims what it did", () => {
  /* The a11y-1 pin: a test that fails if no Dynamic Type path exists. The 2026-09-23
     zoom ruling said "Dynamic Type already scales the page" when nothing did.
     MUTATION: drop the entry from SHELL_ONLY_FILES -> red; restore the old
     sentence in docs/DECISIONS.md -> red. */
  const entry = SHELL_ONLY_FILES.find((f) => f.src === "mobile/web/foray-type-scale.js");
  assert.ok(entry, "mobile/web/foray-type-scale.js is a shell-only file");
  assert.equal(entry.module, true, "an ES module, like the other shell scripts");
  assert.ok(fs.existsSync(path.join(ROOT, entry.src)));
  assert.ok(shellScriptTags().some((t) => t.includes(`src="${entry.dest}"`)), "and gets a script tag");
  const src = fs.readFileSync(path.join(ROOT, entry.src), "utf8");
  assert.match(src, /-apple-system-body/, "the keyword WKWebView scales with Text Size");
  assert.match(src, /documentElement[\s\S]*style\.fontSize/, "written to the root's font size");
  const decisions = fs.readFileSync(path.join(ROOT, "docs/DECISIONS.md"), "utf8");
  assert.doesNotMatch(decisions, /Dynamic Type already scales the page\./, "the ruling's false sentence is corrected");
  assert.match(decisions, /foray-type-scale\.js/, "and names the bridge that makes it true");
});

test("the px chrome grows with the text: the root is marked while scaled, and styles.css's one rule reads the mark", () => {
  /* Round-2 sweep, a11y-1 part (b): the bridge scaled every rem, but the top
     bar (44px, its title nowrap + overflow hidden) and the tab bar (56px) are
     px boxes, so at xxxLarge the title clipped. MUTATION: drop the
     setAttribute in `apply` -> red on the mark. MUTATION 2: change 44px in the
     `:root[data-type-scale]` rule without the token -> red on the agreement. */
  const { doc, ts } = setup({ bodyPx: 21 });
  ts.install();
  assert.ok(SCALED_ATTRIBUTE in doc.documentElement.attrs, "a scaled root is not marked");
  doc.bodyPx = 17;
  ts.refresh();
  assert.ok(!(SCALED_ATTRIBUTE in doc.documentElement.attrs), "a 1x root is still marked");
  doc.bodyPx = 21;
  ts.refresh();
  ts.uninstall();
  assert.ok(!(SCALED_ATTRIBUTE in doc.documentElement.attrs), "uninstall leaves the mark behind");

  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const base = (name) => {
    let v = null;
    for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
      const d = new RegExp(`${name}:\\s*([\\d.]+)px;`).exec(m[1]);
      if (d) v = Number(d[1]);
    }
    return v;
  };
  const rule = new RegExp(`:root\\[${SCALED_ATTRIBUTE}\\]\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, "styles.css has no :root[data-type-scale] rule");
  for (const name of ["--topbar-h", "--tab-bar-h"]) {
    const grown = new RegExp(`${name}:\\s*calc\\(([\\d.]+)px \\* min\\(var\\(${SCALE_PROPERTY}, 1\\), ([\\d.]+)\\)\\);`).exec(rule[1]);
    assert.ok(grown, `${name} does not grow with ${SCALE_PROPERTY}`);
    assert.equal(Number(grown[1]), base(name), `${name}'s scaled base is not the token's own default`);
    assert.ok(Number(grown[2]) > 1 && Number(grown[2]) <= MAX_SCALE, "the chrome's cap sits inside the bridge's clamp");
  }
});
