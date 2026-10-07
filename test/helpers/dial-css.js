/* Shared readers for the Dial (Tactile) foundation tests: a stylesheet rule
 * walker, the marker-delimited Dial section of styles.css, and a dependency-free
 * WOFF2 table reader (Node's zlib has brotli) so a test can read the metrics the
 * shipped font files actually carry instead of trusting a build script.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..", "..");

const DIAL_START_MARK = "DIAL (TACTILE) FOUNDATION TOKENS";
const REDUCE_BANNER = "/* ---------- REDUCE MOTION: ONE BLOCK";

/** Split styles.css into the Dial foundation section and everything else.
 *  The section runs from the comment that carries DIAL_START_MARK to the
 *  reduce-motion banner (which must stay last in the sheet). `legacy` is the
 *  sheet without it, which is what the pre-Dial ownership tests judge: a legacy
 *  rule that reads a Dial token is a screen adopting the system early, and that
 *  is exactly what they should flag. */
function splitDialSection(css) {
  const mark = css.indexOf(DIAL_START_MARK);
  if (mark < 0) throw new Error("styles.css has no Dial foundation section");
  const start = css.lastIndexOf("/*", mark);
  const end = css.indexOf(REDUCE_BANNER);
  if (end < 0 || end < start) throw new Error("the reduce-motion banner is missing or precedes the Dial section");
  return { dial: css.slice(start, end), legacy: css.slice(0, start) + css.slice(end), start, end };
}

/** Every rule with its at-rule context, comments removed. A brace walker, not a
 *  regex, because scheme blocks nest `:root { }` inside `@media { }`. At-rules
 *  without a body (`@property`, `@font-face`) are returned as `{ at, decls }`. */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [];
  const stack = [];
  let buf = "";
  const decls = (body) => body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const c = d.indexOf(":");
    return { prop: d.slice(0, c).trim(), value: d.slice(c + 1).trim() };
  });
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      const isBlockAt = /^@(media|supports|layer|container)\b/.test(prelude);
      if (isBlockAt) { stack.push(prelude); continue; }
      const end = src.indexOf("}", i);
      const body = src.slice(i + 1, end);
      if (prelude.startsWith("@")) {
        rules.push({ at: prelude, selectors: [], atRules: stack.slice(), decls: decls(body) });
      } else {
        rules.push({ selectors: prelude.split(",").map((s) => s.trim()), atRules: stack.slice(), decls: decls(body) });
      }
      i = end;
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

/* ---------------------------------------------------------------- WOFF2 */

const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
  "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
  "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
  "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** The untransformed tables of a WOFF2 file, by tag, as Buffers. Only the tables
 *  a test needs are untransformed (glyf/loca and optionally hmtx are not). */
function readWoff2(buf) {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("not a WOFF2 file");
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad UIntBase128");
  };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    const idx = flags & 0x3f;
    const version = flags >> 6;
    let tag;
    if (idx === 63) { tag = buf.toString("latin1", p, p + 4); p += 4; } else tag = KNOWN_TAGS[idx];
    const origLength = base128();
    const transformed = (tag === "glyf" || tag === "loca") ? version === 0 : (tag === "hmtx" ? version === 1 : version !== 0);
    const length = transformed ? base128() : origLength;
    dir.push({ tag, length, transformed });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + compressedSize));
  const tables = {};
  let off = 0;
  for (const t of dir) {
    if (!t.transformed) tables[t.tag] = data.subarray(off, off + t.length);
    off += t.length;
  }
  return tables;
}

const fixed = (b, o) => b.readInt32BE(o) / 65536;

/** What a test needs to know about a shipped variable face. */
function describeFont(file) {
  const t = readWoff2(fs.readFileSync(file));
  const upm = t.head.readUInt16BE(18);
  const hhea = { ascent: t.hhea.readInt16BE(4), descent: t.hhea.readInt16BE(6), lineGap: t.hhea.readInt16BE(8) };
  const os2 = t["OS/2"];
  const typo = { ascent: os2.readInt16BE(68), descent: os2.readInt16BE(70), lineGap: os2.readInt16BE(72) };
  const win = { ascent: os2.readUInt16BE(74), descent: os2.readUInt16BE(76) };
  const axes = {};
  if (t.fvar) {
    const off = t.fvar.readUInt16BE(4);
    const count = t.fvar.readUInt16BE(8);
    const size = t.fvar.readUInt16BE(10);
    for (let i = 0; i < count; i++) {
      const o = off + i * size;
      axes[t.fvar.toString("latin1", o, o + 4)] = { min: fixed(t.fvar, o + 4), def: fixed(t.fvar, o + 8), max: fixed(t.fvar, o + 12) };
    }
  }
  // name records: id 1 (family) and 6 (PostScript name), platform 3 (UTF-16BE) or 1 (Mac Roman)
  const nm = t.name;
  const count = nm.readUInt16BE(2);
  const strOff = nm.readUInt16BE(4);
  const names = {};
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const plat = nm.readUInt16BE(o);
    const id = nm.readUInt16BE(o + 6);
    const len = nm.readUInt16BE(o + 8);
    const so = strOff + nm.readUInt16BE(o + 10);
    const raw = nm.subarray(so, so + len);
    const s = plat === 3 ? Buffer.from(raw).swap16().toString("utf16le") : raw.toString("latin1");
    (names[id] || (names[id] = new Set())).add(s);
  }
  return { upm, hhea, typo, win, axes, names, tables: Object.keys(t) };
}

module.exports = { ROOT, splitDialSection, parseRules, readWoff2, describeFont, DIAL_START_MARK, REDUCE_BANNER };
