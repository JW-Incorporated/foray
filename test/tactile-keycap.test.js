/* Tactile Phase 3 keycaps and small controls. Every test names the mutation
 * used to prove it can fail; the five mutations were executed before push. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { load, rule, CSS } = require("./helpers/tactile-primitives.js");

const p = load();

test("keycap sizes start at the 44px tap token and include every transport role", () => {
  // MUTATION: set `.keycap--sm` height and min-width to 40px -> this test fails.
  assert.match(rule(".keycap--sm"), /min-width:\s*var\(--tap\)/);
  assert.match(rule(".keycap--sm"), /height:\s*var\(--tap\)/);
  assert.match(rule(".keycap--md"), /height:\s*var\(--key\)/);
  assert.match(rule(".keycap--lg"), /height:\s*var\(--key-lg\)/);
  assert.match(rule(".keycap--xl"), /height:\s*var\(--key-xl\)/);
  assert.match(rule(".keycap--glance"), /height:\s*var\(--key-glance\)/);
});

test("the four variants share one lip and the pressed state drops it two pixels", () => {
  // MUTATION: delete `keycap--ultramarine` from tactileKeycap's allow-list -> its specimen becomes paper and fails.
  for (const variant of ["persimmon", "ultramarine", "rubber", "paper"]) {
    assert.match(p.tactileKeycap({ variant, text: variant, pressed: true }), new RegExp(`keycap--${variant}`));
  }
  assert.match(rule(".keycap::after"), /height:\s*var\(--lip\)/);
  assert.match(CSS, /\.keycap:active:not\(:disabled\), \.keycap\[data-pressed="true"\]\s*\{\s*transform:\s*translateY\(calc\(var\(--s-1\) \/ 2\)\)/);
});

test("disabled, loading, offline-blocked, and focus-visible states are explicit", () => {
  // MUTATION: stop disabling the offline keycap -> the `disabled` assertion fails.
  const disabled = p.tactileKeycap({ disabled: true, text: "Saved" });
  const loading = p.tactileKeycap({ loading: true, text: "Loading" });
  const offline = p.tactileKeycap({ offline: true, text: "Needs a connection" });
  const focus = p.tactileKeycap({ focus: true, text: "Focus" });
  assert.match(disabled, / disabled/);
  assert.match(loading, /aria-busy="true"[^>]* disabled/);
  assert.match(offline, /keycap--blocked[^>]* disabled/);
  assert.match(offline, /#ph-cloud-slash/);
  assert.match(focus, / is-focus/);
  assert.match(CSS, /\.keycap:focus-visible, \.keycap\.is-focus[\s\S]*outline:/);
});

test("keycaps escape copy and never nest another interactive element", () => {
  // MUTATION: remove `esc()` around the keycap label -> the injected button appears and this test fails.
  const html = p.tactileKeycap({ text: '<button id="bad">x</button>', label: 'Play "now"' });
  assert.doesNotMatch(html, /id="bad"/);
  assert.match(html, /&lt;button id=&quot;bad&quot;&gt;/);
  assert.strictEqual((html.match(/<button\b/g) || []).length, 1);
  assert.strictEqual((html.match(/<\/button>/g) || []).length, 1);
});
