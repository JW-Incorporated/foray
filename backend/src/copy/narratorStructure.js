"use strict";
/**
 * THE NARRATOR NEVER MENTIONS THE FORAY'S OWN STRUCTURE.
 *
 * Wyatt, 2026-09-13: "the narrator should never mention acts or beats in
 * the context of the foray formatting (for example, saying 'this foray has
 * 3 acts' is NOK but mentioning 'in the first act of Macbeth' is fine if
 * it's relevant)."
 *
 * So this is a ban on SELF-REFERENTIAL STRUCTURAL LANGUAGE, not a banned
 * word list. "This foray has three acts", "in this second act", "the next
 * beat", "in this segment", "part one of three" are all out. "In the first
 * act of Macbeth", "the second act of the crisis", "his first act as
 * chairman" are all fine — and a naive /\bact\b/ would fail every one of
 * them, which is exactly the example the founder chose to name.
 *
 * THE RULE, IN ONE SENTENCE. A structural noun — act, beat, segment, part,
 * chapter, section, instalment — must be ANCHORED to something outside this
 * Foray. It is anchored when an "of" phrase follows it ("the first act OF
 * MACBETH") or a possessive precedes it ("MACBETH'S first act"). Unanchored,
 * it can only mean the thing the listener is currently listening to, and
 * that is the thing the narrator may not talk about.
 *
 * Two deliberate holes in the "of" anchor, because both are the founder's
 * own banned shape wearing an anchor's clothes:
 *   - "part one OF THREE" — an of-phrase naming a NUMBER counts the Foray's
 *     own pieces; it anchors nothing.
 *   - "the first act OF THIS FORAY" — an of-phrase naming the programme is
 *     the self-reference spelled out.
 *
 * WHERE IT IS IMPRECISE, stated plainly because the alternative is a check
 * that pretends. It WRONGLY FLAGS a structural noun whose external referent
 * was named in an earlier sentence ("Macbeth opens in a storm. The second
 * act is where it turns."), "the next part" meaning the next stage of a
 * process, "three parts hydrogen", and "the police beat". It WRONGLY PASSES
 * every self-reference that avoids these nouns — "coming up", "in a
 * moment", "before the break", "we'll come back to that", "the second
 * half". A rule that is right most of the time and says where it is not
 * beats one that claims to be right everywhere.
 *
 * DELIBERATELY PLAIN CommonJS, alongside `rules.js` and for that file's own
 * reason: this rule has to be read by the TypeScript writer
 * (`writeAct.ts`'s `validateSeam`, so a violation is rejected in code and
 * the writer retries) AND by two dependency-free ESM checkers
 * (`tools/foray/check-narration.mjs`, which is where narration rules live
 * and which re-exports it, and `tools/foray/check-forays.mjs`, which gates
 * every generated Foray's narration items). A `.js` file with a
 * hand-authored `.d.ts` is the one shape all three can load with no build
 * step — the precedent `rules.js` set, and the reason it is not three
 * copies.
 */

/* The nouns that name a piece of a programme. `part` and `section` are
   ordinary English too, which is what the anchor rule is for: "part OF the
   problem" and "a section OF the pipeline" both carry their anchor. */
const STRUCTURE_NOUN = "acts?|beats?|segments?|chapters?|sections?|parts?|instalments?|installments?";

/* Determiners that, unanchored, can only point at the programme playing.
   Possessive determiners (its, his, her, their) are NOT here: they already
   point at an owner outside the Foray, which is what makes "his first act
   as chairman" ordinary English rather than a structural aside. */
const SELF_DETERMINER = "this|that|these|those|our|the\\s+(?:next|last|final|previous|following|coming|first|second|third|fourth|fifth|sixth|seventh|opening|closing)";

/** An ordinal that may sit between the determiner and the noun ("this
 * second act"). */
const ORDINAL = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|next|previous|opening|closing";

/** Number words a count can be written as — §5d requires numbers spoken,
 * so these are the forms a script actually carries. Digits are included
 * anyway; `check-narration.mjs` bans them separately. */
