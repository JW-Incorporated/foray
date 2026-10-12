import { canonicalizeForAnchorMatch } from "../types/anchorText";
import { splitSpokenSentences } from "../copy/spokenLine";

/**
 * GV-34 (docs/roadmap/generation-v2.md, W5-10; covers R2-09, R1-07): the
 * numbers, dates and names a narration sentence states, checked IN CODE
 * against the texts the sentence may rest on.
 *
 * Jev, and any small local model, is weak on counting, arithmetic and dates
 * (LM-23). A year the verifier waves through because the sentence "sounds
 * like" its source is exactly the fabrication a listener cannot catch. So
 * this module asks the one question code can answer exactly: does every
 * year, figure and proper noun the sentence says appear somewhere in its
 * sources? Nothing here judges whether the sentence USES the figure
 * correctly — only whether the figure exists to be used.
 *
 * Pure: no I/O, no model, no env. Three entry points:
 *
 *   `spokenNumberValues(text)` — every number a text states, read from
 *     digits ("1,964", "40%", "1980s", "1964–68") AND from words ("nineteen
 *     sixty-four", "two thousand and eight", "forty percent", "three point
 *     five million", "a dozen"), because a transcript says the word and a
 *     script may write the digit, or the other way round.
 *   `extractSpecifics(sentence, opts)` — the sentence's checkable specifics:
 *     numbers, years (decades included) and names. Small bare cardinals
 *     ("two men") and ordinals ("the first") are exempt by default.
 *   `unsupportedSpecifics(sentence, sources, opts)` — the specifics no
 *     source carries, as the sentence wrote them.
 *
 * KNOWN LIMITS, accepted on purpose (the card's Risk line): a paraphrased
 * figure ("roughly half" for "48%") is a false negative; a capitalised
 * common word mid-sentence ("Internet") or an ASR misspelling of a name is
 * a false positive. FORAY_SPECIFICS_CHECK defaults to `report` so the false
 * positives are counted on real runs before anything is refused on them.
 */

/** FORAY_SPECIFICS_CHECK: `off` computes nothing, `report` (the default)
 * computes the metric only, `enforce` also refuses a seam in writeAct. */
export const SPECIFICS_MODES = ["off", "report", "enforce"] as const;
export type SpecificsMode = (typeof SPECIFICS_MODES)[number];

/** One number a text states. */
export interface SpokenNumber {
  /** The text as written ("nineteen sixty-four", "40%"). */
  text: string;
  /** The value: 1964, 40 (for 40%), 3_500_000, 1980 (for the 1980s). */
  value: number;
  /** "percent", "per cent" or "%" followed it. */
  percent: boolean;
  /** A decade ("the 1980s", "the nineteen-eighties"): `value` is its first year. */
  decade: boolean;
  /** An ordinal ("first", "21st", "twenty-first"). */
  ordinal: boolean;
  /** A unit or a currency sign goes with it ("three years", "$4", "5 km"). */
  unit: boolean;
  /** Written with digits. */
  digits: boolean;
  /** Written with a thousands separator ("1,964") — a count, not a year. */
  grouped: boolean;
}

/** One checkable specific of a sentence. */
export interface Specific {
  text: string;
  value: number;
  decade: boolean;
}

export interface ExtractedSpecifics {
  numbers: Specific[];
  years: Specific[];
  names: string[];
}

