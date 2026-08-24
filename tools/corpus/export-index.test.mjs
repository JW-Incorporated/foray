/* export-index: the digests parser (fail-closed), the DB→index join, and the
 * invariants that keep third-party text out of the public repo. No network.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMigrated } from "./db.mjs";
import { loadManifest } from "./manifest.mjs";
import { ingestSource } from "./ingest.mjs";
import {
  parseDigests,
  buildIndex,
  serializeIndex,
  diffIndexAgainstDigests,
  verbatimRuns,
  checkVerbatimOverlap,
  INDEX_SCHEMA,
  MAX_DIGEST_CHARS,
  MAX_FACT_CHARS,
} from "./export-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DIGESTS_PATH = path.join(REPO_ROOT, "docs", "research", "corpus", "digests.md");
const INDEX_PATH = path.join(REPO_ROOT, "docs", "research", "corpus", "corpus-index.json");

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-export-")), "test.db");

/* Temp archive root for every ingest here. A temp DATABASE used to imply
 * nothing about where the archive files landed, so these fixtures wrote (and,
 * once removeStaleArchives existed, deleted) real files under
 * data-local/corpus/ by source id. See db.test.mjs's note. */
const ARCHIVE = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-export-archive-"));

const entry = (over = {}) => {
  const f = {
    id: 1,
    title: "A Source",
    url: "https://example.com/a",
    redistribution: "deny",
    license: "All rights reserved",
    evidence: "https://example.com/terms — no redistribution grant in the site terms",
    verified: "web",
    digest: "Our own summary of what this source establishes.",
    facts: ["- first fact", "- second fact"],
    ...over,
  };
  return [
    `## ${f.id}. ${f.title}`,
    ``,
    `- url: ${f.url}`,
    `- redistribution: ${f.redistribution}`,
    `- license: ${f.license}`,
    `- license-evidence: ${f.evidence}`,
    `- verified: ${f.verified}`,
    ``,
    f.digest,
    ``,
    `**Key facts**`,
    ``,
    ...f.facts,
    ``,
  ].join("\n");
};

const doc = (...entries) => `# Research corpus — source digests\n\nPreamble prose.\n\n${entries.join("\n")}`;

/* ---------------------------------------------------------------- parser */

test("parseDigests: reads fields, digest prose and key facts", () => {
  const [e] = parseDigests(doc(entry()));
  assert.equal(e.id, 1);
  assert.equal(e.title, "A Source");
  assert.equal(e.url, "https://example.com/a");
  assert.equal(e.digest, "Our own summary of what this source establishes.");
  assert.deepEqual(e.key_facts, ["first fact", "second fact"]);
  assert.equal(e.license.redistribution, "deny");
  assert.equal(e.license.id, "All rights reserved");
  assert.equal(e.license.evidence_url, "https://example.com/terms");
  assert.equal(e.license.note, "no redistribution grant in the site terms");
  assert.equal(e.license.verified, "web");
});

test("parseDigests: keeps multi-paragraph digests intact", () => {
  const [e] = parseDigests(doc(entry({ digest: "First paragraph.\n\nSecond paragraph." })));
  assert.equal(e.digest, "First paragraph.\n\nSecond paragraph.");
});

test("parseDigests: reads several entries and preserves ids", () => {
  const entries = parseDigests(doc(entry(), entry({ id: 7, url: "https://example.com/g" })));
  assert.deepEqual(entries.map((e) => e.id), [1, 7]);
});

test("parseDigests: section headings and rules between entries end an entry", () => {
  const md = doc(entry(), "\n---\n\n# Area 2 — Speech Processing\n\n", entry({ id: 3, url: "https://example.com/c" }));
  const entries = parseDigests(md);
  assert.deepEqual(entries.map((e) => e.id), [1, 3]);
  assert.deepEqual(entries[0].key_facts, ["first fact", "second fact"]);
});

test("parseDigests: non-url license evidence becomes a note, not a fake url", () => {
  const [e] = parseDigests(doc(entry({ evidence: "none-found — searched the footer and /terms" })));
  assert.equal(e.license.evidence_url, null);
  assert.match(e.license.note, /searched the footer/);
});

test("parseDigests: fails closed on a missing field", () => {
  const broken = entry().replace("- verified: web\n", "");
  assert.throws(() => parseDigests(doc(broken)), /missing field "verified"/);
});

test("parseDigests: rejects an unknown redistribution verdict", () => {
  assert.throws(() => parseDigests(doc(entry({ redistribution: "probably-fine" }))), /allow\|deny/);
});

test("parseDigests: 'allow' demands a named license and an evidence url", () => {
  assert.throws(
    () => parseDigests(doc(entry({ redistribution: "allow", evidence: "none-found — nothing seen" }))),
    /needs a license-evidence URL/
  );
  assert.throws(
    () => parseDigests(doc(entry({ redistribution: "allow", license: "unknown" }))),
    /needs a named license/
  );
});

