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
  // MUTATION: change `sheet.focus()` in open() to `first.focus()` -> the container-focus assertion fails.
  const doc = { activeElement: null };
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
  const sheet = el("sheet");
  sheet.hidden = true;
  sheet.querySelector = () => close;
  sheet.querySelectorAll = () => [first, last];
  const parent = { children: [content, sheet] };
  sheet.parentElement = parent;
  const p = load({ document: doc });
  p.tactileWireSheet(opener, sheet);
  opener.listeners.click();
  assert.strictEqual(sheet.hidden, false);
  assert.strictEqual(doc.activeElement, sheet, "focus starts on the sheet container");
  assert.ok(content.attrs.has("inert"), "background sibling is inert");
  doc.activeElement = last;
  let prevented = false;
  sheet.listeners.keydown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.strictEqual(doc.activeElement, first, "forward Tab wraps inside");
  sheet.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.strictEqual(sheet.hidden, true);
  assert.strictEqual(doc.activeElement, opener, "focus returns to the opener");
  assert.ok(!content.attrs.has("inert"));
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
