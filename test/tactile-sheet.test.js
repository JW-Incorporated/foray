/* Tactile Phase 3 modal sheet. The harness models the exact focus operations
 * in tactileWireSheet; each named mutation was executed before push. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { load, rule, ROOT } = require("./helpers/tactile-primitives.js");

test("sheet markup is modal, labelled, focusable at its container, and hidden at rest", () => {
  // MUTATION: remove `aria-modal="true"` from tactileSheet -> this test fails.
  const p = load();
  const html = p.tactileSheet({ id: "sample", closeId: "sample-close", title: "Settings" });
  assert.match(html, /^<section class="sheet" id="sample" role="dialog" aria-modal="true" aria-labelledby="sample-title" tabindex="-1" hidden>/);
  assert.match(html, /id="sample-close" aria-label="Close"/);
});

test("open moves focus to the sheet, traps Tab, Escape closes, and focus returns", () => {
  // MUTATION: delete the `document.activeElement === sheet` trap branch -> Shift+Tab escapes to BODY.
  const doc = {
    activeElement: null, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
  };
  function el(name) {
    return {
      name, hidden: false, attrs: new Set(), listeners: {}, parentElement: null, children: [],
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(attr) { this.attrs.add(attr); }, removeAttribute(attr) { this.attrs.delete(attr); },
      focus() { doc.activeElement = this; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
  }
  const opener = el("opener");
  const close = el("close");
  const first = el("first");
  const last = el("last");
  const content = el("content");
  const outside = el("body");
  const sheet = el("sheet");
  sheet.hidden = true;
  sheet.querySelector = () => close;
  sheet.querySelectorAll = () => [first, last];
  sheet.contains = (candidate) => [close, first, last].includes(candidate);
  const parent = { children: [content, sheet] };
  sheet.parentElement = parent;
  const p = load({ document: doc });
  p.tactileWireSheet(opener, sheet);
  opener.listeners.click();
  assert.strictEqual(sheet.hidden, false);
  assert.strictEqual(doc.activeElement, sheet, "focus starts on the sheet container");
  assert.ok(content.attrs.has("inert"), "background sibling is inert");

  let prevented = false;
  sheet.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(doc.activeElement, first, "forward Tab from the container enters at the first control");

  doc.activeElement = sheet;
  prevented = false;
  sheet.listeners.keydown({ key: "Tab", shiftKey: true, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(doc.activeElement, last, "Shift+Tab from the container wraps to the last control");

  doc.activeElement = outside;
  sheet.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault() {} });
  assert.strictEqual(doc.activeElement, first, "an outside focus is recovered in the forward direction");
  doc.activeElement = outside;
  sheet.listeners.keydown({ key: "Tab", shiftKey: true, preventDefault() {} });
  assert.strictEqual(doc.activeElement, last, "an outside focus is recovered in the reverse direction");

  doc.activeElement = outside;
  doc.listeners.focusin({ target: outside });
  assert.strictEqual(doc.activeElement, first, "programmatic focus outside the open modal is contained");

  doc.activeElement = last;
  prevented = false;
  sheet.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(doc.activeElement, first, "forward Tab wraps inside");
  sheet.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.strictEqual(sheet.hidden, true);
  assert.strictEqual(doc.activeElement, opener, "focus returns to the opener");
  assert.ok(!content.attrs.has("inert"));
  assert.strictEqual(doc.listeners.focusin, undefined, "the document focus guard is removed on close");
});

test("the sheet uses the deck material, one motion token, and a static gallery preview", () => {
  // MUTATION: make `.sheet` background `--paper` -> the shared deck-material assertion fails.
  assert.match(rule(".sheet"), /background:\s*var\(--deck-tint\)/);
  assert.match(rule(".sheet"), /transition-duration:\s*var\(--d-sheet\), var\(--d-quick\)/);
  assert.match(rule(".sheet--preview"), /position:\s*relative/);
  assert.match(rule(".sheet--preview"), /transform:\s*none/);
});

test("the gallery sheet has an explicit gate opener and close control", () => {
  // MUTATION: remove the `#gallery-sheet` row from SHEET_OPENERS -> this test fails.
  const config = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "gates", "config.mjs"), "utf8");
  const states = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
  assert.match(config, /dialog: "#gallery-sheet", opener: "#gallery-sheet-open", close: "#gallery-sheet-close"/);
  assert.match(states, /label: "cream-sheet-open"[\s\S]*openGallerySheet/);
});

test("a resting toast and its Undo are out of focus, pointer and the accessibility tree", () => {
  /* Review blocker (p3-primitives, second look): the resting toast was hidden
     only by opacity, so its Undo stayed tabbable, clickable and announced.
     MUTATION: drop the `(d.show ? "" : " inert")` term in tactileToast -> the
     resting markup assertion fails.
     MUTATION 2: delete `visibility: hidden;` from `.toast` -> the CSS half fails.
     MUTATION 3: delete `toast.setAttribute("inert", "")` in tactileSetToast ->
     hiding a shown toast leaves it interactive and the helper half fails. */
  const p = load();
  const resting = p.tactileToast({ text: "Removed from Up Next", action: "Undo" });
  const shown = p.tactileToast({ text: "Saved for later", action: "Undo", show: true });
  assert.match(resting, /^<div class="toast" role="status" inert>/, "the resting toast is inert");
  assert.match(resting, /<button type="button" class="textbtn [^"]*"[^>]*>Undo<\/button>/, "fixture premise: Undo is rendered inside it");
  assert.match(shown, /^<div class="toast is-visible" role="status">/, "a shown toast is not inert");
  assert.doesNotMatch(shown, /\binert\b/);

  assert.match(rule(".toast"), /(?:^|;)\s*visibility:\s*hidden/, "CSS keeps a resting toast out of hit-testing and the tab order");
  assert.match(rule(".toast.is-visible"), /visibility:\s*visible/);
  assert.match(rule(".toast"), /transition:[^;]*visibility var\(--d-quick\) linear/, "visibility stays on for the whole fade-out");

  const attrs = new Set(["inert"]);
  const classes = new Set();
  const el = {
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    setAttribute(name) { attrs.add(name); }, removeAttribute(name) { attrs.delete(name); },
  };
  p.tactileSetToast(el, true);
  assert.ok(classes.has("is-visible") && !attrs.has("inert"), "showing removes inert with the class");
  p.tactileSetToast(el, false);
  assert.ok(!classes.has("is-visible") && attrs.has("inert"), "hiding restores inert with the class");
});