test("parseDigests: rejects duplicate source ids", () => {
  assert.throws(() => parseDigests(doc(entry(), entry())), /duplicate entry/);
});

test("parseDigests: rejects a digest long enough to be pasted source text", () => {
  assert.throws(
    () => parseDigests(doc(entry({ digest: "word ".repeat(MAX_DIGEST_CHARS) }))),
    /digests are our summary, not the source text/
  );
  assert.throws(
    () => parseDigests(doc(entry({ facts: ["- " + "x".repeat(MAX_FACT_CHARS + 1)] }))),
    /key fact is \d+ chars/
  );
});

test("parseDigests: requires key facts and a parseable key-facts block", () => {
  assert.throws(() => parseDigests(doc(entry({ facts: [] }))), /no key facts/);
  const noBlock = entry().replace("**Key facts**\n", "");
  assert.throws(() => parseDigests(doc(noBlock)), /missing \*\*Key facts\*\*/);
  assert.throws(() => parseDigests(doc(entry({ facts: ["not a bullet"] }))), /unexpected line/);
});

test("parseDigests: rejects a non-http url and an empty document", () => {
  assert.throws(() => parseDigests(doc(entry({ url: "file:///etc/passwd" }))), /url must be http/);
  assert.throws(() => parseDigests("# nothing here\n"), /no `## <id>\. <title>` entries/);
});

/* ------------------------------------------------------------ index join */

function seeded() {
  const db = openMigrated(tmpDb(), { create: true });
  loadManifest(db, [
    {
      area: 8, area_name: "Legal / Policy Landscape", title: "Court Opinion",
      url: "https://example.gov/opinion", source_type: "court-opinion",
      why_it_matters: "the server test", read_first: 1,
    },
    {
      area: 7, area_name: "Prior Art & Postmortems", title: "Trade Press Piece",
      url: "https://example.com/news", source_type: "blog",
      why_it_matters: "postmortem", read_first: 0,
    },
  ]);
  return db;
}

const digestsFor = (db, over = {}) => {
  const rows = db.prepare("SELECT id, title, url FROM sources ORDER BY id").all();
  return doc(...rows.map((r) => entry({ id: r.id, title: r.title, url: r.url, ...over })));
};

test("buildIndex: joins fetch facts to authored digests", async () => {
  const db = seeded();
  const src = db.prepare("SELECT * FROM sources ORDER BY id").all();
  await ingestSource(db, {
    async fetchUrl(url) {
      return { ok: true, status: 200, finalUrl: url, contentType: "text/plain", body: Buffer.from("# T\n\n" + "Sentence of real content. ".repeat(60)), notes: [] };
    },
  }, src[0], { corpusRoot: ARCHIVE });

  const index = buildIndex(db, parseDigests(digestsFor(db)), { generatedAt: "TEST-TIME" });
  assert.equal(index.schema, INDEX_SCHEMA);
  assert.equal(index.generated_at, "TEST-TIME");
  assert.equal(index.totals.sources, 2);
  assert.equal(index.totals.ingested, 1);
  assert.equal(index.totals.redistribution_denied, 2);

  const ingested = index.sources.find((s) => s.id === src[0].id);
  assert.equal(ingested.fetch.status, "ingested");
  assert.match(ingested.fetch.content_sha256, /^[0-9a-f]{64}$/);
  assert.ok(ingested.fetch.chunks >= 1);
  assert.match(ingested.local_archive.markdown, /^markdown\//);
  assert.equal(ingested.read_first, true);

  const unfetched = index.sources.find((s) => s.id === src[1].id);
  assert.equal(unfetched.fetch.status, "unfetched");
  assert.equal(unfetched.fetch.content_sha256, null);
  assert.equal(unfetched.local_archive, null);
});

test("buildIndex: no chunk text, no source prose, ever reaches the index", async () => {
  const db = seeded();
  const src = db.prepare("SELECT * FROM sources ORDER BY id").all();
  const secret = "ZZQQUNIQUEPHRASEFROMTHESOURCE";
  await ingestSource(db, {
    async fetchUrl(url) {
      return { ok: true, status: 200, finalUrl: url, contentType: "text/plain", body: Buffer.from(`# T\n\n${secret}. ` + "Sentence of real content. ".repeat(60)), notes: [] };
    },
  }, src[0], { corpusRoot: ARCHIVE });

  const json = serializeIndex(buildIndex(db, parseDigests(digestsFor(db))));
  assert.ok(!json.includes(secret), "index must not carry scraped text");
});

test("buildIndex: refuses a source with no digest, and a digest with no source", () => {
  const db = seeded();
  const rows = db.prepare("SELECT id, title, url FROM sources ORDER BY id").all();
  assert.throws(
    () => buildIndex(db, parseDigests(doc(entry({ id: rows[0].id, url: rows[0].url })))),
    /missing entries for source\(s\)/
  );
  assert.throws(
    () => buildIndex(db, parseDigests(digestsFor(db) + entry({ id: 999, url: "https://example.com/ghost" }))),
    /unknown source\(s\) 999/
  );
});

test("buildIndex: refuses a digest whose url drifted from the dossier", () => {
  const db = seeded();
  const rows = db.prepare("SELECT id, title, url FROM sources ORDER BY id").all();
  const drifted = doc(
    entry({ id: rows[0].id, url: "https://example.com/moved" }),
    entry({ id: rows[1].id, url: rows[1].url })
  );
  assert.throws(() => buildIndex(db, parseDigests(drifted)), /does not match the dossier url/);
});

test("diffIndexAgainstDigests: clean when in sync, specific when not", () => {
  const db = seeded();
  const entries = parseDigests(digestsFor(db));
  const index = buildIndex(db, entries);
  assert.deepEqual(diffIndexAgainstDigests(index, entries), []);

  const edited = structuredClone(entries);
  edited[0].digest = "Someone edited the digest without re-running the exporter.";
  edited[1].license.redistribution = "allow";
  const problems = diffIndexAgainstDigests(index, edited);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /digest text differs/);
  assert.match(problems.join("\n"), /redistribution verdict differs/);
});

