/* tools/podcast/build-feed.mjs, offline. Every test names the mutation it kills
 * and RUNS it: the builder's source is rewritten in memory, imported from a
 * temp file, and the test's own checks must fail on the mutant while passing on
 * the real module. A test whose mutant survives fails loudly ("SURVIVED"). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as real from "./build-feed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "build-feed.mjs"), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "feed-mut-"));
let n = 0;

async function mutant(from, to) {
  assert.ok(SRC.includes(from), `mutation anchor not found: ${from}`);
  const file = path.join(TMP, `m${n++}.mjs`);
  /* The copy lives in a temp dir, so its one relative import is pinned to the real file. */
  const entry = JSON.stringify(pathToFileURL(path.join(HERE, "..", "ci", "entry.mjs")).href);
  fs.writeFileSync(file, SRC.replace(from, to).replace('"../ci/entry.mjs"', entry));
  return import(pathToFileURL(file).href);
}

/* check(mod) holds on the real module and must throw on the mutant. */
async function kills(from, to, check) {
  check(real);
  const m = await mutant(from, to);
  assert.throws(() => check(m), undefined, `SURVIVED: ${from} -> ${to}`);
}

const GUID = "92b1a9a9-69ef-4f8c-a554-fef5b6948b17";
const SHA = "d2c89d52b10470f7ec1eb853e97e5c34e5791fcf6de7fc4e4af9585144028ec2";
const channel = () => ({
  title: "Show & <Tell>", author: "A", owner: { name: "O", email: "o@example.com" }, description: "d \"q\" 'a'",
  language: "en", categories: [{ name: "Science", sub: null }], explicit: false, type: "episodic",
  link: "https://example.com", artwork: { key: "channel/artwork-aaaaaaaaaaaa.jpg" },
  podcast_guid: "58612bb9-eb3d-4533-a0c0-606f387d87b7", locked: true, funding: null,
});
const episode = (o = {}) => ({
  guid: GUID, foray_id: "f1", status: "published", pub_date: "2026-10-20T12:00:00Z", title: "Café & <b>\"x\"</b> ☃",
  subtitle: "s", summary: "sum & more", description: "<p>From Geology Bites ]]> end</p>", episode_type: "full", explicit: false,
  duration_sec: 3725.4,
  audio: [{ format: "mp3", type: "audio/mpeg", bytes: 1234, sha256: SHA, key: `episodes/${GUID}/${SHA.slice(0, 12)}.mp3` }],
  chapters: [{ start_sec: 0, title: "Intro" }, { start_sec: 32, title: "A & B" }], people: [],
  sources: [{ show: "Geology Bites" }], ...o,
});
const BASE = "https://cdn.example.test";

test("esc handles & < > quotes and keeps non-ASCII; mutation: drop the & replacement (double-escape bug inverted)", async () => {
  await kills('.replace(/&/g, "&amp;")', "", (m) => {
    assert.equal(m.esc(`a & b <c> "d" 'e' café ☃`), "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; café ☃");
  });
});

test("esc strips characters XML 1.0 forbids; mutation: remove the control-character filter", async () => {
  await kills('.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g, "")', "", (m) => {
    assert.equal(m.esc("a\u0000b\u001Fc\u000Bd"), "abcd");
  });
});

test("show notes with ]]> stay well-formed in CDATA; mutation: cdata stops splitting the terminator", async () => {
  await kills('.replace(/]]>/g, "]]]]><![CDATA[>")', "", (m) => {
    const xml = m.buildFeed(channel(), [episode()], { baseUrl: BASE });
    const body = xml.split("<content:encoded>")[1].split("</content:encoded>")[0];
    assert.equal(body, "<![CDATA[<p>From Geology Bites ]]]]><![CDATA[> end</p>]]>");
  });
});

test("the feed carries the itunes/podcast tags and escapes episode text; mutation: the title is written unescaped", async () => {
  await kills("<title>${esc(e.title)}</title>", "<title>${e.title}</title>", (m) => {
    const xml = m.buildFeed(channel(), [episode()], { baseUrl: BASE });
    assert.match(xml, /<title>Café &amp; &lt;b&gt;&quot;x&quot;&lt;\/b&gt; ☃<\/title>/);
    assert.match(xml, /<guid isPermaLink="false">92b1a9a9-/);
    assert.match(xml, /<enclosure url="https:\/\/cdn\.example\.test\/episodes\/92b1a9a9[^"]+\.mp3" length="1234" type="audio\/mpeg"\/>/);
    assert.match(xml, /<pubDate>Tue, 20 Oct 2026 12:00:00 \+0000<\/pubDate>/);
    assert.match(xml, /<itunes:duration>01:02:05<\/itunes:duration>/);
    assert.match(xml, /<podcast:chapters url="https:\/\/cdn\.example\.test\/chapters\/92b1a9a9-[^"]+\.json" type="application\/json\+chapters"\/>/);
    for (const t of ["itunes:image", "itunes:category", "itunes:explicit", "itunes:owner", "itunes:type", "itunes:episodeType", "podcast:guid", "podcast:locked", "content:encoded"]) assert.ok(xml.includes("<" + t), t);
  });
});

test("only published episodes appear unless drafts are included, which also stamps the title; mutation: drafts always included", async () => {
  await kills('e.status === "published" || includeDrafts', "true", (m) => {
    const eps = [episode(), episode({ guid: "11111111-1111-1111-1111-111111111111", foray_id: "f2", status: "draft" })];
    const xml = m.buildFeed(channel(), eps, { baseUrl: BASE });
    assert.equal(xml.match(/<item>/g).length, 1);
    assert.ok(!xml.includes("(preview)"));
    const pre = m.buildFeed(channel(), eps, { baseUrl: BASE, includeDrafts: true });
    assert.equal(pre.match(/<item>/g).length, 2);
    assert.match(pre, /<title>Show &amp; &lt;Tell&gt; \(preview\)<\/title>/);
  });
});

