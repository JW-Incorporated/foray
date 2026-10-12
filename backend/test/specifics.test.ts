import { describe, it, expect } from "vitest";
import {
  extractNames,
  extractSpecifics,
  prepareSpecificsSources,
  spokenNumberValues,
  unsupportedSpecifics,
  unsupportedSpecificsInScript,
  type SpecificsOptions
} from "../src/generation/specifics";

/**
 * GV-34 (docs/roadmap/generation-v2.md, W5-10): the numbers, dates and names
 * a narration sentence states, checked in code against its sources. Pure
 * table tests — no model, no fixture file, no network.
 *
 * MUTATIONS RUN against this suite (each turned it red, then reverted):
 *   1. readWordNumber without THE YEAR FORM branch — "nineteen sixty-four"
 *      reads 19 and 64, so the digit-vs-word year rows fail.
 *   2. numberSupported without the decade branch (decade compared by value
 *      only) — "the 1980s" against "in 1984" is flagged.
 *   3. nameSupported without the longest-token fallback — "Joe Couitt"
 *      against "couitt kept it" is flagged.
 *   4. extractNames without the sentence-initial common-word strip — "Today"
 *      and "The" become names.
 *   5. extractSpecifics without the small-cardinal exemption — "Two workers"
 *      is flagged.
 */

const NUMBER_CASES: Array<[string, string, Array<{ value: number; percent?: boolean; decade?: boolean; ordinal?: boolean }>]> = [
  ["a spoken year", "nineteen sixty-four", [{ value: 1964 }]],
  ["a spoken year without the hyphen", "nineteen sixty four", [{ value: 1964 }]],
  ["two thousand and eight", "two thousand and eight", [{ value: 2008 }]],
  ["twenty eighteen", "twenty eighteen", [{ value: 2018 }]],
  ["nineteen oh five", "nineteen oh five", [{ value: 1905 }]],
  ["nineteen hundred", "nineteen hundred", [{ value: 1900 }]],
  ["forty percent", "forty percent", [{ value: 40, percent: true }]],
  ["forty per cent", "forty per cent", [{ value: 40, percent: true }]],
  ["a digit percent", "40%", [{ value: 40, percent: true }]],
  ["three point five million", "three point five million", [{ value: 3.5e6 }]],
  ["a dozen", "a dozen", [{ value: 12 }]],
  ["two dozen", "two dozen", [{ value: 24 }]],
  ["three hundred and twenty", "three hundred and twenty", [{ value: 320 }]],
  ["a grouped digit count", "1,964", [{ value: 1964 }]],
  ["digits with a scale", "5 million", [{ value: 5e6 }]],
  ["currency with a scale", "$4.2 million", [{ value: 4.2e6 }]],
  ["the nineteen-eighties", "the nineteen-eighties", [{ value: 1980, decade: true }]],
  ["the 1980s", "the 1980s", [{ value: 1980, decade: true }]],
  ["an abbreviated range", "1964–68", [{ value: 1964 }, { value: 1968 }]],
  ["a word range", "between eleven and twelve", [{ value: 11 }, { value: 12 }]],
  ["a word ordinal", "the twenty-first century", [{ value: 21, ordinal: true }]],
  ["a digit ordinal", "the 21st century", [{ value: 21, ordinal: true }]],
  ["a bare plural tens word names no century", "back in the eighties", []]
];

const EXTRACT_CASES: Array<[string, string, { years?: string[]; numbers?: string[]; names?: string[] }, SpecificsOptions?]> = [
  ["a digit year", "In 1964 the plant closed.", { years: ["1964"], numbers: [], names: [] }],
  ["a small bare cardinal is exempt", "Two men walked in.", { years: [], numbers: [], names: [] }],
  ["an ordinal is exempt", "It was the first time.", { numbers: [], names: [] }],
  ["a small cardinal with a unit is not", "Three years later it closed.", { numbers: ["Three"] }],
  ["a sentence-initial article is not part of the name", "The Beatles played Shea Stadium.", { names: ["Beatles", "Shea Stadium"] }],
  ["a sentence-initial common word is not a name", "But nobody listened.", { names: [] }],
  ["a sentence-initial name is still a name", "Couitt kept the ledger.", { names: ["Couitt"] }],
  ["a possessive is stripped", "Joe Couitt's farm was sold.", { names: ["Joe Couitt"] }],
  ["a connector inside a name", "She studied at the University of Chicago.", { names: ["University of Chicago"] }],
  ["allowNames drops a show", "On Practical AI, the host said so.", { names: [] }, { allowNames: ["Practical AI"] }],
  ["a quotation's first word is initial", 'He said, "We were broke."', { names: [] }],
  ["a dash splits two names; the pronoun I is never one", "I think Smith—Jones split.", { names: ["Smith", "Jones"] }]
];

