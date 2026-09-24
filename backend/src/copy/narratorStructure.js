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
 * beats one that claims to be right everywhere. Since 2026-09-24 it also
 * wrongly flags "that spine" of a body and "missed one beat" of a song.
 *
 * 2026-09-24: THE PIPELINE'S WHOLE VOCABULARY, AND A REWRITE. Wyatt, on the
 * audit's persona 65 (the narrator says "this act", "Act one", "two acts
 * back" out loud): "Accept the ones that are currently there; update our
 * foray generation scripting to avoid making more in the future." Three
 * things changed here. The nouns now include the pipeline's `slot` and
 * `spine`, and the shapes now include a count back through the pieces ("one
 * act back") and a pointer at a counted run of them ("the next four acts").
 * The copy rules' INTERNAL_VOCABULARY (`rules.js`, the list a Foray's title
 * may not use) is applied to spoken narration too, under the anchors below.
 * And `toNarrationWords` rewrites what is left when no retry is: the
 * generation stages refuse first and rewrite last. The committed Forays
 * that say these words aloud keep them — they are voiced, and
 * `check-forays.mjs` names them in FORAYS_PREDATING_THE_NARRATOR_RULES.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- plain CommonJS by design (see the header)
const { INTERNAL_VOCABULARY } = require("./rules.js");

/* The nouns that name a piece of a programme. `part` and `section` are
   ordinary English too, which is what the anchor rule is for: "part OF the
   problem" and "a section OF the pipeline" both carry their anchor. `slot`
   and `spine` are the pipeline's own (2026-09-24): the spine is the plan a
   Foray is generated from and a slot is one of its headed sections, and the
   narrator has as little business naming either as it has naming an act. */
const STRUCTURE_NOUN = "acts?|beats?|segments?|slots?|spines?|chapters?|sections?|parts?|instalments?|installments?";

/* The same nouns, plural only, for the shapes that count them. */
const STRUCTURE_PLURAL = "acts|beats|segments|slots|chapters|sections|parts|instalments|installments";

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

/* The rules, in no order: `structureSpans` below resolves overlaps by
   keeping the earliest and then the longest match, so "the next four acts"
   is one pointer-count rather than a pointer plus a count, and "two acts
   back" is one relative reference rather than a count. */
const RULES = [
  {
    id: "self-determiner",
    rx: new RegExp(`\\b(?:${SELF_DETERMINER})\\s+(?:(?:${ORDINAL})\\s+)?(?:${STRUCTURE_NOUN})\\b`, "gi"),
    why: "points at a piece of this Foray"
  },
  {
    /* "part one of three" is taken whole: the of-phrase counts the pieces,
       and a rewrite that kept it would leave "the story of three". */
    id: "numbered-piece",
    rx: new RegExp(`\\b(?:act|beat|segment|slot|chapter|section|part)\\s+(?:${NUMBER_WORD})\\b(?:\\s+of\\s+(?:${NUMBER_WORD})\\b)?`, "gi"),
    why: "numbers a piece of this Foray"
  },
  {
    id: "counted-pieces",
    rx: new RegExp(`\\b(?:${NUMBER_WORD})\\s+(?:${STRUCTURE_PLURAL})\\b`, "gi"),
    why: "counts this Foray's own pieces"
  },
  {
    /* Persona 65 (2026-09-22 audit): "Two acts back, the ladder cracked. One
       act back, that crack forced a choice." The singular "one act back"
       slipped past the count above, which only knew plurals. */
    id: "relative-piece",
    rx: new RegExp(`\\b(?:${NUMBER_WORD}|an?|a few|a couple of|some)\\s+(?:acts?|beats?|segments?|slots?|chapters?|sections?)\\s+(?:back|ago|earlier|later|ahead|from now)\\b`, "gi"),
    why: "counts back or forward through this Foray's pieces"
  },
  {
    id: "pointer-count",
    rx: new RegExp(`\\b(?:the|these|those|our)\\s+(?:next|following|coming|last|previous|past|first|final|opening|closing)\\s+(?:${NUMBER_WORD})\\s+(?:${STRUCTURE_PLURAL})\\b`, "gi"),
    why: "counts this Foray's own pieces"
  },
  {
    id: "names-the-programme",
    rx: new RegExp(`\\bthis\\s+(?:${PROGRAMME_NOUN})\\b`, "gi"),
    why: "talks about the programme the listener is listening to"
  },
  /* THE PIPELINE'S WORDS, AS THE COPY RULES HAVE THEM (2026-09-24). `rules.js`
     INTERNAL_VOCABULARY is the list check-forays refuses in a Foray's title,
     summary and slot titles: a count of beats, segments or acts ("eight
     beats", "a forty-beat history", "one act"), a pointer at an act ("every
     act"), a numbered act, "running order". Spoken narration is held to the
     same list — Wyatt, 2026-09-24, on persona 65 ("this act", "Act one", "two
     acts back" said aloud): "update our foray generation scripting to avoid
     making more in the future" — so a word the title may not use can never
     be said aloud either, and a shape added to that list reaches the
     narrator with no second edit. It runs under the same anchors as the rules
     above: "the Clean Air Act" and "the play's three acts" stay fine.

     EXCEPT THE HYPHENATED COUNT (review of PR #785). In a title "a forty-beat
     history" recites our own fields; in speech "the three-act structure", "a
     one-act comedy" and "a four-beat pattern" are ordinary adjectives, and a
     Foray about screenwriting cannot avoid them — nor can its prelude, whose
     subject is spoken verbatim. So the list's `[ -]` joins are narrowed to a
     space here: "three acts" and "eight beats" are still counts, "three-act"
     is not. */
  ...INTERNAL_VOCABULARY.map((rx) => ({
    id: "pipeline-word",
    rx: new RegExp(rx.source.replace(/\[ -\]/g, " "), rx.flags.includes("g") ? rx.flags : `${rx.flags}g`),
    why: "uses the pipeline's own word for a piece of this Foray"
  }))
];