const NUMBER_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|\\d+";

/** The words that name the thing the listener is listening to. */
const PROGRAMME_NOUN = "foray|forays|programme|program|episode|show|documentary|piece|hour|listen|recording";

const RULES = [
  {
    id: "self-determiner",
    rx: new RegExp(`\\b(?:${SELF_DETERMINER})\\s+(?:(?:${ORDINAL})\\s+)?(?:${STRUCTURE_NOUN})\\b`, "gi"),
    why: "points at a piece of this Foray"
  },
  {
    id: "numbered-piece",
    rx: new RegExp(`\\b(?:act|beat|segment|chapter|section|part)\\s+(?:${NUMBER_WORD})\\b`, "gi"),
    why: "numbers a piece of this Foray"
  },
  {
    id: "counted-pieces",
    rx: new RegExp(`\\b(?:${NUMBER_WORD})\\s+(?:acts|beats|segments|chapters|sections|parts|instalments|installments)\\b`, "gi"),
    why: "counts this Foray's own pieces"
  },
  {
    id: "names-the-programme",
    rx: new RegExp(`\\bthis\\s+(?:${PROGRAMME_NOUN})\\b`, "gi"),
    why: "talks about the programme the listener is listening to"
  }
];

/* An "of" phrase after the noun anchors it to something outside the Foray
   — UNLESS what follows is a number (counting the Foray's own pieces:
   "part one of three") or the programme itself ("the first act of this
   foray"). */
const OF_ANCHOR = new RegExp(`^\\s+of\\s+(?!(?:${NUMBER_WORD})\\b)(?!(?:this|our|the)\\s+(?:${PROGRAMME_NOUN})\\b)\\S`, "i");

/* A possessive before the noun anchors it the other way round: "Macbeth's
   first act", "the crisis's second act". A possessive naming the programme
   is not an anchor — "this foray's second act" is the same aside. */
const POSSESSIVE_ANCHOR = new RegExp(`(?:^|\\s)(?!(?:${PROGRAMME_NOUN})\\b)[A-Za-z][A-Za-z-]*['’]s\\s+(?:(?:${ORDINAL})\\s+)?$`, "i");

/**
 * Every structural self-reference in `text`, in order, deduplicated by the
 * phrase that matched.
 *
 * @param {string} text a spoken line
 * @returns {{phrase: string, rule: string, why: string}[]}
 */
function narratorStructureLeaks(text) {
  const line = String(text ?? "");
  if (line.trim().length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const rule of RULES) {
    rule.rx.lastIndex = 0;
    let m;
    while ((m = rule.rx.exec(line)) !== null) {
      const phrase = m[0];
      const after = line.slice(m.index + phrase.length);
      const before = line.slice(0, m.index);
      /* "names-the-programme" is about the programme itself, not a piece of
         it, so the possessive anchor cannot apply and only an of-phrase
         naming something else can excuse it ("this episode of The Crown"). */
      if (OF_ANCHOR.test(after)) continue;
      if (rule.id !== "names-the-programme" && POSSESSIVE_ANCHOR.test(before)) continue;
      const key = `${rule.id}::${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ phrase, rule: rule.id, why: rule.why });
    }
  }
  return out;
}

/**
 * The same thing as messages, for a checker that collects strings.
 *
 * @param {string} text
 * @param {string} where the caller's label for this line
 * @returns {string[]}
 */
function narratorStructureErrors(text, where) {
  return narratorStructureLeaks(text).map(
    (leak) =>
      `${where}: "${leak.phrase}" ${leak.why} — the narrator never mentions the Foray's own acts, beats or segments. ` +
      "A structural word is fine when it belongs to something else (\"the first act of Macbeth\", \"the second act of the crisis\"); " +
      "say it the way you would to a friend who cannot see the running order."
  );
}

module.exports = {
  narratorStructureLeaks,
  narratorStructureErrors,
  STRUCTURE_NOUN,
  PROGRAMME_NOUN
};
