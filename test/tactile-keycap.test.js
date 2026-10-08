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
  assert.match(CSS, /\.keycap:active:not\(:disabled\), \.keycap\[data-pressed="true"\]\s*\{\s*transform:\s*translateY\(calc\(var\(--s-1\) \/ 2\)\)/);
  assert.match(CSS, /\.keycap:active:not\(:disabled\)::after, \.keycap\[data-pressed="true"\]::after\s*\{\s*transform:\s*translateY\(calc\(var\(--s-1\) \/ -2\)\)/, "the lip counter-translates so its base stays put");
});

test("the lip is the key's own silhouette stretched down, not a bar under it", () => {
  /* The first Today build drew the lip as `height: var(--lip)` strip under the face with
     square lower corners, which floated 2-4px below a round key and read as a stray
     underline. The lip must span the whole box (top 0) down to --lip below it, take the
     key's own radius, and sit behind a face that is a separate pseudo-element.
     MUTATION: put `height: var(--lip)` back on `.keycap::after` (and drop `top: 0`) -> the
     strip assertions fail. MUTATION 2: give `.keycap--round::after` its own
     `0 0 var(--r-pill) var(--r-pill)` radius -> the round-key assertion fails. */
  const lip = rule(".keycap::after");
  assert.match(lip, /top:\s*0/, "the lip starts at the top of the key and hides behind the face");
  assert.match(lip, /bottom:\s*calc\(-1 \* var\(--lip\)\)/, "and ends --lip below it");
  assert.match(lip, /border-radius:\s*inherit/, "so its corners are the key's own, circle included");
  assert.doesNotMatch(lip, /height:/, "never a strip of its own height");
  assert.match(lip, /z-index:\s*-2/);
  const face = rule(".keycap::before");
  assert.match(face, /inset:\s*0/);
  assert.match(face, /background:\s*var\(--k-fill\)/);
  assert.match(face, /z-index:\s*-1/, "the face is in front of the lip");
  assert.match(rule(".keycap"), /background:\s*transparent/, "the element's own background would paint over the lip");
  assert.strictEqual(rule(".keycap--round::after"), "", "a round key's lip follows the circle by inheriting, not by a second radius");
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
