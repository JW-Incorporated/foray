import type { SafetyVerdict } from "../types/generation";

/**
 * §4.1's safety check — the FIRST thing that happens to a prompt, before any
 * spend on understanding it. The doc is explicit this belongs in "a
 * committed, unit-tested module, not in a system prompt where it cannot be
 * reviewed or unit-tested" — so this is a pure, synchronous, dependency-free
 * function: no LLM call, no network, no retry surface. A rejection is final;
 * there is nothing here that loops.
 *
 * THREE FORBIDDEN CATEGORIES (verbatim from generation-architecture.md §4.1):
 *   - sexual content involving minors
 *   - instructions for mass-casualty weapons
 *   - targeted harassment of a named private individual
 *
 * DESIGN: the rules key on INTENT, not on topic words (founder ruling Q4,
 * docs/DECISIONS.md 2026-09-25, round-3 audit gen-9). A Foray ABOUT abuse, sex
 * education, a bombing or surviving a nuclear blast is reporting, history,
 * education or survival, and must pass: "How the Catholic Church covered up
 * the sexual abuse of children", "How sex education for kids changed in the
 * 1970s", "How to survive a nuclear bomb". The earlier rules refused all
 * three, because any "sexual" next to any "children", or any "how to" next to
 * any "bomb", was enough. What stays refused WHATEVER THE FRAMING:
 *
 *   - sexual content involving minors. A sexual word left over once the
 *     reporting phrases ("sexual abuse", "sex education", "sex trafficking",
 *     ...) are set aside, anywhere in a prompt that names a minor, is refused;
 *     so is a request to DEPICT (graphic, vivid, a story, a role-play) abuse
 *     of a minor, even in reporting words. Reporting phrases are an allowance
 *     for talking about harm, never for rendering it.
 *   - operational instructions for serious harm: a making/acquiring verb
 *     aimed at a mass-casualty weapon ("build a bomb", "synthesize sarin",
 *     "weaponize anthrax"), a recipe or instructions for one, or a request for
 *     help carrying out an attack. Surviving, defusing, sheltering from,
 *     detecting, investigating or remembering one is not operational.
 *
 * A false positive still costs a confusing rejection with no recourse, and a
 * false negative in the minors category is serious, so where the two pull
 * apart the minors rule leans to refusing (its sexual-word list stays broad;
 * only the named reporting phrases are set aside) and the weapons rule leans
 * to allowing anything that is not a request to make or use one. This is a
 * phase-1, founder-only tool (§1.3): the founder reviews every Foray before
 * publish (§4.9). Strengthening these lists is expected to be ongoing work,
 * in code review, with a test for every case — see
 * backend/test/safetyCheck.test.ts.
 */

interface Rule {
  category: SafetyVerdict["category"];
  /** True when the prompt falls in this forbidden category. */
  matches(prompt: string): boolean;
  explanation: string;
}

/* ---------------- sexual content involving minors ---------------- */

const MINOR =
  /\b(child|children|kid|kids|minor|minors|toddler|toddlers|underage|underaged|preteen|preteens|pre-teen|pre-teens|teen|teens|teenager|teenagers|schoolgirl|schoolgirls|schoolboy|schoolboys|prepubescent)\b/i;

/** Reporting, history, health and education phrases that NAME sexual harm or
    sex education without asking for sexual content. Set aside before the
    sexual-word check, so they cannot by themselves refuse a prompt. */
const SEXUAL_REPORTING_PHRASE =
  /\b(?:sex|sexual|sexually)[\s-]+(?:abuse|abused|abuses|abuser|abusers|abusing|assault|assaults|assaulted|exploitation|exploited|exploiting|violence|harassment|harassed|misconduct|predator|predators|offence|offences|offense|offenses|offender|offenders|crime|crimes|trafficking|trafficked|traffickers?|education|ed|health|orientation|scandal|scandals)\b/gi;
const EXPLICIT_LABEL_PHRASE = /\bexplicit[\s-]+(?:lyrics|language|content[\s-]+(?:labels?|warnings?|ratings?))\b/gi;

const SEXUAL_WORD =
  /\b(sex|sexual|sexually|sexy|sexualiz\w*|sexualis\w*|nude|nudes|naked|porn\w*|erotic\w*|explicit|lewd|smut\w*)\b/i;

/** A request to render the harm rather than report it. */
const DEPICTION =
  /\b(graphic|graphically|vivid|vividly|lurid|luridly|titillat\w*|in (?:explicit|graphic|vivid|lurid) detail|role-?play\w*|fantasy|fantasies|fantasi[sz]e\w*|fan-?fic\w*|fiction|fictional|short story|write (?:a|an|me a|me an) (?:story|scene|poem|script)|a scene)\b/i;

function sexualContentInvolvingMinors(prompt: string): boolean {
  if (!MINOR.test(prompt)) return false;
  const rest = prompt.replace(SEXUAL_REPORTING_PHRASE, " ").replace(EXPLICIT_LABEL_PHRASE, " ");
  if (SEXUAL_WORD.test(rest)) return true;
  const reportsSexualHarm = rest !== prompt;
  return reportsSexualHarm && DEPICTION.test(prompt);
}

/* ---------------- operational instructions for serious harm ---------------- */