export interface SpecificsOptions {
  /** Names the check never asks about — the act's clip shows and episode
   * titles in writeAct, the page's evidence titles in the metric. A name
   * found inside one of these (word for word, canonicalised) is dropped. */
  allowNames?: ReadonlyArray<string>;
  /** A bare integer cardinal up to this, with no unit, is exempt ("two
   * men", "one veteran"). Default 10. */
  smallCardinalMax?: number;
  /** Ordinals ("the first", "the 21st century") are exempt. Default true. */
  exemptOrdinals?: boolean;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

interface Token {
  /** Lowercased for words; the digits (separators kept) for numbers. */
  t: string;
  kind: "word" | "num" | "dash" | "sym" | "punct";
  start: number;
  end: number;
  /** A digit token's suffix: "%", "s" (decade), or an ordinal suffix. */
  suffix?: string;
}

/* Digits (with separators and a decimal part) and an optional suffix; words
   (an apostrophe inside kept, so "o'clock" stays one token); dashes; the
   currency signs and the percent sign; any other punctuation, which breaks a
   number group. */
const TOKEN_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%|s(?![\p{L}])|st(?![\p{L}])|nd(?![\p{L}])|rd(?![\p{L}])|th(?![\p{L}]))?|(\p{L}+(?:['’]\p{L}+)*)|([-–—])|([$£€%])|([^\s\p{L}\p{N}])/gu;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] !== undefined) out.push({ t: m[1], kind: "num", start, end, ...(m[2] ? { suffix: m[2].toLowerCase() } : {}) });
    else if (m[3] !== undefined) out.push({ t: m[3].toLowerCase(), kind: "word", start, end });
    else if (m[4] !== undefined) out.push({ t: m[4], kind: "dash", start, end });
    else if (m[5] !== undefined) out.push({ t: m[5], kind: "sym", start, end });
    else out.push({ t: m[6]!, kind: "punct", start, end });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Number words                                                         */
/* ------------------------------------------------------------------ */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/* "the nineteen-eighties": a plural tens word is a decade only after a century. */
const TENS_PLURAL: Record<string, number> = { twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, nineties: 90 };
const UNIT_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19
};
const TENS_ORDINALS: Record<string, number> = {
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const SCALE_ORDINALS: Record<string, number> = { hundredth: 100, thousandth: 1e3, millionth: 1e6 };
const DIGIT_WORDS: Record<string, number> = { ...Object.fromEntries(Object.entries(UNITS).filter(([, v]) => v < 10)), oh: 0 };

/** Every word the number reader consumes — never a name, even capitalised. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(UNITS),
  ...Object.keys(TENS),
  ...Object.keys(TENS_PLURAL),
  ...Object.keys(UNIT_ORDINALS),
  ...Object.keys(TENS_ORDINALS),
  ...Object.keys(SCALES),
  ...Object.keys(SCALE_ORDINALS),
  "dozen"
]);

/* What makes a small number a measured quantity rather than a bare count. */
const UNIT_WORDS = new Set([
  "percent", "cent", "percentage", "points",
  "dollar", "dollars", "cent", "cents", "pound", "pounds", "euro", "euros", "yen", "bucks",
  "second", "seconds", "minute", "minutes", "hour", "hours", "day", "days", "week", "weeks",
  "month", "months", "year", "years", "decade", "decades", "century", "centuries",
  "mile", "miles", "kilometre", "kilometres", "kilometer", "kilometers", "km", "metre", "metres",
  "meter", "meters", "foot", "feet", "inch", "inches", "yard", "yards", "acre", "acres",
  "gram", "grams", "kilogram", "kilograms", "kg", "kilo", "kilos", "ton", "tons", "tonne", "tonnes",
  "ounce", "ounces", "lb", "lbs", "litre", "litres", "liter", "liters", "gallon", "gallons",
  "degree", "degrees", "mph", "times", "percentile"
]);

/** A run of 0..99 at `i`: a tens word with an optional unit, a unit or teen,
 * or the ordinal or decade form of either. */
function readSmall(tokens: Token[], i: number): { value: number; end: number; ordinal: boolean; decadePlural: boolean } | null {
  const tok = tokens[i];
  if (!tok || tok.kind !== "word") return null;
  const w = tok.t;
  if (w in TENS) {
    let j = i + 1;
    if (tokens[j]?.kind === "dash" && tokens[j]!.t === "-") j++;
    const next = tokens[j];
    if (next?.kind === "word") {
      const u = UNITS[next.t];
      if (u !== undefined && u >= 1 && u <= 9) return { value: TENS[w]! + u, end: j + 1, ordinal: false, decadePlural: false };
      const uo = UNIT_ORDINALS[next.t];
      if (uo !== undefined && uo <= 9) return { value: TENS[w]! + uo, end: j + 1, ordinal: true, decadePlural: false };
    }
    return { value: TENS[w]!, end: i + 1, ordinal: false, decadePlural: false };
  }
  if (w in UNITS) return { value: UNITS[w]!, end: i + 1, ordinal: false, decadePlural: false };
  if (w in UNIT_ORDINALS) return { value: UNIT_ORDINALS[w]!, end: i + 1, ordinal: true, decadePlural: false };
  if (w in TENS_ORDINALS) return { value: TENS_ORDINALS[w]!, end: i + 1, ordinal: true, decadePlural: false };
  if (w in TENS_PLURAL) return { value: TENS_PLURAL[w]!, end: i + 1, ordinal: false, decadePlural: true };
  return null;
}

/** Skip one hyphen between two number words ("sixty-four", "nineteen-eighties"). */
function skipHyphen(tokens: Token[], j: number): number {
  return tokens[j]?.kind === "dash" && tokens[j]!.t === "-" && tokens[j + 1]?.kind === "word" ? j + 1 : j;
}

interface ReadNumber {
  value: number;
  end: number;
  ordinal: boolean;
  decade: boolean;
}

/** A spoken number starting at `i`, or null. */
function readWordNumber(tokens: Token[], i: number): ReadNumber | null {
  /* "a dozen", "a hundred", "a million": the article is the one. */
  let first: { value: number; end: number; ordinal: boolean; decadePlural: boolean } | null;
  const tok = tokens[i];
  if (tok?.kind === "word" && (tok.t === "a" || tok.t === "an") && tokens[i + 1]?.kind === "word" && (tokens[i + 1]!.t in SCALES || tokens[i + 1]!.t === "dozen")) {
    first = { value: 1, end: i + 1, ordinal: false, decadePlural: false };
  } else {
    first = readSmall(tokens, i);
  }
  if (!first) return null;
  /* A bare plural tens word ("the eighties") names no century: not a specific. */
  if (first.decadePlural) return null;

  /* THE YEAR FORM: two pairs of digits spoken as two numbers ("nineteen
     sixty-four", "twenty eighteen", "nineteen oh five", "the
     nineteen-eighties"). The first pair is 10..99 and the second is 10..99,
     or "oh" and a digit, and no scale word follows the second. */
  if (!first.ordinal && first.value >= 10 && first.value <= 99) {
    const j = skipHyphen(tokens, first.end);
    const nextTok = tokens[j];
    if (nextTok?.kind === "word" && nextTok.t === "oh") {
      const d = tokens[j + 1]?.kind === "word" ? UNITS[tokens[j + 1]!.t] : undefined;
      if (d !== undefined && d >= 1 && d <= 9) return { value: first.value * 100 + d, end: j + 2, ordinal: false, decade: false };
    }
    const second = readSmall(tokens, j);
    if (second && second.value >= 10 && !(tokens[second.end]?.kind === "word" && tokens[second.end]!.t in SCALES)) {
      return { value: first.value * 100 + second.value, end: second.end, ordinal: second.ordinal, decade: second.decadePlural };
    }
  }
  if (first.ordinal) return { value: first.value, end: first.end, ordinal: true, decade: false };

  /* THE CARDINAL FORM, with scales: "two thousand and eight", "three hundred
     and twenty", "three point five million", "two dozen". */
  let total = 0;
  let current = first.value;
  let j = first.end;
  let ordinal = false;
  for (;;) {
    const w = tokens[j]?.kind === "word" ? tokens[j]!.t : undefined;
    if (w === undefined) break;
    if (w === "point" && tokens[j + 1]?.kind === "word" && tokens[j + 1]!.t in DIGIT_WORDS) {
      let k = j + 1;
      let frac = "";
      while (tokens[k]?.kind === "word" && tokens[k]!.t in DIGIT_WORDS) {
        frac += String(DIGIT_WORDS[tokens[k]!.t]);
        k++;
      }
      current += Number(`0.${frac}`);
      j = k;
      continue;
    }
    if (w === "dozen") {
      current *= 12;
      j++;
      continue;
    }
    if (w === "hundred" || w === "hundredth") {
      current *= 100;
      j++;
      if (w === "hundredth") {
        ordinal = true;
        break;
      }
    } else if (w in SCALES || w in SCALE_ORDINALS) {
      total += current * (SCALES[w] ?? SCALE_ORDINALS[w]!);
      current = 0;
      j++;
      if (w in SCALE_ORDINALS) {
        ordinal = true;
        break;
      }
    } else {
      break;
    }
    /* After a scale: "and" then a small number, or a small number directly. */
    let k = j;
    if (tokens[k]?.kind === "word" && tokens[k]!.t === "and" && readSmall(tokens, k + 1)) k++;
    const more = readSmall(tokens, k);
    if (more && !more.decadePlural) {
      current += more.value;
      j = more.end;
      if (more.ordinal) {
        ordinal = true;
        break;
      }
    }
  }
  return { value: total + current, end: j, ordinal, decade: false };
}

/* ------------------------------------------------------------------ */
/* spokenNumberValues                                                   */
/* ------------------------------------------------------------------ */

function parseDigits(raw: string): { value: number; grouped: boolean } | null {
  /* "1,964" is grouped; "1,9" is not a number we read. */
  const grouped = raw.includes(",");
  if (grouped && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? { value, grouped } : null;
}

/** What follows a number at `j`: percent, a scale, a unit. */
function readAfter(tokens: Token[], j: number): { end: number; percent: boolean; scale: number; unit: boolean } {
  let end = j;
  let scale = 1;
  let percent = false;
  let unit = false;
  const w = (k: number): string | undefined => (tokens[k]?.kind === "word" ? tokens[k]!.t : undefined);
  if (w(end) !== undefined && w(end)! in SCALES) {
    scale = SCALES[w(end)!]!;
    end++;
  } else if (w(end) === "dozen") {
    scale = 12;
    end++;
  }
  if (tokens[end]?.kind === "sym" && tokens[end]!.t === "%") {
    percent = true;
    end++;
  } else if (w(end) === "percent") {
    percent = true;
    end++;
  } else if (w(end) === "per" && w(end + 1) === "cent") {
    percent = true;
    end += 2;
  }
  if (!percent && w(end) !== undefined && UNIT_WORDS.has(w(end)!)) unit = true;
  return { end, percent, scale, unit };
}

/**
 * Every number `text` states, in order, from digits and from words. A
 * two-ended digit range written with a dash keeps both ends, and an
 * abbreviated second year takes the first one's century ("1964–68" gives
 * 1964 and 1968).
 */
export function spokenNumberValues(text: string): SpokenNumber[] {
  const tokens = tokenize(String(text ?? ""));
  const out: SpokenNumber[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const currency = i > 0 && tokens[i - 1]!.kind === "sym" && tokens[i - 1]!.t !== "%";
    if (tok.kind === "num") {
      const parsed = parseDigits(tok.t);
      if (!parsed) {
        i++;
        continue;
      }
      const suffix = tok.suffix;
      const ordinal = suffix === "st" || suffix === "nd" || suffix === "rd" || suffix === "th";
      const decade = suffix === "s" && /^\d{3}0$/.test(tok.t);
      let value = parsed.value;
      let end = i + 1;
      let percent = suffix === "%";
      let unit = currency;
      if (!ordinal && !decade && !percent) {
        const after = readAfter(tokens, end);
        value *= after.scale;
        end = after.end;
        percent = after.percent;
        unit = unit || after.unit;
      }
      out.push({
        text: text.slice(tok.start, tokens[end - 1]!.end),
        value,
        percent,
        decade,
        ordinal,
        unit,
        digits: true,
        grouped: parsed.grouped
      });
      /* "1964–68" / "1964-1968": the range's second end. */
      const dash = tokens[end];
      const second = tokens[end + 1];
      if (!ordinal && !percent && dash?.kind === "dash" && second?.kind === "num" && /^\d{4}$/.test(tok.t) && /^\d{2}$/.test(second.t)) {
        out.push({
          text: text.slice(second.start, second.end),
          value: Math.floor(parsed.value / 100) * 100 + Number(second.t),
          percent: false,
          decade: second.suffix === "s",
          ordinal: false,
          unit: false,
          digits: true,
          grouped: false
        });
        i = end + 2;
        continue;
      }
      i = end;
      continue;
    }
    if (tok.kind === "word") {
      const read = readWordNumber(tokens, i);
      if (read && read.end > i) {
        let end = read.end;
        let value = read.value;
        let percent = false;
        let unit = currency;
        if (!read.ordinal && !read.decade) {
          const after = readAfter(tokens, end);
          value *= after.scale;
          end = after.end;
          percent = after.percent;
          unit = unit || after.unit;
        }
        out.push({
          text: text.slice(tok.start, tokens[end - 1]!.end),
          value,
          percent,
          decade: read.decade,
          ordinal: read.ordinal,
          unit,
          digits: false,
          grouped: false
        });
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Names                                                                */
/* ------------------------------------------------------------------ */

/* Words that open sentences far more often than they name anything: a
   capitalised one at the start of a sentence (or of a quotation) is not a
   name. Mid-sentence they are names again ("the Who", "May"). */
const COMMON_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "so", "yet", "for", "if", "then", "than", "because", "though",
  "although", "while", "when", "whenever", "where", "wherever", "after", "before", "since", "until", "unless",
  "once", "as", "at", "by", "in", "into", "on", "onto", "of", "off", "to", "from", "with", "without", "within",
  "about", "above", "across", "against", "along", "among", "around", "behind", "below", "beneath", "beside",
  "between", "beyond", "despite", "during", "except", "inside", "instead", "like", "near", "outside", "over",
  "past", "per", "through", "throughout", "toward", "towards", "under", "underneath", "unlike", "up", "upon", "via",
  "it", "its", "it's", "this", "that", "these", "those", "there", "here", "what", "which", "who", "whom", "whose",
  "why", "how", "he", "she", "they", "we", "you", "his", "her", "hers", "their", "theirs", "our", "ours", "your",
  "yours", "my", "mine", "me", "him", "them", "us", "one", "some", "many", "most", "much", "more", "less", "few",
  "fewer", "every", "each", "all", "any", "both", "either", "neither", "no", "not", "none", "nothing", "nobody",
  "someone", "somebody", "something", "everyone", "everybody", "everything", "anyone", "anything", "other",
  "others", "another", "such", "same", "own", "only", "just", "even", "still", "also", "too", "very", "now",
  "today", "tonight", "tomorrow", "yesterday", "later", "soon", "already", "again", "always", "never", "often",
  "sometimes", "usually", "perhaps", "maybe", "may", "might", "must", "can", "could", "would", "should", "will",
  "shall", "do", "does", "did", "done", "is", "are", "was", "were", "be", "been", "being", "am", "has", "have",
  "had", "having", "let", "let's", "listen", "think", "look", "consider", "imagine", "remember", "take", "say",
  "yes", "well", "oh", "okay", "ok", "indeed", "meanwhile", "however", "therefore", "thus", "hence", "besides",
  "moreover", "furthermore", "nevertheless", "nonetheless", "otherwise", "instead", "still", "first", "next",
  "finally", "last", "lastly", "eventually", "ultimately", "suddenly", "together", "almost", "nearly", "roughly",
  "about", "around", "exactly", "only", "back", "out", "down", "where's", "that's", "there's", "here's", "what's",
  "who's", "he's", "she's", "they're", "we're", "you're", "isn't", "wasn't", "don't", "doesn't", "didn't",
  "can't", "won't", "it'll", "that'll", "years", "decades", "people", "nobody", "somewhere", "everywhere",
  "nowhere", "whatever", "whoever", "whichever", "within", "plus", "minus", "keep", "listen"
]);

/* Lowercase words that may sit inside a name between two capitalised words:
   "University of Chicago", "Ludwig van Beethoven", "Bank of the West". */
const CONNECTORS = new Set(["of", "the", "de", "da", "del", "della", "der", "den", "van", "von", "la", "le", "du", "bin", "al", "y"]);

/* A token's leading and trailing punctuation. A trailing comma, colon or
   full stop ends a name run; a leading quote or bracket starts a new one, at
   a fresh "initial" position. */
const LEAD_RE = /^[("“‘'[«]+/u;
const TRAIL_RE = /[)"”’'\],;:!?.…»]+$/u;

function stripPossessive(word: string): string {
  return word.replace(/['’]s$/u, "");
}

/* `stripPossessive` over a whole text: every word's trailing 's ("Couitt's
   tapes" gives "Couitt tapes"), so a source and an extracted name compare in
   the same form. */
function stripPossessives(text: string): string {
  return String(text ?? "").replace(/(\p{L})['’]s(?![\p{L}\p{N}])/gu, "$1");
}

/**
 * The proper nouns a sentence states: runs of capitalised words, connectors
 * allowed between them, possessives stripped. A sentence-initial (or
 * quote-initial) run loses its leading common words ("The Beatles" gives
 * "Beatles"; "But" gives nothing); the pronoun I and number words are never
 * names. Names found inside an `allowNames` entry are dropped. In order,
 * each once. Exported for W5-15 (GV-120).
 */
export function extractNames(sentence: string, opts: Pick<SpecificsOptions, "allowNames"> = {}): string[] {
  /* A dash is its own token, and ends a run ("Smith—Jones" is two names). */
  const raw = String(sentence ?? "")
    .replace(/[—–]/gu, " — ")
    .split(/\s+/)
    .filter(Boolean);
  const runs: Array<Array<{ word: string; initial: boolean }>> = [];
  let run: Array<{ word: string; initial: boolean }> = [];
  let pending: string[] = [];
  let initialNext = true;
  const close = (): void => {
    if (run.length > 0) runs.push(run);
    run = [];
    pending = [];
  };
  for (const token of raw) {
    const lead = LEAD_RE.exec(token)?.[0] ?? "";
    const trail = TRAIL_RE.exec(token.slice(lead.length))?.[0] ?? "";
    const core = token.slice(lead.length, token.length - trail.length);
    const word = stripPossessive(core);
    let initial = initialNext;
    if (lead.length > 0) {
      close();
      initial = true;
    }
    initialNext = /[:.!?…]/u.test(trail);
    const capital = /^\p{Lu}/u.test(word) && /\p{L}/u.test(word);
    const lower = word.toLowerCase();
    const never = word === "I" || /^I['’]/u.test(core) || NUMBER_WORDS.has(lower) || lower.length === 0;
    if (capital && !never) {
      for (const c of pending) run.push({ word: c, initial: false });
      pending = [];
      run.push({ word, initial });
    } else if (run.length > 0 && CONNECTORS.has(core) && trail.length === 0) {
      pending.push(core);
    } else {
      close();
    }
    if (trail.length > 0) close();
  }
  close();

  const out: string[] = [];
  const seen = new Set<string>();
  const allowed = (opts.allowNames ?? []).map((a) => ` ${canonicalizeForAnchorMatch(a)} `).filter((a) => a.trim().length > 0);
  for (const r of runs) {
    let words = r;
    /* Sentence-initial: drop the leading common words ("The", "But"). */
    while (words.length > 0 && words[0]!.initial && COMMON_WORDS.has(words[0]!.word.toLowerCase())) {
      words = words.slice(1).map((w, k) => (k === 0 ? { ...w, initial: false } : w));
    }
    /* A connector can no longer lead or trail the run. */
    while (words.length > 0 && CONNECTORS.has(words[0]!.word)) words = words.slice(1);
    while (words.length > 0 && CONNECTORS.has(words[words.length - 1]!.word)) words = words.slice(0, -1);
    if (words.length === 0) continue;
    const name = words.map((w) => w.word).join(" ");
    const canon = canonicalizeForAnchorMatch(name);
    if (!canon || seen.has(canon)) continue;
    if (allowed.some((a) => a.includes(` ${canon} `))) continue;
    seen.add(canon);
    out.push(name);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* extractSpecifics / unsupportedSpecifics                              */
/* ------------------------------------------------------------------ */

function isYearLike(n: SpokenNumber): boolean {
  return n.decade || (!n.percent && !n.unit && !n.grouped && !n.ordinal && Number.isInteger(n.value) && n.value >= 1000 && n.value <= 2099);
}

/** The sentence's checkable specifics — numbers, years (decades
 * included) and names — with the exemptions applied. */
export function extractSpecifics(sentence: string, opts: SpecificsOptions = {}): ExtractedSpecifics {
  const smallMax = opts.smallCardinalMax ?? 10;
  const exemptOrdinals = opts.exemptOrdinals ?? true;
  const numbers: Specific[] = [];
  const years: Specific[] = [];
  for (const n of spokenNumberValues(sentence)) {
    if (n.ordinal && exemptOrdinals) continue;
    if (!n.ordinal && !n.percent && !n.unit && !n.decade && Number.isInteger(n.value) && n.value >= 0 && n.value <= smallMax) continue;
    const specific: Specific = { text: n.text, value: n.value, decade: n.decade };
    if (isYearLike(n)) years.push(specific);
    else numbers.push(specific);
  }
  return { numbers, years, names: extractNames(sentence, opts) };
}

/** Sources read once for many sentences: their number values, their decades
 * and their canonical text. Build it once per act (writeAct) or per page
 * (the metric) and pass it to `unsupportedSpecifics` in place of the texts. */
export interface PreparedSources {
  readonly kind: "prepared-specifics-sources";
  values: number[];
  decades: Set<number>;
  canonical: string;
}

export function prepareSpecificsSources(sourceTexts: ReadonlyArray<string>): PreparedSources {
  const values: number[] = [];
  const decades = new Set<number>();
  const canon: string[] = [];
  for (const text of sourceTexts) {
    for (const n of spokenNumberValues(text)) {
      if (n.decade) decades.add(n.value);
      else values.push(n.value);
    }
    /* A name is extracted with its possessive stripped ("Couitt's" gives
       "Couitt"), so each source is kept in both forms: canonicalising alone
       turns a source's "Couitt's" into "couitts", and the plain name the
       sentence states would be flagged although the source carries it; the
       stripped form alone loses "couitts", and a sentence's "McDonalds" or
       plural "Couitts" would be flagged instead. */
    const c = canonicalizeForAnchorMatch(text);
    if (c) canon.push(c);
    const stripped = canonicalizeForAnchorMatch(stripPossessives(text));
    if (stripped && stripped !== c) canon.push(stripped);
  }
  return { kind: "prepared-specifics-sources", values, decades, canonical: ` ${canon.join(" | ")} ` };
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function numberSupported(s: Specific, src: PreparedSources): boolean {
  if (s.decade) {
    /* "the 1980s" rests on a source decade, or on any year inside it. */
    return src.decades.has(s.value) || src.values.some((v) => Number.isInteger(v) && v >= s.value && v <= s.value + 9);
  }
  return src.values.some((v) => sameValue(v, s.value));
}

function nameSupported(name: string, src: PreparedSources): boolean {
  const canon = canonicalizeForAnchorMatch(name);
  if (!canon) return true;
  if (src.canonical.includes(` ${canon} `)) return true;
  const parts = canon.split(" ");
  if (parts.length < 2) return false;
  /* A multi-word name: its longest token of four letters or more will do
     ("Couitt" for "Joe Couitt"), so a source that names the surname alone,
     or an ASR transcript that spells the first name oddly, still carries it. */
  let longest = "";
  for (const p of parts) if (p.length >= 4 && p.length > longest.length) longest = p;
  return longest.length > 0 && src.canonical.includes(` ${longest} `);
}

/**
 * The specifics of `sentence` that no source carries, as the sentence wrote
 * them, in order, each once. A number or year is supported when its value
 * is among the values parsed from any source (a decade, when the source
 * names the decade or a year inside it); a name when its canonical form is
 * in a source, or, for a multi-word name, its longest token of four letters
 * or more is.
 */
export function unsupportedSpecifics(sentence: string, sources: ReadonlyArray<string> | PreparedSources, opts: SpecificsOptions = {}): string[] {
  const src = isPrepared(sources) ? sources : prepareSpecificsSources(sources);
  const found = extractSpecifics(sentence, opts);
  const out: string[] = [];
  for (const s of [...found.years, ...found.numbers].sort((a, b) => sentence.indexOf(a.text) - sentence.indexOf(b.text))) {
    if (!numberSupported(s, src) && !out.includes(s.text)) out.push(s.text);
  }
  for (const name of found.names) if (!nameSupported(name, src) && !out.includes(name)) out.push(name);
  return out;
}

function isPrepared(sources: ReadonlyArray<string> | PreparedSources): sources is PreparedSources {
  return !Array.isArray(sources) && (sources as PreparedSources).kind === "prepared-specifics-sources";
}

/** One sentence of a script with the specifics no source carries. */
export interface UnsupportedSentence {
  sentence: string;
  unsupported: string[];
}

/**
 * `unsupportedSpecifics` over every spoken sentence of `script` (the one
 * splitter, `splitSpokenSentences`, GV-10), keeping only the sentences with
 * something unsupported. Sources are prepared once for the whole script.
 */
export function unsupportedSpecificsInScript(
  script: string,
  sources: ReadonlyArray<string> | PreparedSources,
  opts: SpecificsOptions = {}
): UnsupportedSentence[] {
  const src = isPrepared(sources) ? sources : prepareSpecificsSources(sources);
  const out: UnsupportedSentence[] = [];
  for (const sentence of splitSpokenSentences(String(script ?? ""))) {
    const unsupported = unsupportedSpecifics(sentence, src, opts);
    if (unsupported.length > 0) out.push({ sentence, unsupported });
  }
  return out;
}
