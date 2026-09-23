import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED, INTERNAL_VOCABULARY, toListenerWords, wordCount } from "../src/copy/rules";

/**
 * Golden copy rules — the editorial standards from 03_CURATION_SPEC.md and
 * docs/DECISIONS.md, enforced as CI gates so regenerated copy (agent- or
 * pipeline-produced) can never silently regress:
 *   - why-lines <= 18 words; hooks <= 16 words
 *   - no generic-praise filler ("fascinating", "deep dive", "delves", "explores")
 *   - no commute-length framing (dropped 2026-07-08: state observed, not declared)
 *   - no clickbait withholding
 *
 *   - no pipeline vocabulary in the copy we write about a Foray ("beat",
 *     "segment", "act", "running order" — INTERNAL_VOCABULARY, 2026-09-22 audit)
 *
 * BANNED + wordCount live in src/copy/rules.js — the single source of truth
 * shared with tools/refresh/merge.mjs (was two independently-drifting copies
 * before 2026-07-24; see docs/DECISIONS.md).
 */

const dataDir = join(__dirname, "..", "..", "data");
const session = JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8"));
const discover = JSON.parse(readFileSync(join(dataDir, "discover.json"), "utf8"));
const forays = JSON.parse(readFileSync(join(dataDir, "forays.json"), "utf8"));

describe("session card why-lines", () => {
  for (const card of session.cards) {
    it(`slot ${card.slot} (${card.archetype}) why-line obeys copy rules`, () => {
      expect(card.why_line, "why-line missing").toBeTruthy();
      expect(wordCount(card.why_line), `too long: "${card.why_line}"`).toBeLessThanOrEqual(18);
      for (const rx of BANNED) {
        expect(card.why_line, `banned phrase ${rx} in: "${card.why_line}"`).not.toMatch(rx);
      }
    });
  }
});

describe("discover hooks", () => {
  it("every hook obeys copy rules", () => {
    const failures: string[] = [];
    for (const item of discover.items) {
      if (!item.hook) failures.push(`${item.id}: missing hook`);
      else {
        if (wordCount(item.hook) > 16) failures.push(`${item.id}: too long (${wordCount(item.hook)}w): "${item.hook}"`);
        for (const rx of BANNED) {
          if (rx.test(item.hook)) failures.push(`${item.id}: banned ${rx}: "${item.hook}"`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("hooks are concrete, not bare title repeats", () => {
    const lazy = discover.items.filter(
      (i: { hook: string; title: string }) => i.hook.trim().toLowerCase() === i.title.trim().toLowerCase()
    );
    expect(lazy.map((i: { id: string }) => i.id)).toEqual([]);
  });
});

/**
 * The copy WE write about a Foray — its title, summary and slot titles. The
 * 2026-09-22 design audit found "Barbecue: eight beats of a forty-beat history"
 * on a committed Foray: the curator's own unit, recited from the record's
 * `beats_total`, as a title. BANNED could not catch it because BANNED is about
 * filler; INTERNAL_VOCABULARY is about jargon, and it is applied only here and in
 * tools/foray/check-forays.mjs (which the publish gate runs), not to episode
 * hooks, where "the Clean Air Act" or "a market segment" is ordinary English.
 *
 * MUTATION: put "beats" back in grilling-history-2's title -> red, naming it.
 */
describe("Foray titles, summaries and slot titles", () => {
  it("carry no banned phrase and none of the pipeline's own words", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const foray of forays.forays as Array<{ id: string; title: string; summary: string; slots?: Array<{ id: string; title: string }> }>) {
      const fields: Array<[string, string]> = [
        ["title", foray.title],
        ["summary", foray.summary],
        ...(foray.slots ?? []).map((s): [string, string] => [`slot ${s.id}`, s.title])
      ];
      for (const [field, text] of fields) {
        checked += 1;
        for (const rx of [...BANNED, ...INTERNAL_VOCABULARY]) {
          if (rx.test(text)) failures.push(`${foray.id} ${field}: ${rx} in "${text}"`);
        }
      }
    }
    expect(checked, "no Foray copy was read, so this proved nothing").toBeGreaterThan(0);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /* PR #741 review: the first cut matched every "beat", "segment" and "act",
     so a generated Foray about the Beat poets, underdogs, market segments or a
     government that "failed to act" was refused at the publish gate after the
     spend. The verb and plain-noun uses below are the ones it refused.
     MUTATION: put `/\bbeats?\b/i` or `/\bacts?\b/` back in INTERNAL_VOCABULARY -> red,
     naming the phrase. */
  const PLAIN_ENGLISH = [
    "Barbecue: eight stories from a much longer history",
    "Why the Clean Air Act worked",
    "Five shows, one question",
    "The Beat Generation poets",
    "How underdogs beat incumbents",
    "Beat the odds: the long-shot campaigns",
    "When regulators failed to act",
    "Acts of Parliament that changed the Thames",
    "Three acts of kindness",
    "His final act as president",
    "Her second act as a novelist",
    "The last act of defiance",
    "Two Acts passed in 1970",
    "The Clean Air Act 1956",
    "A drum beat and a bass line",
    "Who owns the market segment"
  ];
  const PIPELINE_WORDS = [
    "eight beats of a forty-beat history",
    "22 segments",
    "Nine segments from five shows",
    "this act",
    "The last act: who got the credit",
    "Act one opens",
    "act 2",
    "Three acts, one fire",
    "the running order"
  ];

  it("the listener's words for the same things are not caught (no false positives on plain English)", () => {
    for (const text of PLAIN_ENGLISH) {
      for (const rx of INTERNAL_VOCABULARY) expect(text, `${rx} must not match "${text}"`).not.toMatch(rx);
    }
    for (const text of PIPELINE_WORDS) {
      expect(INTERNAL_VOCABULARY.some((rx) => rx.test(text)), `"${text}" must be caught`).toBe(true);
    }
  });

  it("toListenerWords turns every caught phrase into copy the list passes, and leaves plain English alone", () => {
    /* The generator's repair (runPipeline.ts forayCopy / slotsFromSpine): if its
       output could still match, the publish gate would refuse the Foray after
       the spend anyway. MUTATION: drop the "running order" rewrite (or any one
       rewrite) from toListenerWords -> red, naming the phrase. */
    for (const text of PIPELINE_WORDS) {
      const out = toListenerWords(text);
      expect(out.changed, `"${text}" must be rewritten`).toBe(true);
      for (const rx of INTERNAL_VOCABULARY) expect(out.text, `${rx} still matches the rewrite of "${text}"`).not.toMatch(rx);
    }
    expect(toListenerWords("Barbecue: eight beats of a forty-beat history").text).toBe("Barbecue: eight stories of a forty-part history");
    expect(toListenerWords("Act one: the hearth").text).toBe("Part one: the hearth");
    for (const text of PLAIN_ENGLISH) expect(toListenerWords(text)).toEqual({ text, changed: false });
  });
});
