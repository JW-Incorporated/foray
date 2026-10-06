/* Static link-preview tags (sh-3-1071).
 *
 * WHY THIS EXISTS. index.html had only `<title>4a</title>`, so a 4a link pasted
 * into Messages, Slack or X unfurled as a bare URL. The head now carries a
 * description, the Open Graph set and a twitter:card. They are static and inert:
 * no script reads them and the CSP meta is untouched.
 *
 * THE ORIGIN. og:url and og:image are absolute URLs on the public web origin
 * (SH-1): https://foray-web-seven.vercel.app/, the Vercel project that serves
 * the site (docs/DECISIONS.md, 2026-07-30). Not GitHub Pages.
 *
 * OUT OF SCOPE. Per-item previews (a Foray or an episode link unfurling with its
 * own title) need a server that renders per-URL tags; this file pins only the
 * site-wide set.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const HEAD = INDEX.slice(0, INDEX.indexOf("</head>"));
const { BANNED, INTERNAL_VOCABULARY } = require("../backend/src/copy/rules.js");

const PUBLIC_WEB_ORIGIN = "https://foray-web-seven.vercel.app/";

/* Every tag, as [attribute, key]. `name=` for the plain and twitter tags,
   `property=` for Open Graph, which is what the OG spec and the unfurlers read. */
const TAGS = [
  ["name", "description"],
  ["property", "og:site_name"],
  ["property", "og:title"],
  ["property", "og:description"],
  ["property", "og:type"],
  ["property", "og:url"],
  ["property", "og:image"],
  ["name", "twitter:card"],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Every <meta> carrying this key, in either attribute, so a duplicate written
   with the other attribute (name="og:title" beside property="og:title") still
   counts as a duplicate. */
function contents(key) {
  const re = new RegExp(`<meta\\s+(?:name|property)="${escapeRe(key)}"\\s+content="([^"]*)"\\s*>`, "g");
  return [...HEAD.matchAll(re)].map((m) => m[1]);
}

function content(attr, key) {
  const m = new RegExp(`<meta\\s+${attr}="${escapeRe(key)}"\\s+content="([^"]*)"\\s*>`).exec(HEAD);
  assert.ok(m, `<meta ${attr}="${key}"> is missing`);
  return m[1];
}

/* (a) MUTATIONS THAT KILL THIS: delete any one of the eight tags (missing), or
   paste a second copy of any one (duplicate), e.g. a second og:title. */
test("each link-preview tag is in the head exactly once", () => {
  for (const [attr, key] of TAGS) {
    const all = contents(key);
    assert.equal(all.length, 1, `${key} appears ${all.length} times in <head>; want exactly 1`);
    content(attr, key);
    assert.ok(all[0].trim().length > 0, `${key} has empty content`);
  }
});

/* MUTATIONS THAT KILL THIS: og:title or og:site_name set to anything but the
   app name (e.g. back to "Foray"); og:type changed from website; twitter:card
   changed to summary_large_image (which crops a square icon badly). */
test("the fixed values: name, type and card", () => {
  assert.equal(content("property", "og:title"), "4a");
  assert.equal(content("property", "og:site_name"), "4a");
  assert.equal(content("property", "og:type"), "website");
  assert.equal(content("name", "twitter:card"), "summary");
});

/* MUTATIONS THAT KILL THIS: a banned copy word in the line (e.g. "explores"),
   the two descriptions drifting apart, or the line growing past one sentence. */
test("the description is one plain line that passes the copy rules", () => {
  const desc = content("name", "description");
  assert.equal(content("property", "og:description"), desc, "description and og:description say different things");
  assert.doesNotMatch(desc, /[\r\n]/, "the description is one line");
  assert.ok(desc.length <= 160, `the description is ${desc.length} chars; unfurlers truncate past ~160`);
  for (const re of [...BANNED, ...INTERNAL_VOCABULARY]) {
    assert.doesNotMatch(desc, re, `banned copy in the description: ${re}`);
  }
});

/* (b) MUTATIONS THAT KILL THIS: og:url or og:image on another origin (GitHub
   Pages, http:, a relative path); og:image pointing at a file that is not in the
   repo (icon-512.pgn, icons/icon-512.png); an icon under 512px (icon-180.png). */
test("og:url and og:image are on the public web origin and the image exists in the repo", () => {
  const url = content("property", "og:url");
  const image = content("property", "og:image");
  assert.equal(url, PUBLIC_WEB_ORIGIN, "og:url is the public web origin itself");
  assert.ok(image.startsWith(PUBLIC_WEB_ORIGIN), `og:image ${image} is not on ${PUBLIC_WEB_ORIGIN}`);

  const rel = image.slice(PUBLIC_WEB_ORIGIN.length);
  assert.match(rel, /^[\w./-]+\.png$/, `og:image path ${rel} is not a plain PNG path`);
  const file = path.join(ROOT, rel);
  assert.ok(fs.existsSync(file), `og:image ${rel} does not exist in the repo`);

  /* The PNG's own IHDR, not its file name: width and height are the big-endian
     u32s at bytes 16 and 20. */
  const png = fs.readFileSync(file);
  assert.equal(png.toString("latin1", 1, 4), "PNG", `${rel} is not a PNG`);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  assert.ok(w >= 512 && h >= 512, `${rel} is ${w}x${h}; og:image wants at least 512px`);

  /* It must also be deployed: the web build copies an allowlist, not the repo. */
  const dist = fs.readFileSync(path.join(ROOT, "tools/web/prepare-dist.mjs"), "utf8");
  assert.ok(dist.includes(`"${rel}"`), `${rel} is not in tools/web/prepare-dist.mjs's allowlist, so the origin would 404 it`);
});

/* (c) MUTATION THAT KILLS THIS: any edit to the CSP meta, e.g. widening img-src
   or adding an origin. The preview tags need no policy change, so the CSP line
   is pinned byte-for-byte to what it was before they were added. */
const CSP_LINE =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; media-src https:; connect-src 'self' https://qjdllvqdcgacvujhclny.supabase.co https://foray-web-seven.vercel.app; manifest-src 'self'; base-uri 'none'; form-action 'none'">`;

test("the CSP meta is byte-identical to before the preview tags", () => {
  const lines = INDEX.split("\n").filter((l) => l.includes('http-equiv="Content-Security-Policy"'));
  assert.equal(lines.length, 1, "index.html has exactly one CSP meta");
  assert.equal(lines[0], CSP_LINE);
});

/* MUTATION THAT KILLS THIS: a <script> (inline or src) added to carry the tags,
   e.g. one that writes og:url from location.href. Counts the head's scripts
   against the count without the preview block, which is zero. */
test("the preview tags bring no script", () => {
  assert.equal((HEAD.match(/<script\b/g) || []).length, 0, "index.html's <head> has a <script>");
});
