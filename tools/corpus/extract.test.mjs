/* Extraction + routing + path-safety tests. Fixture-only, no network. */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  routeUrl,
  htmlToMarkdown,
  pdfToMarkdown,
  issueToMarkdown,
  looksLikePdf,
} from "./extract.mjs";
import { slugify, archivePath, CORPUS_ROOT, RAW_DIR } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------- routing */

test("route: arXiv abs page becomes its PDF", () => {
  const r = routeUrl("https://arxiv.org/abs/2303.00747");
  assert.equal(r.kind, "pdf");
  assert.equal(r.fetchUrl, "https://arxiv.org/pdf/2303.00747");
});

test("route: arXiv pdf link stays a pdf route", () => {
  const r = routeUrl("https://arxiv.org/pdf/2407.12028");
  assert.equal(r.kind, "pdf");
});

test("route: arXiv html rendering stays html", () => {
  const r = routeUrl("https://arxiv.org/html/2601.02306");
  assert.equal(r.kind, "html");
});

test("route: github repo root goes to raw README", () => {
  const r = routeUrl("https://github.com/pyannote/pyannote-audio");
  assert.equal(r.kind, "github-readme");
  assert.equal(r.fetchUrl, "https://raw.githubusercontent.com/pyannote/pyannote-audio/HEAD/README.md");
});

test("route: github issue goes to the REST API with comments", () => {
  const r = routeUrl("https://github.com/Podcastindex-org/podcast-namespace/issues/254");
  assert.equal(r.kind, "github-issue");
  assert.equal(r.fetchUrl, "https://api.github.com/repos/Podcastindex-org/podcast-namespace/issues/254");
  assert.equal(r.commentsUrl, "https://api.github.com/repos/Podcastindex-org/podcast-namespace/issues/254/comments");
});

test("route: github deep path (non-repo-root, non-issue) is plain html", () => {
  const r = routeUrl("https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/README.md");
  assert.equal(r.kind, "html");
});

test("route: .pdf URLs on any host route as pdf", () => {
  const r = routeUrl("https://cdn.ca9.uscourts.gov/datastore/opinions/2023/07/17/22-15293.pdf");
  assert.equal(r.kind, "pdf");
});

test("route: ordinary page is html", () => {
  const r = routeUrl("https://castos.com/dynamic-ad-insertion-for-podcasts/");
  assert.equal(r.kind, "html");
});

/* ----------------------------------------------------------------- html */

const ARTICLE_HTML = `<!doctype html><html><head><title>Test Article — Site</title></head>
<body>
<nav>Home | About | <a href="/x">Nav link</a></nav>
<article>
<h1>Reciprocal Rank Fusion</h1>
<p>${"Rank fusion combines multiple retrieval lists into one. ".repeat(20)}</p>
<h2>Method</h2>
<p>The constant k is set to 60 in the original paper.</p>
<ul><li>BM25 list</li><li>Dense list</li></ul>
<table><tr><th>System</th><th>Score</th></tr><tr><td>RRF</td><td>0.92</td></tr></table>
</article>
<footer>Copyright footer junk</footer>
</body></html>`;

