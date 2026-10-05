import { describe, it, expect } from "vitest";
import { addEpisodeToDf, corpusDfTable, scoreTerms, termFrequencies } from "../src/cli/buildCorpusTerms";

/**
 * PKG-26 (docs/roadmap/corpus.md §3): the corpus-wide df table and the
 * per-episode top-k tf-idf terms the topic assignment reads. Pure functions
 * only — the CLI's two passes are these four rules applied to every body.
 *
 * Mutations each test kills (run by hand before merge):
 *   1. scoreTerms: drop the idf (score = tf)              -> "rare above common" fails
 *   2. scoreTerms: drop the alphabetical tie-break         -> "ties" fails
 *   3. scoreTerms: drop the `slice(0, k)` cap              -> "k caps" fails
 *   4. corpusDfTable: keep df 1 (minDf filter removed)     -> "singletons" fails
 *      addEpisodeToDf: add tf instead of 1 per episode    -> "singletons" fails
 */

const map = (entries: Array<[string, number]>) => new Map<string, number>(entries);

describe("buildCorpusTerms", () => {
  it("scoreTerms ranks a rare term above a common one said more often", () => {
    /* "podcast" is in 99 of 100 episodes and said 5 times here; "semmelweis"
       is in 2 and said twice. Raw frequency would put "podcast" first. */
    const tf = map([
      ["podcast", 5],
      ["semmelweis", 2]
    ]);
    const df = map([
      ["podcast", 99],
      ["semmelweis", 2]
    ]);
    const ranked = scoreTerms(tf, df, 100, 2);
    expect(ranked.map(([t]) => t)).toEqual(["semmelweis", "podcast"]);
    expect(ranked[0]?.[1]).toBeCloseTo(2 * Math.log(1 + (100 - 2 + 0.5) / (2 + 0.5)), 10);
  });

  it("ties break alphabetically, whatever order the terms were counted in", () => {
    /* Same tf, same df -> the same score; insertion order is reverse alpha so
       a sort that ignored the term would leave them as counted. */
    const tf = map([
      ["zebra", 3],
      ["mango", 3],
      ["apple", 3]
    ]);
    const df = map([
      ["zebra", 4],
      ["mango", 4],
      ["apple", 4]
    ]);
    expect(scoreTerms(tf, df, 50, 3).map(([t]) => t)).toEqual(["apple", "mango", "zebra"]);
  });

  it("k caps the number of terms returned, keeping the best k", () => {
    const tf = map([
      ["alpha", 1],
      ["bravo", 2],
      ["charlie", 3],
      ["delta", 4],
      ["echo", 5]
    ]);
    const df = map([...tf.keys()].map((t): [string, number] => [t, 3]));
    const top = scoreTerms(tf, df, 40, 2);
    expect(top.map(([t]) => t)).toEqual(["echo", "delta"]);
    expect(scoreTerms(tf, df, 40, 0)).toEqual([]);
  });

  it("the df table counts distinct episodes and excludes singletons", () => {
    /* Episode A says "miasma" six times and is the only one that says it at
       all: df 1, so it is NOT in the written table however loud it was. */
    const df = new Map<string, number>();
    addEpisodeToDf(df, termFrequencies(["Miasma miasma miasma, said the doctor.", "Miasma miasma miasma germs."]));
    addEpisodeToDf(df, termFrequencies(["Germs and the doctor again."]));
    addEpisodeToDf(df, termFrequencies(["Cholera arrived with the doctor."]));
    const table = corpusDfTable(df);
    expect(Object.keys(table)).toEqual(["doctor", "germs"]);
    expect(table.doctor).toBe(3);
    expect(table.germs).toBe(2);
    expect(Object.hasOwn(table, "miasma")).toBe(false);
    expect(Object.hasOwn(table, "cholera")).toBe(false);
  });
});