test("chapters use the Podcasting 2.0 JSON shape; mutation: startTime written as start_sec", async () => {
  await kills("startTime: c.start_sec", "start_sec: c.start_sec", (m) => {
    assert.deepEqual(m.chaptersJson(episode()), { version: "1.2.0", chapters: [{ startTime: 0, title: "Intro" }, { startTime: 32, title: "A & B" }] });
  });
});

test("validate refuses http and missing base URLs; mutation: the https test accepts http", async () => {
  await kills('/^https:\\/\\/[^\\s/]+/.test(u)', "/^https?:\\/\\/[^\\s/]+/.test(u)", (m) => {
    assert.ok(m.validate(channel(), [episode()], { baseUrl: "http://x.test" }).some((p) => /https/.test(p)));
    assert.ok(m.validate(channel(), [episode()], { baseUrl: "" }).some((p) => /https/.test(p)));
    assert.deepEqual(m.validate(channel(), [episode()], { baseUrl: BASE }), []);
  });
});

test("publish readiness: owner email, artwork, pub_date, sha and source names are demanded; mutation: pub_date check removed", async () => {
  await kills("if (!e.pub_date || Number.isNaN(Date.parse(e.pub_date)))", "if (false)", (m) => {
    const ch = channel(); ch.owner.email = null; ch.artwork = null;
    const p = m.validate(ch, [episode({ pub_date: null })], { baseUrl: BASE });
    assert.ok(p.some((x) => /owner\.email/.test(x)));
    assert.ok(p.some((x) => /artwork/.test(x)));
    assert.ok(p.some((x) => /pub_date/.test(x)));
    const noSha = episode(); noSha.audio[0].sha256 = null;
    assert.ok(m.validate(channel(), [noSha], {}).some((x) => /sha256/.test(x)));
    assert.ok(m.validate(channel(), [episode({ sources: [{ show: "Other Show" }] })], {}).some((x) => /Other Show/.test(x)));
    /* a draft is not held to the publish-only list when the check is not asked for */
    assert.deepEqual(m.validate({ ...channel(), owner: null, artwork: null, link: null }, [episode({ status: "draft" })], { publishReady: false }), []);
  });
});

test("audio keys must be content-addressed; mutation: the key comparison is dropped", async () => {
  await kills("a.key !== `episodes/${e.guid}/${a.sha256.slice(0, 12)}.${a.format}`", "false", (m) => {
    const ep = episode(); ep.audio[0].key = `episodes/${GUID}/latest.mp3`;
    assert.ok(m.validate(channel(), [ep], {}).some((x) => /content-addressed/.test(x)));
  });
});

test("guids are unique and never change for a foray_id; mutation: the changed-guid comparison is dropped", async () => {
  await kills("else if (now.guid !== p.guid)", "else if (false)", (m) => {
    const a = episode(), b = episode({ guid: "22222222-2222-2222-2222-222222222222", foray_id: "f2", status: "draft" });
    assert.ok(m.validate(channel(), [a, { ...b, guid: GUID }], {}).some((x) => /duplicate guid/.test(x)));
    const changed = episode({ guid: "33333333-3333-3333-3333-333333333333" });
    changed.audio[0].key = `episodes/${changed.guid}/${SHA.slice(0, 12)}.mp3`;
    assert.ok(m.validate(channel(), [changed], { prior: [{ foray_id: "f1", guid: GUID }] }).some((x) => /permanent/.test(x)));
    assert.deepEqual(m.validate(channel(), [a], { prior: [{ foray_id: "f1", guid: GUID }] }), []);
  });
});

test("the CLI writes feed.xml and chapters to the out dir and refuses a missing --base-url; mutation: --base-url no longer required", async () => {
  const root = fs.mkdtempSync(path.join(TMP, "root-"));
  fs.mkdirSync(path.join(root, "data", "podcast"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "podcast", "channel.json"), JSON.stringify(channel()));
  fs.writeFileSync(path.join(root, "data", "podcast", "episodes.json"), JSON.stringify({ episodes: [episode()] }));
  const quiet = (fn) => { const e = console.error, l = console.log; console.error = console.log = () => {}; try { return fn(); } finally { console.error = e; console.log = l; } };
  await kills('problems.unshift("--base-url https://... is required")', "void 0", (m) => {
    assert.equal(quiet(() => m.main([], root)), 1);
    assert.equal(quiet(() => m.main(["--base-url", "--include-drafts"], root)), 1);
    assert.equal(quiet(() => m.main(["--base-url", BASE, "--out", "o"], root)), 0);
    const xml = fs.readFileSync(path.join(root, "o", "feed.xml"), "utf8");
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(fs.existsSync(path.join(root, "o", "chapters", `${GUID}.json`)));
  });
});

test("the committed manifests pass --check structure and keep the draft/attribution promises", () => {
  const root = path.resolve(HERE, "..", "..");
  const ch = JSON.parse(fs.readFileSync(path.join(root, "data/podcast/channel.json"), "utf8"));
  const eps = JSON.parse(fs.readFileSync(path.join(root, "data/podcast/episodes.json"), "utf8")).episodes;
  assert.deepEqual(real.validate(ch, eps, { publishReady: false }), []);
  for (const e of eps) {
    for (const s of e.sources) assert.ok(e.description.includes(s.show), s.show);
    for (const a of e.audio) assert.equal(a.key, `episodes/${e.guid}/${a.sha256.slice(0, 12)}.${a.format}`);
  }
});
