/* feed-xml.mjs: the ONE text() helper, the ONE XMLParser configuration and the
   ONE RSS <item> -> fresh-pending record (code-health-2 CH2-29, T1-06/T1-18).

   Run: node --test tools/refresh/feed-xml.test.mjs

   Items here are hand-built in fast-xml-parser's SHAPE, so every test but the
   parser-config one runs without backend/node_modules (CI's data-and-site job
   never installs them). The end-to-end pin (scan.mjs run against a fixture
   world, byte-identical to its pre-extraction output) is scan.test.mjs. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { text, feedParser, itemIdentity, itemToPendingRecord } from "./feed-xml.mjs";
import { pendingRecord } from "./backfill-show.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

let HAS_PARSER = true;
try { createRequire(join(ROOT, "backend", "package.json")).resolve("fast-xml-parser"); } catch (_) { HAS_PARSER = false; }

const SHOW = {
  show_id: "alpha-show",
  title: "Alpha Show",
  apple_collection_id: 1001,
  artwork_url: "https://img.example.test/alpha.jpg",
  taxonomy_node_ids: ["technology"],
};

/* MUTATION: `typeof v === "object" ? v["#text"]` -> `String(v)` -> red on the
   object cases; `v == null ? null` -> `v ? … : null` -> red on 0;
   `String(v["#text"])` -> `v["#text"]` (the pre-review helper) -> red on the
   numeric #text. */
test("text() reads a bare value and the #text of an attributed element", () => {
  assert.equal(text(null), null);
  assert.equal(text(undefined), null);
  assert.equal(text("plain"), "plain");
  assert.equal(text(0), "0");
  assert.equal(text(42), "42");
  assert.equal(text({ "#text": "inner", "@_isPermaLink": "false" }), "inner");
  assert.equal(text({ "@_isPermaLink": "true" }), null);
  /* fast-xml-parser types a numeric #text as a NUMBER: `<guid isPermaLink="false">1234567</guid>`
     parses to exactly this. scan.mjs and harvest-episodes.mjs always stringified it. */
  assert.equal(text({ "#text": 1234567, "@_isPermaLink": "false" }), "1234567");
  assert.equal(text({ "#text": 0 }), "0");
});

/* The four cases the card names: a CDATA guid (a plain string once parsed), an
   object guid with #text, an enclosure with a length, `itunes:explicit` yes.
   MUTATION: rename or drop any field of itemToPendingRecord's literal -> red;
   `explicit_hint` regex loses `yes` -> red. */
test("one <item> becomes the full fresh-pending record", () => {
  const cdata = itemToPendingRecord(SHOW, {
    title: "Vibe Coding &#038; Linux",
    guid: "alpha-cdata-guid",
    pubDate: "Mon, 05 Oct 2026 10:00:00 GMT",
    "itunes:explicit": "yes",
    "itunes:duration": "01:02:03",
    description: "<p>Show   notes with <b>HTML</b>.</p>",
    enclosure: { "@_url": "https://cdn.example.test/ep1.mp3", "@_length": "12345678", "@_type": "audio/mpeg" },
  });
  assert.deepEqual(cdata, {
    record: {
      show: "Alpha Show",
      show_id: "alpha-show",
      apple_collection_id: 1001,
      artwork_url: "https://img.example.test/alpha.jpg",
      topics: ["technology"],
      guid: "alpha-cdata-guid",
      title: "Vibe Coding & Linux",
      release_date: "2026-10-05",
      duration_min: 62,
      duration_sec: 3723,
      audio_url: "https://cdn.example.test/ep1.mp3",
      audio_type: "audio/mpeg",
      audio_bytes: 12345678,
      description: "Show notes with HTML .",
      explicit_hint: true,
    },
    reason: null,
  });
  const obj = itemToPendingRecord({ title: "Bare", apple_collection_id: 7 }, {
    title: "Object Guid",
    guid: { "#text": "alpha-object-guid", "@_isPermaLink": "false" },
    pubDate: "2026-10-04T10:00:00Z",
    "itunes:summary": "Summary only.",
  });
  assert.equal(obj.record.guid, "alpha-object-guid");
  assert.equal(obj.record.show_id, null);
  assert.equal(obj.record.artwork_url, null);
  assert.deepEqual(obj.record.topics, []);
  assert.equal(obj.record.description, "Summary only.");
  assert.equal(obj.record.explicit_hint, false);
});

/* MUTATION: drop the `|| text(it.enclosure?.["@_url"])` fallback -> red on the
   no-guid case; drop decodeEntities -> red on the title; `String(v["#text"])` ->
   `v["#text"]` in text() -> red on the numeric guid (a number would miss every
   string guid in refresh-state.json's `seen` and be pushed again). */
test("itemIdentity: guid falls back to the enclosure URL, the title is entity-decoded, a bad pubDate is null", () => {
  const id = itemIdentity({ title: "A &amp; B", pubDate: "nope", enclosure: { "@_url": "https://cdn.example.test/x.mp3" } });
  assert.equal(id.guid, "https://cdn.example.test/x.mp3");
  assert.equal(id.title, "A & B");
  assert.equal(id.pub, null);
  assert.equal(itemIdentity({ title: "t", pubDate: "2026-10-05T00:00:00Z" }).pub.toISOString(), "2026-10-05T00:00:00.000Z");
  const numeric = itemIdentity({ guid: { "#text": 1234567, "@_isPermaLink": "false" }, title: "t", pubDate: "2026-10-05" });
  assert.equal(numeric.guid, "1234567");
  assert.equal(itemToPendingRecord(SHOW, { guid: { "#text": 1234567 }, title: "t", pubDate: "2026-10-05" }).record.guid, "1234567");
});

