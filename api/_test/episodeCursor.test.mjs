// api/_lib/episodeCursor.ts unit tests (S-02, kanban t_4bd3c0a3).
import { test } from "node:test";
import assert from "node:assert";
import { encodeCursor, decodeCursor, compareKeys, paginate } from "../_lib/episodeCursor.ts";

function ep(guid, publishedAt) {
  return { show_id: "s", guid, published_at: publishedAt, title: guid };
}

test("encode/decode round-trips a cursor", () => {
  const key = { publishedAt: "2026-01-01T00:00:00.000Z", guid: "ep-1" };
  assert.deepStrictEqual(decodeCursor(encodeCursor(key)), key);
});

test("decodeCursor never throws on garbage input — returns null", () => {
  assert.strictEqual(decodeCursor(null), null);
  assert.strictEqual(decodeCursor(undefined), null);
  assert.strictEqual(decodeCursor(""), null);
  assert.strictEqual(decodeCursor("not-base64!!!"), null);
  assert.strictEqual(decodeCursor(Buffer.from("not json", "utf8").toString("base64url")), null);
  assert.strictEqual(decodeCursor(Buffer.from(JSON.stringify({ guid: 5 }), "utf8").toString("base64url")), null);
  assert.strictEqual(decodeCursor(Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url")), null);
});

test("compareKeys orders published_at descending", () => {
  const newer = { publishedAt: "2026-02-01T00:00:00.000Z", guid: "a" };
  const older = { publishedAt: "2026-01-01T00:00:00.000Z", guid: "b" };
  assert.ok(compareKeys(newer, older) < 0);
  assert.ok(compareKeys(older, newer) > 0);
});

test("compareKeys uses guid as an ascending tiebreak on equal timestamps", () => {
  const a = { publishedAt: "2026-01-01T00:00:00.000Z", guid: "a" };
  const b = { publishedAt: "2026-01-01T00:00:00.000Z", guid: "b" };
  assert.ok(compareKeys(a, b) < 0);
  assert.ok(compareKeys(b, a) > 0);
  assert.strictEqual(compareKeys(a, { ...a }), 0);
});

test("paginate: null cursor starts from the top, sorted desc by published_at", () => {
  const episodes = [ep("e1", "2026-01-01T00:00:00.000Z"), ep("e3", "2026-03-01T00:00:00.000Z"), ep("e2", "2026-02-01T00:00:00.000Z")];
  const { page, nextCursor } = paginate(episodes, null, 2);
  assert.deepStrictEqual(page.map((e) => e.guid), ["e3", "e2"]);
  assert.ok(nextCursor);
});

test("paginate: cursor resumes strictly after the given key", () => {
  const episodes = [ep("e1", "2026-01-01T00:00:00.000Z"), ep("e3", "2026-03-01T00:00:00.000Z"), ep("e2", "2026-02-01T00:00:00.000Z")];
  const { page, nextCursor } = paginate(episodes, { publishedAt: "2026-02-01T00:00:00.000Z", guid: "e2" }, 2);
  assert.deepStrictEqual(page.map((e) => e.guid), ["e1"]);
  assert.strictEqual(nextCursor, null);
});

test("paginate: last page has no next_cursor", () => {
  const episodes = [ep("e1", "2026-01-01T00:00:00.000Z")];
  const { nextCursor } = paginate(episodes, null, 100);
  assert.strictEqual(nextCursor, null);
});

// The equal-timestamp page-boundary case Fable's ruling on this design
// flagged explicitly: a bulk-imported feed backfill commonly stamps many
// episodes with the SAME published_at. Without the guid tiebreaker applied
// identically in both the sort and the "resume after cursor" comparison, a
// page boundary landing inside such a run either skips or duplicates rows.
test("paginate: a run of identical published_at values pages correctly with no skip or duplicate (mutation: dropping the guid tiebreak from either the sort or the cursor comparison breaks this)", () => {
  const SAME = "2026-05-01T00:00:00.000Z";
  const episodes = [ep("c", SAME), ep("a", SAME), ep("b", SAME), ep("d", SAME), ep("e", SAME)];
  const pageSize = 2;

  const all = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const { page, nextCursor } = paginate(episodes, cursor, pageSize);
    all.push(...page.map((e) => e.guid));
    if (!nextCursor) break;
    cursor = decodeCursor(nextCursor);
  }

  // Sorted ascending by guid (the tiebreak direction), since all timestamps tie.
  assert.deepStrictEqual(all, ["a", "b", "c", "d", "e"]);
  // No duplicates, none dropped.
  assert.strictEqual(new Set(all).size, episodes.length);
});

test("paginate: episodes with a null published_at sort last, guid still tiebreaks among them", () => {
  const episodes = [ep("z", null), ep("y", null), ep("newest", "2026-01-01T00:00:00.000Z")];
  const { page } = paginate(episodes, null, 10);
  assert.deepStrictEqual(page.map((e) => e.guid), ["newest", "y", "z"]);
});
