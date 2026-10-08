/* Tactile `toast` (Yours with toast): the Remove-and-Undo toast as the stylesheet,
 * the harness and the screen map carry it. Redesign 2026,
 * docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.16, BUILD-NOTES 3.17.
 * Behaviour (the four seconds, the clock held while touched or focused, Undo
 * putting the row back where it was, the badge and the readout ticking down and
 * up) is pinned in test/tactile-library.test.js section 6, which drives the real
 * ui/library.js; this file holds the rest.
 *
 * WHAT THIS PROVES
 *   1. The toast is the spec's object: 48px tall, the card's fill, the deck's
 *      shadow, 15px text, and it moves on transform and opacity on
 *      `--spring-settle`, never on a size.
 *   2. Undo is a 44px text button and sits against the right edge the way the
 *      prototype's does (8px right padding, 16px left), not 16px in.
 *   3. Under reduced motion it is cut, not slid: the one block lists it among the
 *      `transition: none` rules and gives it no other transition. (The plan says
 *      "fade"; the harness's reduced-motion gate fails any transition over 1ms,
 *      so the fade is the orchestrator's call, see the test.)
 *   4. It sits above the deck, and above the mini when the mini is up.
 *   5. The harness reaches it: `up-next-remove-toast` is a step of the `player`
 *      state, after `mini-player-library`, and `screens.json` points the `toast`
 *      screen at it with regions for the toast, its text and Undo.
 *
 * WHAT IT CANNOT PROVE: how it looks (fidelity.mjs: `toast` regions within 4px of
 * the prototype's) or that a finger finds Undo (test/tap-targets.test.js).
 *
 * HARNESS AUDIT. The CSS is read with the same brace walker the foundation tests
 * use, so a rule in the reduced-motion block is found where the browser would find
 * it, and a comment that merely mentions `.toast` does not count (comments are
 * stripped before parsing). Each test names its mutation; all were run red.
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { parseRules } = require("./helpers/dial-css.js");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const RULES = parseRules(CSS);
const STATES = fs.readFileSync(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs"), "utf8");
const SCREENS = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "screens.json"), "utf8"));

const REDUCED = "@media (prefers-reduced-motion: reduce)";
const decl = (rule, prop) => (rule.decls.find((d) => d.prop === prop) || {}).value;
/** The one declaration block for exactly this selector list member, outside any at-rule. */
const base = (sel) => RULES.filter((r) => r.atRules.length === 0 && r.selectors.includes(sel));

test("the toast is 48px, the card's fill, the deck's shadow, 15px text, and moves on transform and opacity only", () => {
  /* MUTATION 1: `min-height: var(--key)` -> `var(--tap)` on `.toast` - the 48 assertion fails.
     MUTATION 2: add `height` to the transition list - the no-size assertion fails.
     MUTATION 3: `background: var(--card)` -> `var(--paper-2)` - the fill assertion fails. */
  const rules = base(".toast");
  assert.strictEqual(rules.length, 1, "one base rule for .toast");
  const t = rules[0];
  assert.strictEqual(decl(t, "min-height"), "var(--key)", "48px is --key");
  assert.strictEqual(decl(t, "background"), "var(--card)");
  assert.strictEqual(decl(t, "box-shadow"), "var(--shadow-deck)");
  assert.match(decl(t, "font"), /var\(--t-body\)\/var\(--lh-body\)/, "15px on 21px is --t-body / --lh-body");
  const trans = decl(t, "transition");
  assert.match(trans, /transform var\(--d-settle\) var\(--spring-settle\)/, "slides up on --spring-settle");
  assert.match(trans, /opacity var\(--d-quick\)/);
  assert.ok(!/\b(height|width|top|bottom|margin|padding)\b/.test(trans), `a size or an offset is animated: ${trans}`);
  assert.strictEqual(decl(base(".toast.is-visible")[0], "transform"), "translateY(0)", "visible is at rest");
  assert.strictEqual(decl(t, "transform"), "translateY(var(--s-3))", "it rises from 12px below, a slide up");
});

