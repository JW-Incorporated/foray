/* CH-18 (docs/roadmap/code-health.md, appendix X1-15): one rule per selector
 * where a second copy is dead weight.
 *
 * `body.ui-v2 .show-ep-search input` was declared twice in styles.css with
 * identical declarations — once beside the show-search card rules and again,
 * pasted, at the head of the Playlists section. The later copy won the
 * cascade, so an agent who restyled the search input in the FIRST block saw
 * nothing change on screen (the second silently overrode it). The Playlists
 * copy was deleted; the show-search copy is the one rule.
 *
 * Pinned here:
 *   1. the selector opens exactly one rule (kills re-adding the copy);
 *   2. that one rule still paints the v2 input with the line border, the
 *      surface fill and the text colour (kills deleting the WRONG copy and
 *      then trimming the survivor, or deleting both).
 *
 * Comments are stripped before scanning so prose that names the selector is
 * not counted as a rule.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs
  .readFileSync(path.join(__dirname, "..", "styles.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

/* The selector as a whole compound: `input` followed by neither more of an
   identifier nor a pseudo/attribute/class, so `input::placeholder` or
   `input:focus` are different selectors and do not count. */
const SELECTOR = /body\.ui-v2\s+\.show-ep-search\s+input(?![\w\-\[:.#])/g;

function rulesFor(selectorRe) {
  /* Every rule whose selector list contains the selector: `prelude { body }`. */
  const out = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(CSS))) {
    selectorRe.lastIndex = 0;
    if (selectorRe.test(m[1])) out.push(m[2]);
  }
  return out;
}

test("body.ui-v2 .show-ep-search input is declared in exactly one rule (CH-18 / X1-15)", () => {
  const hits = CSS.match(SELECTOR) || [];
  assert.strictEqual(
    hits.length,
    1,
    `styles.css names \`body.ui-v2 .show-ep-search input\` ${hits.length} times; ` +
      "a second copy wins the cascade and makes edits to the first silently do nothing",
  );
  assert.strictEqual(rulesFor(SELECTOR).length, 1);
});

test("the one body.ui-v2 .show-ep-search input rule keeps its line border, surface fill and text colour", () => {
  const [body] = rulesFor(SELECTOR);
  assert.ok(body, "the rule exists");
  const decls = Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );
  assert.deepStrictEqual(decls, {
    "border-color": "var(--line)",
    background: "var(--surface)",
    color: "var(--text)",
  });
});