/* The single-missing-field items pin each reason; the multi-missing ones pin the
   PRECEDENCE (guid, then title, then pubDate). MUTATION, run: the reason ternary
   reordered to `!pub ? "unparseable pubDate" : !title ? "no title" : "no guid"`
   -> red on `{}` and on the no-title-bad-date item. */
test("an item with no guid, no title or no pubDate yields no record and says which", () => {
  assert.deepEqual(itemToPendingRecord(SHOW, { title: "t", pubDate: "2026-10-05" }), { record: null, reason: "no guid" });
  assert.deepEqual(itemToPendingRecord(SHOW, { guid: "g", pubDate: "2026-10-05" }), { record: null, reason: "no title" });
  assert.deepEqual(itemToPendingRecord(SHOW, { guid: "g", title: "t", pubDate: "x" }), { record: null, reason: "unparseable pubDate" });
  assert.deepEqual(itemToPendingRecord(SHOW, {}), { record: null, reason: "no guid" });
  assert.deepEqual(itemToPendingRecord(SHOW, { pubDate: "x" }), { record: null, reason: "no guid" });
  assert.deepEqual(itemToPendingRecord(SHOW, { title: "t", pubDate: "x" }), { record: null, reason: "no guid" });
  assert.deepEqual(itemToPendingRecord(SHOW, { guid: "g", pubDate: "x" }), { record: null, reason: "no title" });
  const video = itemToPendingRecord(SHOW, { guid: "g", title: "t", pubDate: "2026-10-05", enclosure: { "@_url": "https://c.example.test/v.mp4", "@_type": "video/mp4" } });
  assert.equal(video.reason, "non-audio type video/mp4");
  assert.equal(video.record.audio_url, null);
});

/* THE DUPLICATES STAY GONE. MUTATION, run: paste the record literal back into
   scan.mjs (or give any of the five importers its own private text() helper or
   XMLParser again) -> red, naming the file. */
test("one text(), one XMLParser config, one record builder: every reader imports feed-xml.mjs", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) files.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(join(ROOT, "tools"));
  const withText = files.filter((f) => /const text = \(v\) =>/.test(src(f)));
  assert.deepEqual(withText, ["tools/refresh/feed-xml.mjs"]);
  const parserScope = files.filter((f) => /^tools\/(refresh|classify)\//.test(f) || f === "tools/harvest-episodes.mjs");
  assert.deepEqual(parserScope.filter((f) => /new\s+XMLParser\(/.test(src(f))), ["tools/refresh/feed-xml.mjs"]);

  const READERS = {
    "tools/refresh/scan.mjs": ["feedParser", "itemIdentity", "itemToPendingRecord"],
    "tools/refresh/backfill-show.mjs": ["text", "feedParser", "itemToPendingRecord"],
    "tools/refresh/backfill-audio.mjs": ["text", "feedParser"],
    "tools/harvest-episodes.mjs": ["text", "feedParser"],
    "tools/classify/prepare-batch.mjs": ["feedParser"],
  };
  for (const [file, names] of Object.entries(READERS)) {
    const m = src(file).match(/import \{([^}]*)\} from "\.\.?\/(refresh\/)?feed-xml\.mjs";/);
    assert.ok(m, `${file} does not import from feed-xml.mjs`);
    for (const n of names) assert.match(m[1], new RegExp(`\\b${n}\\b`), `${file} does not import ${n}`);
  }
  for (const f of ["tools/refresh/scan.mjs", "tools/refresh/backfill-show.mjs"]) {
    assert.doesNotMatch(src(f), /explicit_hint:/, `${f} builds a fresh-pending record literal of its own`);
  }
  // T1-18: the dead guid ternary is gone from every reader.
  for (const f of Object.keys(READERS)) assert.doesNotMatch(src(f), /typeof it\.guid === "object"/, f);
});

/* MUTATION: `export const pendingRecord = itemToPendingRecord` replaced by a
   wrapper or a copy -> red. backfill-show's public name is the one function. */
test("backfill-show's pendingRecord IS itemToPendingRecord", () => {
  assert.equal(pendingRecord, itemToPendingRecord);
});

/* MUTATION: `ignoreAttributes: true` -> red (no @_url); `trimValues: false` ->
   red (the padded title); `attributeNamePrefix: ""` -> red. */
test("feedParser() keeps attributes under @_ and trims values", { skip: HAS_PARSER ? false : "backend/node_modules not installed (CI data-and-site)" }, () => {
  const doc = feedParser().parse(
    `<rss><channel><item><title>  Padded  </title><guid isPermaLink="false">g1</guid>` +
    `<enclosure url="https://c.example.test/1.mp3" length="9" type="audio/mpeg"/></item></channel></rss>`,
  );
  const it = doc.rss.channel.item;
  assert.equal(it.title, "Padded");
  assert.deepEqual(it.guid, { "#text": "g1", "@_isPermaLink": "false" });
  assert.equal(it.enclosure["@_url"], "https://c.example.test/1.mp3");
  assert.notEqual(feedParser(), feedParser(), "a new parser per call; callers that want one keep it");
});