/* An "of" phrase after the noun anchors it to something outside the Foray
   — UNLESS what follows is a number (counting the Foray's own pieces:
   "part one of three") or the programme itself ("the first act of this
   foray"). */
const OF_ANCHOR = new RegExp(`^\\s+of\\s+(?!(?:${NUMBER_WORD})\\b)(?!(?:this|our|the)\\s+(?:${PROGRAMME_NOUN})\\b)\\S`, "i");

/* A beat in music: "ninety beats per minute", "four beats to the bar". A
   Foray about a drummer has to be able to say it. */
const TEMPO_ANCHOR = /^\s+(?:per\b|(?:a|to the|in the|in a|each) (?:bar|measure|minute)\b)/i;

/* The contractions that end in 's and are not possessives. "That's this
   act." is a pointer, and reading "That's" as an owner — the way "Macbeth's
   first act" is read — let it through (2026-09-24, found on a committed
   generated Foray). */
const NOT_A_POSSESSIVE = "(?:that|it|here|there|what|who|where|how|when|why|this|he|she|let|everyone|everybody|nobody|someone|somebody)['’]s";

/* A possessive before the noun anchors it the other way round: "Macbeth's
   first act", "the crisis's second act", "his final act". A possessive
   naming the programme is not an anchor — "this foray's second act" is the
   same aside. */
const POSSESSIVE_ANCHOR = new RegExp(
  `(?:^|\\s)(?:(?!(?:${PROGRAMME_NOUN})['’]s)(?!${NOT_A_POSSESSIVE}\\s)[A-Za-z][A-Za-z-]*['’]s|his|her|their|its|my|your|whose)\\s+(?:(?:${ORDINAL})\\s+)?$`,
  "i"
);

/**
 * Every structural self-reference in `line` as a span, in text order, with
 * no two overlapping: at one position the longest match wins, and a match
 * that starts inside an earlier one is dropped.
 *
 * @param {string} line
 * @returns {{index: number, phrase: string, rule: string, why: string}[]}
 */
