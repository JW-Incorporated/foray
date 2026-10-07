"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "ui", "primitives.js"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8").replace(/\r\n/g, "\n");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return u;
  } catch (_) {}
  return "#";
}

function load(extra = {}) {
  const context = vm.createContext({ URL, Set, Map, Math, Number, String, Array, Boolean, esc, safeUrl, ...extra });
  vm.runInContext(SOURCE, context, { filename: "ui/primitives.js" });
  return context;
}

function rule(selector) {
  const bodies = [];
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  return bodies.join("\n");
}

module.exports = { ROOT, SOURCE, CSS, load, rule };
