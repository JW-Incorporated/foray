import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED, COMMUTE_FRAMING, INTERNAL_VOCABULARY, houseStyleTitle, titleStyleProblems, toListenerWords, wordCount } from "../src/copy/rules";

/**
 * Golden copy rules — the editorial standards from 03_CURATION_SPEC.md and
 * docs/DECISIONS.md, enforced as CI gates so regenerated copy (agent- or
 * pipeline-produced) can never silently regress:
 *   - why-lines <= 18 words; hooks <= 16 words
 *   - no generic-praise filler ("fascinating", "deep dive", "delves", "explores")
 *   - no commute-length framing (dropped 2026-07-08: state observed, not declared;
 *     every string on a session card, via COMMUTE_FRAMING, since qa 152 2026-09-23)
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

/**
 * Every string on a session card, not just the why-line. The 2026-09-22 QA
 * audit (qa 152) found four `fit_line`s carrying the commute-length framing
 * DECISIONS 2026-07-08 dropped ("a week of drives", "fits today's drive", "a
 * multi-commute saga", "two drives"), plus `archetype_label: "Deep dive"`, and
 * this suite read `why_line` only, so all five shipped. The iOS card renders
 * both fields (TodayView.swift, NowPlayingView.swift); the web does not yet.
 *
 * MUTATION: put "fits today's drive almost exactly." back in slot 2's fit_line,
 * or "Deep dive" back in slot 1's archetype_label -> red, naming the field.
 */