const WEAPON =
  "(?:bombs?|explosives?|explosive devices?|improvised explosive devices?|ieds?|nerve agents?|nerve gas|bioweapons?|biological weapons?|chemical weapons?|nuclear (?:devices?|bombs?|weapons?)|atomic bombs?|dirty bombs?|sarin|vx(?: gas)?|anthrax|ricin|mustard gas|napalm)";
/** Words that turn a weapon into something you survive, defuse, detect or
    remember: "a bomb shelter", "bomb disposal", "a nuclear bomb drill". */
const NOT_THE_WEAPON =
  "(?![\\s-]+(?:shelters?|survivors?|victims?|drills?|disposal|squads?|detectors?|detection|sniffing|dogs?|threats?|scares?|tests?|testing|craters?|sirens?|shelter))";
const MAKING_VERB =
  "(?:build|make|construct|assemble|synthesi[sz]e|produce|manufacture|cook|brew|weaponi[sz]e|detonate|rig|arm|culture|extract|refine|enrich|acquire|smuggle)";

/** "build a bomb", "how do I make a pipe bomb", "synthesize a nerve agent":
    a making verb with the weapon at most five words after it. */
const MAKE_A_WEAPON = new RegExp(`\\b${MAKING_VERB}\\b(?:\\W+[\\w'-]+){0,5}?\\W+${WEAPON}\\b${NOT_THE_WEAPON}`, "i");
/** "instructions for a pipe bomb", "a recipe for sarin", "bomb-making
    instructions", "anthrax recipe". */
const WEAPON_RECIPE = new RegExp(
  `\\b(?:instructions?|recipes?|tutorials?|blueprints?|schematics?|step[\\s-]+by[\\s-]+step(?:[\\s-]+guide)?|a how-to)\\s+(?:for|on|to)\\s+(?:(?:a|an|the|making|building|homemade|home-made|my own|your own)\\s+){0,2}${WEAPON}\\b${NOT_THE_WEAPON}` +
    `|\\b${WEAPON}(?:[\\s-]+(?:making|building))?[\\s-]+(?:recipes?|instructions?|tutorials?|manuals?|blueprints?|schematics?)\\b`,
  "i"
);

const ATTACK_REQUEST =
  /\b(?:how (?:to|do i|can i|would i|could i|should i|do you)|steps? to|instructions? (?:for|on|to)|best way to|teach me(?: how)? to|help me|i want to|i'm going to|i am going to)\b(?:\W+[\w'-]+){0,3}?\W+(?:carry out|commit|plan|stage|execute|pull off|launch|perpetrate|get away with)\b(?:\W+[\w'-]+){0,3}?\W+(?:mass shootings?|school shootings?|shooting spree|massacres?|terror attacks?|terrorist attacks?|bombings?|vehicle(?:[\s-]+ramming)? attacks?|poisoning attacks?)\b/i;
const MAXIMISE_CASUALTIES =
  /\b(?:how (?:to|do i|can i|would i|could i)|best way to|help me)\b(?:\W+[\w'-]+){0,3}?\W+(?:maximi[sz]e|increase|cause more)\W+(?:the\W+)?(?:casualties|death toll|body count|deaths)\b/i;

/* ---------------- targeted harassment ---------------- */

const HARASS_SUBJECT =
  /\bmy (ex|neighbor|neighbour|coworker|co-worker|boss|classmate|roommate|room-mate|landlord|manager|teacher|professor)\b/i;
const HARASS_INTENT = /\b(dox|doxx|expose|humiliate|harass|stalk|ruin|blackmail|out them|get back at)\b/i;

const RULES: Rule[] = [
  {
    category: "sexual-content-minors",
    matches: sexualContentInvolvingMinors,
    explanation:
      "This prompt combines sexual content with a minor. 4a will not generate that, and there's no rephrasing that changes the answer — try a different topic."
  },
  {
    category: "mass-casualty-weapons",
    matches: (p) => MAKE_A_WEAPON.test(p) || WEAPON_RECIPE.test(p),
    explanation:
      "This prompt asks for build/how-to instructions for a mass-casualty weapon. 4a won't generate that. A Foray about the history, policy, or science of the topic is a different request — ask for that instead."
  },
  {
    /* Operational help with an attack sits with the weapons category: the
       same harm (mass casualties), and the same answer (the history, the
       investigation or the aftermath is a different, allowed request). */
    category: "mass-casualty-weapons",
    matches: (p) => ATTACK_REQUEST.test(p) || MAXIMISE_CASUALTIES.test(p),
    explanation:
      "This prompt asks for help carrying out an attack. 4a won't generate that. A Foray about the history, the investigation, or the aftermath of an attack is a different request — ask for that instead."
  },
  {
    category: "targeted-harassment",
    matches: (p) => HARASS_SUBJECT.test(p) && HARASS_INTENT.test(p),
    explanation:
      "This prompt targets a named private individual for harassment. 4a won't generate that."
  }
];

/**
 * Checks a raw prompt against the forbidden-topics list. Pure and
 * synchronous — the same input always produces the same verdict, and
 * nothing here writes to any store (see `understandPrompt.ts` for the
 * no-persistence guarantee at the pipeline level).
 */
export function checkSafety(prompt: string): SafetyVerdict {
  for (const rule of RULES) {
    if (rule.matches(prompt)) {
      return { allowed: false, category: rule.category, explanation: rule.explanation };
    }
  }
  return { allowed: true, category: null, explanation: null };
}
