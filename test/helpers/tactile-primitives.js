"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "ui", "primitives.js"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");

/* esc(), safeUrl() and artUrl() are lifted verbatim from app.js, never re-typed here: a
   hand copy that admits "#..." fragments while app.js refuses them is the
   forgiving-fake failure CLAUDE.md warns about. */
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
function lift(name) {
  const m = new RegExp("^function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}", "m").exec(APP);
  if (!m) throw new Error(`app.js no longer declares ${name}() at top level`);
  return m[0];
}
/* safeUrl's one fragment exception reads app.js's SPRITE_IDS, so the set is
   lifted too (as `var`, so tests can read it off the context). */
function liftSpriteIds() {
  const m = /^const SPRITE_IDS = (new Set\(\[[\s\S]*?\]\));$/m.exec(APP);
  if (!m) throw new Error("app.js no longer declares SPRITE_IDS at top level");
  return "var SPRITE_IDS = " + m[1] + ";";
}
const GUARDS = liftSpriteIds() + "\n" + lift("esc") + "\n" + lift("safeUrl") + "\n" + lift("artUrl") + "\n";

function load(extra = {}) {
  const context = vm.createContext({ URL, Set, Map, Math, Number, String, Array, Boolean, ...extra });
  vm.runInContext(GUARDS, context, { filename: "app.js (esc, safeUrl, artUrl)" });
  vm.runInContext(SOURCE, context, { filename: "ui/primitives.js" });
  return context;
}

/* Comments are stripped first: a comment between two rules would otherwise be
   read as part of the next rule's selector, hiding that rule from rule(). */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector) {
  const bodies = [];
  for (const match of CSS_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  return bodies.join("\n");
}

module.exports = { ROOT, SOURCE, CSS, CSS_RULES, load, rule };