test("Undo is a 44px text button against the right edge: 8px right padding, 16px left", () => {
  /* MUTATION 1: `.toast` padding back to `0 var(--s-4)` - the padding assertion
     fails (the prototype's Undo sat 8px further left in the render).
     MUTATION 2: `.textbtn { min-height: var(--tap) }` -> `var(--key)` - the 44 assertion fails. */
  assert.strictEqual(decl(base(".toast")[0], "padding"), "0 var(--s-2) 0 var(--s-4)");
  const btn = base(".textbtn").find((r) => decl(r, "min-height"));
  assert.ok(btn, "a base .textbtn rule sets the height");
  assert.strictEqual(decl(btn, "min-height"), "var(--tap)");
  assert.strictEqual(decl(btn, "min-width"), "var(--tap)");
});

test("reduced motion: the toast is stilled by the one block, with no transition left that runs", () => {
  /* BUILD-PLAN 2.16 says "reduced: fade", but tools/ui-lab's reduced-motion gate
     counts ANY transition over 1ms under this setting (a 120ms opacity fade was
     measured: two new violations on player/up-next-clear-sheet), and the loop may
     not add to the known-debt list. So the toast is cut under reduced motion, as
     every other Phase 4 transition is, and the orchestrator can rule otherwise.
     MUTATION 1: take `.toast,` out of the `transition: none` list in the block -
     the stilled assertion fails (it would slide on 1ms tokens only by accident).
     MUTATION 2: add a `.toast.is-visible { transition-duration: var(--d-quick) }`
     rule to the block - the no-duration assertion fails, and so does the gate. */
  const inBlock = RULES.filter((r) => r.atRules.includes(REDUCED));
  const stilled = inBlock.filter((r) => decl(r, "transition") === "none" && r.selectors.includes(".toast"));
  assert.strictEqual(stilled.length, 1, "the toast is named once in a `transition: none` rule inside the reduced-motion block");
  const other = inBlock.filter((r) => r.selectors.some((s) => /(^|\s)\.toast/.test(s)) && r !== stilled[0]);
  assert.deepStrictEqual(other.map((r) => r.selectors), [], "no other rule in the block gives the toast a transition");
  assert.strictEqual((CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1, "still the one block");
});

test("the toast sits above the deck, and above the mini when the mini is up", () => {
  /* MUTATION: take `var(--fp-bar-h)` out of the `.yours-toast` rule with the
     mini up - the second assertion fails (the toast would cover the mini). */
  const host = base(".deck-toast")[0];
  assert.match(decl(host, "bottom"), /var\(--tab-row-h\)/, "over the tab row");
  assert.strictEqual(decl(host, "position"), "fixed");
  const withMini = RULES.find((r) => r.selectors.includes("body.fp-open:not(.mini-dismissed) .yours-toast"));
  assert.ok(withMini, "a rule for the toast with the mini up");
  assert.match(decl(withMini, "bottom"), /var\(--tab-row-h\) \+ var\(--fp-bar-h\)/, "the mini's height is added");
});

test("the harness step and the screen map: up-next-remove-toast, in the player state, after mini-player-library", () => {
  /* MUTATION 1: rename the step in states.mjs - the order assertion fails.
     MUTATION 2: point screens.json's toast.app.step at `up-next-actions` - the
     map assertion fails. MUTATION 3: drop the `undo` region - the regions
     assertion fails. */
  const player = STATES.slice(STATES.indexOf('id: "player"'), STATES.indexOf('id: "search"'));
  const labels = [...player.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.indexOf("up-next-remove-toast") > labels.indexOf("mini-player-library"), `order: ${labels.join(", ")}`);
  assert.ok(player.includes("removeQueueRow(page, 1)"), "the step presses Remove on the SECOND queue row");
  const toast = SCREENS.screens.toast;
  assert.deepStrictEqual(toast.app, { state: "player", step: "up-next-remove-toast" });
  for (const region of ["toast", "toastText", "undo", "rows", "mini", "tabBar", "header"]) {
    assert.ok(toast.regions[region] && toast.regions[region].app, `region ${region} is mapped on the app side`);
  }
  assert.strictEqual(toast.regions.rows.app, ".row-queue");
  assert.strictEqual(toast.regions.toast.app, "#yours-toast .toast");
  assert.strictEqual(toast.regions.undo.app, "#yours-toast .textbtn");
});