function structureSpans(line) {
  const found = [];
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
      if (TEMPO_ANCHOR.test(after)) continue;
      found.push({ index: m.index, phrase, rule: rule.id, why: rule.why });
    }
  }
  found.sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length);
  const spans = [];
  let end = 0;
  for (const span of found) {
    if (span.index < end) continue;
    spans.push(span);
    end = span.index + span.phrase.length;
  }
  return spans;
}

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
  for (const { phrase, rule, why } of structureSpans(line)) {
    const key = `${rule}::${phrase.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, rule, why });
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

/* ------------------------------------------------ the rewrite, in code */

const ONE = /^(?:one|1|first)$/i;
const NEXT = /\b(?:next|following|coming)\b/i;
const BEFORE = /\b(?:last|previous|preceding|past)\b/i;
const OPENING = /\b(?:first|opening)\b/i;
const CLOSING = /\b(?:final|closing)\b/i;
const LATER_ORDINAL = /^the\s+(?:second|third|fourth|fifth|sixth|seventh)\b/i;
const COUNT_LAST = new RegExp(`\\b(?:${NUMBER_WORD})\\s+(?:${STRUCTURE_PLURAL})$`, "i");
const NUMBERED = /^(?:act|beat|segment|slot|chapter|section|part)\s+(\S+)/i;
const DETERMINER = /^(this|that|these|those|our|each|every)\b/i;

/* ------------------------------------------------ what the rewrite may touch */

/* The detector above is deliberately wide and says where it is wrong; a
   wrong REFUSAL costs a retry, but a wrong REWRITE ships garbled speech with
   nothing downstream to catch it, because the rewritten line no longer
   matches anything (review of PR #785: "the loads that act on the span"
   became "the loads that story on the span", "filed for Chapter Eleven"
   became "filed for what follows", "an opening act" became "an the
   opening"). So the rewrite touches only the shapes that cannot be ordinary
   English, and leaves every other span exactly as written, for the gate
   (writeAct's retry, check-forays at publish) to refuse. */

/** The pieces a numbered reference may be rewritten for. Not `chapter` or
 * `section`: "Chapter Eleven", "section four" are bankruptcy and statute. */
const NUMBERED_PIECE = /^(?:act|beat|segment|slot|part)$/i;
/** A number a piece of THIS Foray could carry: a word, or one or two digits. */
const PIECE_NUMBER = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})$/i;
/** "in act two", "back in part one", "the end of act three": a preposition
 * before the numbered piece makes it a noun. After anything else it can be a
 * verb — "they act one way in public", "to beat one rival". */
const PREPOSITION_BEFORE = /\b(?:in|into|from|since|after|before|during|through|throughout|until|by|at|of)\s+$/i;
/** The span is followed by the end of a clause, so the word in it cannot be
 * a verb taking an object or an "as" ("that act on the span", "these act as
 * a brake", "the team that beat Brazil"). */
const CLAUSE_ENDS_AFTER = /^\s*(?:[.,;:!?)\]"'”’—–]|-{2}|$)/;
/** The programme nouns a rewrite may call "this story". Not "show", "piece",
 * "hour", "recording", "program": "this show ran ten seasons", "at this
 * hour", "this program crashed" are about something else. */
const PROGRAMME_REWRITABLE = /^(?:foray|forays|documentary|episode)$/i;
/** "The closing act was Queen", "the opening act for the Monkees": the music
 * bill's sense, which "the end" and "the opening" would change. */
const BILL_POINTER = /^(?:opening|closing)$/i;

/**
 * Whether `span` may be rewritten: true only for a shape that cannot be
 * ordinary English in its place. `before` and `after` are the text either
 * side of it.
 *
 * @param {{phrase: string, rule: string}} span
 * @param {string} before
 * @param {string} after
 * @returns {boolean}
 */
function rewritable({ phrase, rule }, before, after) {
  const words = phrase.trim().split(/\s+/);
  /* A capital mid-sentence is a name: "That Act", "Section Four", "Act One
     of the Securities". Only the first word may carry one, at a sentence
     start — and "Foray", which is how the product is written. */
  const sentenceStart = atSentenceStart(before);
  for (let i = 0; i < words.length; i++) {
    if (!/^[A-Z]/.test(words[i])) continue;
    if (i === 0 && sentenceStart) continue;
    if (rule === "names-the-programme" && /^foray/i.test(words[i])) continue;
    return false;
  }
  const lower = words.map((w) => w.toLowerCase());
  if (rule === "relative-piece" || rule === "pointer-count") return true;
  if (rule === "names-the-programme") return PROGRAMME_REWRITABLE.test(lower[lower.length - 1]);
  /* "Hamlet has five acts", "three parts hydrogen", "two beats to spare". */
  if (rule === "counted-pieces") return false;
  if (rule === "numbered-piece" || (rule === "pipeline-word" && lower[0] === "act" && words.length === 2)) {
    return NUMBERED_PIECE.test(lower[0]) && PIECE_NUMBER.test(lower[1]) && (sentenceStart || PREPOSITION_BEFORE.test(before));
  }
  if (rule === "pipeline-word") {
    /* "running order" after a determiner is ours; "in good running order"
       is a machine's. Every other pipeline-word span — a count ("eight
       beats"), a bare pointer ("every act on the bill", "an opening act") —
       has a plain-English reading, and no article of its own to replace. */
    return /running order$/i.test(phrase) && /\b(?:the|this|our|that)\s+$/i.test(before);
  }
  if (rule === "self-determiner") {
    const [determiner, ...rest] = lower;
    const noun = rest[rest.length - 1];
    const hasOrdinal = rest.length >= 2;
    if (determiner === "the") return !(BILL_POINTER.test(rest[0]) && /^acts?$/.test(noun));
    /* "our act" is "get our act together"; "our next act" is ours. */
    if (determiner === "our") return hasOrdinal;
    /* An ordinal in between makes it a noun: "that final act". */
    if (hasOrdinal) return true;
    const plural = /s$/.test(noun);
    /* "this act", "this part": a verb after "this" would take an -s. But
       "This beat the forecast" is a past tense, and "this acts as a brake"
       is a verb. */
    if (determiner === "this") return (!plural && noun !== "beat") || CLAUSE_ENDS_AFTER.test(after);
    /* "these acts" is a noun; "these act as a brake" is not. */
    if ((determiner === "these" || determiner === "those") && plural) return true;
    /* "that act", "these act", "that beat": a relative clause or a plural
       subject, unless the clause ends right after it. */
    return CLAUSE_ENDS_AFTER.test(after);
  }
  return false;
}

/**
 * What a span becomes when it is said the way a narrator would say it: not
 * the listener's unit word (a "part" is still a piece of the Foray, and the
 * audit's own verdict on persona 65 was that swapping one undefined unit for
 * another fixes nothing), but WHEN or WHAT — "earlier", "what comes next",
 * "what came before", "this story".
 *
 * @param {{phrase: string, rule: string}} span
 * @returns {string} lower-case; the caller capitalises it at a sentence start
 */
function narrationReplacement({ phrase, rule }) {
  const p = phrase.trim();
  if (/running order/i.test(p)) return "story";
  if (/\b(?:later|ahead|from now)$/i.test(p)) return "later";
  if (/\b(?:back|ago|earlier)$/i.test(p)) return "earlier";
  if (rule === "names-the-programme") return "this story";
  const numbered = NUMBERED.exec(p);
  if (numbered) return ONE.test(numbered[1]) ? "the story" : "what follows";
  const counted = rule === "pointer-count" || COUNT_LAST.test(p);
  if (NEXT.test(p)) return counted ? "what follows" : "what comes next";
  if (BEFORE.test(p)) return "what came before";
  if (OPENING.test(p)) return "the opening";
  if (CLOSING.test(p)) return "the end";
  if (LATER_ORDINAL.test(p)) return "what follows";
  const determiner = DETERMINER.exec(p);
  if (determiner) return `${determiner[1].toLowerCase()} ${/s$/i.test(p) ? "stories" : "story"}`;
  return "the story";
}

/** True when `before` ends a sentence (or is empty), so what comes after it
 * starts one. A dash or a colon does not: "the reckless engineer — the last
 * act showed you" goes on in lower case. */
function atSentenceStart(before) {
  return before.trim().length === 0 || /(?:[.!?]["'”’)]?|\n)\s*$/.test(before);
}

/**
 * `text` with every structural self-reference that `rewritable` allows
 * rewritten out of it, touching nothing else: "Two acts back, the ladder
 * cracked" -> "Earlier, the ladder cracked"; "The next act follows the money"
 * -> "What comes next follows the money"; "By the end of this act" -> "By the
 * end of this story"; "Act one opens with" -> "The story opens with". The
 * narration twin of rules.js `toListenerWords`, and like it a fixed point.
 * Unlike it, NOT total: a span that can be ordinary English ("the loads that
 * act on the span", "Chapter Eleven", "Hamlet has five acts") is left exactly
 * as written, so the gate refuses it rather than a listener hearing it
 * garbled. Every structural line the committed generated Forays carry is
 * rewritable and comes out with no `narratorStructureLeaks`
 * (narratorStructure.test.ts pins both). `changed` says whether anything was
 * rewritten, so a caller can report that the model ignored the instruction.
 *
 * It is the LAST resort, not the first: every stage that writes narration is
 * told the rule and refuses a violation so the model rewrites it with
 * content; this runs where no retry is left — the final attempt of §4.4, the
 * one call §4.8 makes, and every narration item on its way out of the
 * pipeline (`forayItems.ts`).
 *
 * @param {string} text
 * @returns {{text: string, changed: boolean}}
 */
function toNarrationWords(text) {
  const input = String(text ?? "");
  let out = input;
  /* No replacement contains a structural noun, so one pass suffices; the
     bound is a guard, not something the rule relies on. */
  for (let pass = 0; pass < 3; pass++) {
    const spans = structureSpans(out);
    if (spans.length === 0) break;
    let built = "";
    let pos = 0;
    for (const span of spans) {
      const end = span.index + span.phrase.length;
      if (!rewritable(span, out.slice(0, span.index), out.slice(end))) continue;
      built += out.slice(pos, span.index);
      let replacement = narrationReplacement(span);
      if (atSentenceStart(built)) replacement = replacement.charAt(0).toUpperCase() + replacement.slice(1);
      built += replacement;
      pos = end;
    }
    out = built + out.slice(pos);
  }
  return { text: out, changed: out !== input };
}

/* ------------------------------------------------ the instruction */

/**
 * The examples every writing prompt quotes, in two kinds, and the test that
 * keeps them honest (narratorStructure.test.ts): every refused example must
 * be caught by `narratorStructureLeaks` and every fine one must pass it, so
 * the instruction can never promise the model something the machine
 * disagrees with.
 */
const NARRATOR_STRUCTURE_EXAMPLES = {
  refused: [
    "this act",
    "the next act",
    "the last beat",
    "in this segment",
    "this slot",
    "Act one",
    "part two of three",
    "four acts",
    "two acts back",
    "one act back",
    "the running order",
    "this documentary"
  ],
  fine: ["the first act of Macbeth", "the second act of the crisis", "his first act as chairman", "ninety beats per minute", "the three-act structure"]
};

const quoteAll = (list) => list.map((s) => `"${s}"`).join(", ");

/**
 * The rule as every prompt that writes spoken narration states it: the act
 * writer's (`AnthropicNarrationWriterBuilder`), the act deepener's — which
 * writes the act introductions and exits, where every committed violation
 * was — and the continuity editor's. One definition, so the three cannot
 * drift.
 */
const NARRATOR_STRUCTURE_RULE =
  "NEVER SAY THE PIPELINE'S WORDS FOR THIS FORAY'S OWN PIECES (Q-08). Act, beat, segment, slot, spine and running order " +
  "are our production words; the listener hears one continuous story and cannot see how it is built. Never point at a " +
  "piece, number one, count them or count back through them — no " +
  `${quoteAll(NARRATOR_STRUCTURE_EXAMPLES.refused)} — and do not swap in "part", "section" or "chapter" to do the same ` +
  'job. Say WHAT happened or WHEN — "when the ladder cracked", "earlier", "back at the drawing board" — not where the ' +
  `listener is. The same words are FINE when they belong to something else: ${quoteAll(NARRATOR_STRUCTURE_EXAMPLES.fine)}. ` +
  "A machine checks this after you answer and sends the text back; at the end it rewrites what can only mean this " +
  "Foray and refuses the rest.";

module.exports = {
  narratorStructureLeaks,
  narratorStructureErrors,
  toNarrationWords,
  NARRATOR_STRUCTURE_RULE,
  NARRATOR_STRUCTURE_EXAMPLES,
  STRUCTURE_NOUN,
  PROGRAMME_NOUN
};