const SUPPORT_CASES: Array<[string, string, string[], string[], SpecificsOptions?]> = [
  ["digit year in the sentence, word year in the source", "In 1964 the mill closed.", ["the mill shut in nineteen sixty-four"], []],
  ["word year in the sentence, digit year in the source", "In nineteen sixty-four the mill closed.", ["Closed: 1964."], []],
  ["an unsupported year is flagged", "In 1965 the mill closed.", ["closed in 1964"], ["1965"]],
  ["'the nineteen-eighties' against '1980s'", "It peaked in the nineteen-eighties.", ["sales of the 1980s"], []],
  ["'1980s' against 'the nineteen-eighties'", "It peaked in the 1980s.", ["the nineteen-eighties"], []],
  ["a decade rests on a year inside it", "It peaked in the 1980s.", ["in 1984 sales peaked"], []],
  ["a year does not rest on its decade", "It peaked in 1984.", ["the 1980s"], ["1984"]],
  ["word percent against digit percent", "Forty percent of the crop failed.", ["40% of the harvest"], []],
  ["digit percent against 'per cent'", "40% of the crop failed.", ["forty per cent"], []],
  ["a wrong percent is flagged", "45% of the crop failed.", ["forty percent"], ["45%"]],
  ["a word range against an abbreviated range", "From 1964 to 1968 it ran.", ["it ran 1964–68"], []],
  ["an abbreviated range against a spoken range", "It ran 1964–68.", ["from nineteen sixty-four to nineteen sixty-eight"], []],
  ["a range end past the source is flagged", "It ran 1964–69.", ["1964 to 1968"], ["69"]],
  ["a lowercase ASR name supports the name", "Joe Couitt kept the ledger.", ["and joe couitt said the ledger was"], []],
  ["the surname alone supports a two-word name", "Joe Couitt kept the ledger.", ["couitt kept it"], []],
  ["a first name alone does not", "Joe Couitt kept the ledger.", ["joe kept it"], ["Joe Couitt"]],
  ["a sentence-initial common word is not a name", "Today the farm is quiet.", [], []],
  ["a sentence-initial name with no source", "Netflix bought the rights.", [], ["Netflix"]],
  ["an invented name is flagged", "Margaret Haines bought it.", ["the buyer paid cash"], ["Margaret Haines"]],
  ["scaled words against grouped digits", "It sold for three point five million dollars.", ["sold for $3,500,000"], []],
  ["a dozen against twelve", "A dozen workers stayed.", ["twelve workers"], []],
  ["eleven is past the small-cardinal exemption", "Eleven workers stayed.", ["ten workers"], ["Eleven"]],
  ["a small cardinal is exempt by default", "Two workers stayed.", [], []],
  ["the exemption is configurable", "Two workers stayed.", [], ["Two"], { smallCardinalMax: 1 }],
  ["ordinals can be checked", "It was the third mill.", [], ["third"], { exemptOrdinals: false }],
  ["two thousand and eight against 2008", "In two thousand and eight it reopened.", ["reopened 2008"], []],
  ["an allowed show name is never asked about", "On This American Life, Ira Glass said it.", ["glass said it"], [], { allowNames: ["This American Life"] }]
];

it("the tables hold at least 40 cases (the card's acceptance)", () => {
  /* Kills: a table trimmed below the acceptance count in a later edit. */
  expect(NUMBER_CASES.length + EXTRACT_CASES.length + SUPPORT_CASES.length).toBeGreaterThanOrEqual(40);
});

describe("spokenNumberValues: word and digit forms", () => {
  it.each(NUMBER_CASES)("%s", (_label, text, expected) => {
    const got = spokenNumberValues(text);
    expect(got.map((n) => n.value)).toEqual(expected.map((e) => e.value));
    expected.forEach((e, k) => {
      if (e.percent !== undefined) expect(got[k]!.percent).toBe(e.percent);
      if (e.decade !== undefined) expect(got[k]!.decade).toBe(e.decade);
      if (e.ordinal !== undefined) expect(got[k]!.ordinal).toBe(e.ordinal);
    });
  });

  it("a grouped figure is a count, never a year", () => {
    expect(extractSpecifics("They counted 1,964 sheep.").years).toEqual([]);
    expect(extractSpecifics("They counted 1,964 sheep.").numbers.map((n) => n.value)).toEqual([1964]);
  });
});

describe("extractSpecifics / extractNames", () => {
  it.each(EXTRACT_CASES)("%s", (_label, sentence, expected, opts) => {
    const got = extractSpecifics(sentence, opts ?? {});
    if (expected.years) expect(got.years.map((y) => y.text)).toEqual(expected.years);
    if (expected.numbers) expect(got.numbers.map((n) => n.text)).toEqual(expected.numbers);
    if (expected.names) expect(got.names).toEqual(expected.names);
  });

  it("extractNames is the same names extractSpecifics reports (exported for W5-15)", () => {
    expect(extractNames("Margaret Haines met Joe Couitt.")).toEqual(["Margaret Haines", "Joe Couitt"]);
  });
});

describe("unsupportedSpecifics", () => {
  it.each(SUPPORT_CASES)("%s", (_label, sentence, sources, expected, opts) => {
    expect(unsupportedSpecifics(sentence, sources, opts ?? {})).toEqual(expected);
  });

  it("prepared sources give the same answer as the raw texts", () => {
    const texts = ["closed in nineteen sixty-four", "joe couitt"];
    const sentence = "Joe Couitt saw it close in 1965, with Ann Bell.";
    expect(unsupportedSpecifics(sentence, prepareSpecificsSources(texts))).toEqual(unsupportedSpecifics(sentence, texts));
    expect(unsupportedSpecifics(sentence, texts)).toEqual(["1965", "Ann Bell"]);
  });

  it("unsupportedSpecificsInScript keeps only the sentences with something unsupported", () => {
    const script = "In 1964 it closed. Joe Couitt left.";
    expect(unsupportedSpecificsInScript(script, ["joe couitt left in 1964"])).toEqual([]);
    expect(unsupportedSpecificsInScript(script, ["joe couitt left"])).toEqual([{ sentence: "In 1964 it closed.", unsupported: ["1964"] }]);
  });
});