/* ------------------------------------------------------- verbatim guard */

const SOURCE_PROSE =
  "The server test holds that a website which does not store an image on its own servers is " +
  "not displaying it, and so cannot be liable for infringing the display right of the owner.";

test("verbatimRuns: catches a sentence lifted out of the source", () => {
  const entry = {
    digest: "Background noise. " + SOURCE_PROSE + " More of our own analysis follows here.",
    key_facts: ["9th Circuit, 2023"],
  };
  const runs = verbatimRuns(entry, "Preamble. " + SOURCE_PROSE + " Trailing text.");
  assert.ok(runs.length >= 1, "a copied sentence must be flagged");
  assert.match(runs[0], /server test/);
});

test("verbatimRuns: a digest written in our own words is clean", () => {
  const entry = {
    digest: "The Ninth Circuit rejected the argument that embedding avoids the display right; storage location is not the test.",
    key_facts: ["Hunley v. Instagram, 9th Cir. 2023"],
  };
  assert.deepEqual(verbatimRuns(entry, SOURCE_PROSE), []);
});

test("verbatimRuns: shared lists of identifiers are facts, not copied prose", () => {
  /* Five MIME types in the documented order will always match; that is a fact,
   * and the stopword floor is what keeps the guard from crying wolf on it. */
  const list = "text/plain, text/html, text/vtt, application/json, application/x-subrip";
  const entry = { digest: "Required attributes are url and type. Documented MIME types: " + list, key_facts: [list] };
  assert.deepEqual(verbatimRuns(entry, "The type attribute accepts " + list + " as values."), []);
});

test("checkVerbatimOverlap: skips entries with no local archive, reports the rest", () => {
  const entries = [
    { id: 1, digest: SOURCE_PROSE, key_facts: ["x"] },
    { id: 2, digest: "Our own sentence about something else entirely.", key_facts: ["y"] },
  ];
  const { checked, problems } = checkVerbatimOverlap(entries, (e) => (e.id === 1 ? SOURCE_PROSE : null));
  assert.equal(checked, 1, "the archive-less entry is skipped, not failed");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /source 1: digest reuses \d+ 10-word run\(s\)/);
});

/* ------------------------------------------------- the committed artifacts */

test("committed digests.md parses and covers every committed index source", () => {
  const entries = parseDigests(fs.readFileSync(DIGESTS_PATH, "utf8"));
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  assert.equal(index.schema, INDEX_SCHEMA);
  assert.equal(entries.length, index.sources.length);
  assert.deepEqual(diffIndexAgainstDigests(index, entries), []);
});

test("committed index publishes an evidenced verdict for every source", () => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  for (const s of index.sources) {
    assert.ok(["allow", "deny"].includes(s.license.redistribution), `source ${s.id} has no verdict`);
    assert.ok(s.license.note || s.license.evidence_url, `source ${s.id} has no licensing evidence`);
    if (s.license.redistribution === "allow") {
      assert.match(s.license.evidence_url ?? "", /^https?:\/\//, `source ${s.id} allows redistribution with no evidence url`);
    }
    assert.ok(s.digest.length <= MAX_DIGEST_CHARS, `source ${s.id} digest is oversized`);
    assert.ok(s.key_facts.length >= 1, `source ${s.id} has no key facts`);
  }
});

test("committed index carries no local-only absolute paths", () => {
  const raw = fs.readFileSync(INDEX_PATH, "utf8");
  assert.ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(raw), "index leaks a machine-specific path");
});
