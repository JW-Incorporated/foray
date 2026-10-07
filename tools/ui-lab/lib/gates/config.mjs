/* Explicit knobs and exemptions for gates.mjs. Nothing here is implicit: every
 * exemption carries the reason it exists, and a change to this file is a change
 * to the hard limits' enforcement, so it shows up in review. */

/** WCAG 2.5.5 / PLAN.md "44px tap targets", in CSS px. */
export const MIN_TAP_PX = 44;
/** Sub-pixel layout tolerance: 43.6 px is a 44 px box that rounded. */
export const TAP_TOLERANCE_PX = 0.5;

/** Tap-target exemptions. Evaluated by rules.mjs from measurements, never from
 *  the live DOM, so they are unit-tested. */
export const TAP_EXEMPTIONS = {
  /** WCAG 2.5.8 "inline" exception: a link that sits in a sentence is sized by
   *  the line it is in. Applies only to an <a> whose computed display is inline
   *  AND that has sibling text in its parent (measured in the page as
   *  `inlineInText`). A lone inline link in a flex row does not qualify. */
  inlineTextLinks: true,
  /** Selector-keyed exemptions. Empty on purpose; add `{ id, reason }` only with
   *  a reason a reviewer can challenge. `id` is the selector gates.mjs prints. */
  selectors: [],
};

/** Motion shorter than this counts as "instant". The common reduced-motion
 *  reset is `0.01ms !important`, which is a duration > 0 that nobody can see. */
export const MIN_MOTION_MS = 1;

/** Same-origin requests that are expected to fail in the harness. Matched
 *  against the URL path. */
export const IGNORED_FAILED_REQUESTS = [
  { pattern: /\/deploy-manifest\.json$/, reason: "generated at deploy time; a checkout does not have it (README: expected and harmless)" },
  { pattern: /\/data\/forays-directory\.json$/, reason: "gitignored, built by pages.yml at deploy time; a checkout does not have it" },
];

/** Console messages already reported by a more specific gate. */
export const CONSOLE_COVERED_ELSEWHERE = [
  { pattern: /^Failed to load resource/i, gate: "requests", reason: "the failed-requests gate reports same-origin failures with the URL; cross-origin refusals are the harness's own network stub" },
  { pattern: /Content Security Policy/i, gate: "csp", reason: "reported by the securitypolicyviolation listener" },
];

/** Sheet scenarios: how to find the opener a dialog should return focus to.
 *  `dialog` is matched against the open dialog element; `opener` is a selector.
 *  `null` = the dialog opens on load, no opener exists (return-focus is then
 *  reported as unchecked, not as a pass). `close` is the visible close control. */
export const SHEET_OPENERS = [
  { dialog: ".fp-sheet", opener: ".fp-info", close: ".fp-close" },
  { dialog: "#first-time-sheet", opener: null, close: "#first-time-sheet-skip" },
  { dialog: "#ag-gallery-dusk-sheet", opener: "#ag-gallery-dusk-sheet-open", close: "#ag-gallery-dusk-sheet .ag-sheet-head button" },
  { dialog: "#ag-gallery-dawn-sheet", opener: "#ag-gallery-dawn-sheet-open", close: "#ag-gallery-dawn-sheet .ag-sheet-head button" },
  { dialog: "#gx-sheet", opener: "#gx-open", close: "#gx-close" }, // fixtures/gates-fixture.html
];
