import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED, wordCount } from "../src/copy/rules";

/**
 * Golden copy rules — the editorial standards from 03_CURATION_SPEC.md and
 * docs/DECISIONS.md, enforced as CI gates so regenerated copy (agent- or
 * pipeline-produced) can never silently regress:
 *   - why-lines <= 18 words; hooks <= 16 words
 *   - no generic-praise filler ("fascinating", "deep dive", "delves", "explores")
 *   - no commute-length framing (dropped 2026-07-08: state observed, not declared)
 *   - no clickbait withholding
 *
 * BANNED + wordCount live in src/copy/rules.js — the single source of truth
 * shared with tools/refresh/merge.mjs (was two independently-drifting copies
 * before 2026-07-24; see docs/DECISIONS.md).
 */

const dataDir = join(__dirname, "..", "..", "data");
const session = JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8"));
const discover = JSON.parse(readFileSync(join(dataDir, "discover.json"), "utf8"));

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