test("html: extracts article, keeps headings/lists, drops nav+footer", () => {
  const { title, markdown } = htmlToMarkdown(ARTICLE_HTML, "https://example.com/a");
  assert.match(title, /Test Article/);
  assert.match(markdown, /Reciprocal Rank Fusion/);
  assert.match(markdown, /## Method|Method\n/);
  assert.match(markdown, /-\s+BM25 list/);
  assert.doesNotMatch(markdown, /Nav link/);
  assert.doesNotMatch(markdown, /Copyright footer junk/);
});

test("html: gfm tables survive conversion", () => {
  const { markdown } = htmlToMarkdown(ARTICLE_HTML, "https://example.com/a");
  assert.match(markdown, /\|\s*System\s*\|\s*Score\s*\|/);
});

test("html: thin/JS-shell pages fall back to body and get flagged", () => {
  const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>`;
  const { markdown, notes } = htmlToMarkdown(shell, "https://example.com/spa");
  assert.ok(notes.some((n) => n.includes("thin extraction")), `notes were: ${notes}`);
  assert.doesNotMatch(markdown, /boot\(\)/);
});

test("html: script and style content never reaches markdown", () => {
  const page = `<!doctype html><html><head><title>t</title><style>.x{color:red}</style></head>
  <body><article><h1>Real</h1><p>${"content here. ".repeat(50)}</p><script>var secret=1;</script></article></body></html>`;
  const { markdown } = htmlToMarkdown(page, "https://example.com/s");
  assert.doesNotMatch(markdown, /secret/);
  assert.doesNotMatch(markdown, /color:red/);
});

/* ------------------------------------------------------------------ pdf */

test("pdf: extracts text from a well-formed single-page pdf", async () => {
  const buf = fs.readFileSync(path.join(HERE, "fixtures", "hello.pdf"));
  const { markdown } = await pdfToMarkdown(buf);
  assert.match(markdown, /Hello Corpus Fixture/);
});

test("pdf: looksLikePdf detects by magic bytes and content-type", () => {
  assert.equal(looksLikePdf("application/pdf", Buffer.from("junk")), true);
  assert.equal(looksLikePdf("text/html", Buffer.from("%PDF-1.4 rest")), true);
  assert.equal(looksLikePdf("text/html", Buffer.from("<html>")), false);
});

/* --------------------------------------------------------------- github */

test("github issue: title, body and comments become one markdown doc", () => {
  const issue = {
    number: 254,
    title: "DAI breaks timestamps",
    state: "open",
    html_url: "https://github.com/x/y/issues/254",
    created_at: "2022-03-01T00:00:00Z",
    user: { login: "alice" },
    body: "All of the times might be shifted by the ads.",
  };
  const comments = [
    { user: { login: "bob" }, created_at: "2022-03-02T00:00:00Z", body: "Proposed reconstruction approach:" },
  ];
  const { title, markdown } = issueToMarkdown(issue, comments);
  assert.match(title, /#254/);
  assert.match(markdown, /# DAI breaks timestamps \(#254\)/);
  assert.match(markdown, /shifted by the ads/);
  assert.match(markdown, /\*\*bob\*\* \(2022-03-02\)/);
});

test("github issue: missing body/comments degrade gracefully", () => {
  const { markdown } = issueToMarkdown({ number: 1, title: "t", state: "closed", html_url: "u" }, []);
  assert.match(markdown, /# t \(#1\)/);
});

/* ---------------------------------------------------------- path safety */

test("slugify: hostile titles become safe ascii slugs", () => {
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("Hunley v. Instagram (9th Cir. 2023)"), "hunley-v-instagram-9th-cir-2023");
  assert.equal(slugify("..\\..\\windows\\system32"), "windows-system32");
  assert.equal(slugify("🎧🎧🎧"), "untitled");
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify(null), "untitled");
});

test("slugify: output is bounded in length", () => {
  assert.ok(slugify("x".repeat(500)).length <= 60);
});

test("archivePath: stays inside its directory for any slug source", () => {
  const evil = ["../../../escape", "..\\..\\escape", "a/b/c", "C:\\abs\\path", ".."];
  for (const e of evil) {
    const p = archivePath(RAW_DIR, 7, e, "html");
    assert.ok(p.startsWith(path.resolve(RAW_DIR) + path.sep), `escaped: ${p}`);
  }
});

test("archivePath: rejects invalid source ids and sanitizes extension", () => {
  assert.throws(() => archivePath(RAW_DIR, "nope", "t", "html"));
  assert.throws(() => archivePath(RAW_DIR, -1, "t", "html"));
  const p = archivePath(RAW_DIR, 3, "t", "../js");
  assert.match(path.basename(p), /^003-t\.js$/);
});

test("corpus root resolves under data-local/corpus", () => {
  assert.match(CORPUS_ROOT.split(path.sep).join("/"), /data-local\/corpus$/);
});