describe("session card copy", () => {
  const cardStrings = (card: Record<string, unknown>): Array<[string, string]> =>
    Object.entries(card).filter((e): e is [string, string] => typeof e[1] === "string");

  for (const card of session.cards) {
    it(`slot ${card.slot} (${card.archetype}) why-line obeys copy rules`, () => {
      expect(card.why_line, "why-line missing").toBeTruthy();
      expect(wordCount(card.why_line), `too long: "${card.why_line}"`).toBeLessThanOrEqual(18);
    });

    it(`slot ${card.slot} (${card.archetype}): no string field carries a banned phrase or commute-length framing`, () => {
      const fields = cardStrings(card);
      expect(fields.map(([k]) => k), "fit_line and archetype_label must be read, not just why_line").toEqual(
        expect.arrayContaining(["archetype_label", "why_line", "fit_line"])
      );
      for (const [field, text] of fields) {
        for (const rx of [...BANNED, ...COMMUTE_FRAMING]) {
          expect(text, `${field}: ${rx} in "${text}"`).not.toMatch(rx);
        }
      }
    });
  }

  it("category labels and descriptions carry no banned phrase or commute-length framing", () => {
    const failures: string[] = [];
    for (const cat of session.categories as Array<{ id: string; label: string; description: string }>) {
      for (const [field, text] of [["label", cat.label], ["description", cat.description]] as Array<[string, string]>) {
        for (const rx of [...BANNED, ...COMMUTE_FRAMING]) {
          if (rx.test(text)) failures.push(`${cat.id} ${field}: ${rx} in "${text}"`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

/**
 * COMMUTE_FRAMING is scoped to our own fit copy because `BANNED` also gates
 * discover.json hooks, where "drive" is ordinary English 24 times over. The
 * plain-English lines below are committed hooks; the framing lines are the
 * four qa 152 found plus the shapes fitLine() used to emit (F3.2 in
 * docs/architecture-assessment.md).
 * MUTATION: add `/\bdrives?\b/i` to COMMUTE_FRAMING -> red on the hooks.
 */
describe("COMMUTE_FRAMING", () => {
  const PLAIN_ENGLISH = [
    "Flawed historical reasoning drives the Court's final rulings on agencies and citizenship.",
    "Karen Kosiba drives a fleet of Doppler-on-Wheels radar trucks into storms.",
    "Two men and a dog drive coast to coast before anyone believed cars would last.",
    "Insomnia is often hyperarousal, not a lack of sleep drive -- here's the fix.",
    "Founders host analyzes Bob Dylan's autobiography for lessons on artistic drive and reinvention.",
    "Devin explains building a 3,000-plus horsepower Drag and Drive car that survives road miles.",
    "Fortune and Tig plan a road trip and daydream about nostalgic desserts.",
    "194 min (≈ 129 at 1.5×); pick up where you left off.",
    "Low-effort comedy for tired drives."
  ];
  const FRAMING = [
    "3¼ hrs — a week of drives at your 1.5×; pick up where you left off.",
    "37 min ≈ 25 at your speed: fits today's drive almost exactly.",
    "3 hrs of documentary — a multi-commute saga.",
    "57 min ≈ two drives of easy hang.",
    "about 3 drives at your 1.5×",
    "fits today's drive comfortably",
    "the morning commute, exactly",
    "two drives' worth of history",
    "for the drive home",
    "several drives long",
    "your commute"
  ];

  it("catches the framing and none of the plain-English uses of drive", () => {
    for (const text of PLAIN_ENGLISH) {
      for (const rx of COMMUTE_FRAMING) expect(text, `${rx} must not match "${text}"`).not.toMatch(rx);
    }
    for (const text of FRAMING) {
      expect(COMMUTE_FRAMING.some((rx) => rx.test(text)), `"${text}" must be caught`).toBe(true);
    }
  });
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

/**
 * THE FORAY TITLE HOUSE STYLE. Wyatt, 2026-09-24, answering the audit's qa 146
 * (agent-generated titles were Title Case with no closing period, next to
 * sentence-case curated ones in the same rail): "Sentence case, no period,
 * though ? And ! Are allowed". The rule is rules.js `titleStyleProblems`;
 * check-forays.mjs refuses what it returns, on every Foray.
 */
describe("Foray title house style", () => {
  it("refuses Title Case and a closing period, and allows ? and ! — the four generated titles that prompted the ruling among them", () => {
    /* The first four are the committed generated titles as they were before
       this change. MUTATION THAT KILLS THIS: empty TITLE_CASE_TELLS -> the
       three with a capitalised "Actually"/"Really" go red; delete the
       lone-capital branch -> "Beyond the Algorithm..." goes red; delete the
       closing-period check -> the period case goes red. */
    const refused = [
      "Beyond the Algorithm: Engineering Production AI Systems",
      "How AI Actually Gets Built",
      "The Chain Reaction: How Engineering Disasters Really Happen",
      "What Engineers Actually Do All Day",
      "Why Doctors Didn't Believe In Germs",
      "A history of the iPhone.",
      "grilling: the surprising origin story"
    ];
    for (const title of refused) expect(titleStyleProblems(title), title).not.toEqual([]);
    expect(titleStyleProblems("A history of the iPhone.").join(" ")).toMatch(/closing period/);
    expect(titleStyleProblems("How AI Actually Gets Built").join(" ")).toMatch(/Title Case \(Actually, Gets\)/);
  });

  it("does not mistake a proper noun, an acronym or a quoted work's title for Title Case (no false positives)", () => {
    /* A name is a run of capitals; Title Case scatters them. MUTATION THAT
       KILLS THIS: drop the `lone` condition, or the quoted-word exemption, or
       add "will" or "may" back to TITLE_CASE_TELLS -> red, naming the title. */
    const fine = [
      "Barbecue: eight stories from a much longer history",
      "The types of capital a startup can raise",
      "How Earth got plate tectonics and Venus never did",
      "Beyond the algorithm: engineering production AI systems",
      "How AI actually gets built",
      "The chain reaction: how engineering disasters really happen",
      "What engineers actually do all day",
      "Inside NASA's Jet Propulsion Laboratory",
      "Steve Jobs and Bill Gates",
      "Why New York City and Los Angeles hate each other",
      "Why “How I Built This” still works",
      "Why Will Smith keeps working",
      "Was the Clean Air Act a success?",
      "The day the music died!",
      "How the war reached the U.S.",
      "eBay and the auction economy",
      "World War II from the air"
    ];
    for (const title of fine) expect(titleStyleProblems(title), title).toEqual([]);
  });

  it("houseStyleTitle does only what is safe on any title: drops a closing period, raises a lower-case first letter, lowercases nothing", () => {
    /* The generator's code-side half (runPipeline.ts forayCopy). MUTATION
       THAT KILLS THIS: lowercase the words after the first -> "AI" and
       "Venus" go red. */
    expect(houseStyleTitle("A history of the iPhone.")).toBe("A history of the iPhone");
    expect(houseStyleTitle("grilling: the surprising origin story")).toBe("Grilling: the surprising origin story");
    expect(houseStyleTitle("How Earth got plate tectonics and Venus never did")).toBe("How Earth got plate tectonics and Venus never did");
    expect(houseStyleTitle("How AI Actually Gets Built")).toBe("How AI Actually Gets Built");
    expect(houseStyleTitle("Why?")).toBe("Why?");
    expect(houseStyleTitle("How the war reached the U.S.")).toBe("How the war reached the U.S.");
    expect(houseStyleTitle("eBay and the auction economy")).toBe("eBay and the auction economy");
  });
});
