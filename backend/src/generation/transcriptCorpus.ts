import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * THE CORPUS ON DISK, AND THE TWO RULES THAT DECIDE WHAT OF IT IS READABLE
 * (issue #703).
 *
 * WHY THIS MODULE EXISTS, MEASURED. `data-local/transcripts/normalized/` held
 * 22 shows and 5,041 episodes on the 2026-09-14 generation machine, and 723 of
 * those episodes — 14 % — were reachable by tape sourcing. A germ-theory Foray
 * was therefore offered *Being an Engineer* on toothpaste boxes and six
 * *Geology Bites* episodes on banded iron formations, while 49 of 132 *This
 * Podcast Will Kill You* episodes on the same disk say "Semmelweis", "miasma"
 * or "Pasteur".
 *
 * #703 diagnosed that as the text index being built lazily per show. IT IS NOT
 * — `FileTranscriptTextIndex.search` calls `showIndex()` for every show the
 * lineage gate admits and builds a missing one on the spot, so laziness costs
 * time, never reach. The 14-of-22 index-file count was a SYMPTOM. Counted
 * against the code, the 4,318 dark episodes divide cleanly in two, and neither
 * half is laziness:
 *
 *   3,328 (7 shows) HAD NO DIGEST ROW AT ALL. The searchable universe is
 *     `loadTranscriptArchive()`, i.e. the committed digest files, and
 *     `tools/segments/fetch-transcripts.mjs` REWRITES its digest file with only
 *     the targets of that invocation (`writeJsonAtomic(digestsPath, {...
 *     transcripts: digests})`). The digest is a run artifact, not a corpus
 *     index, so every later fetch erased the shows an earlier one recorded
 *     while their bodies stayed on disk. `stuff-you-should-know` (2,857) and
 *     `this-podcast-will-kill-you` (132) are both in `data/catalog.json` with
 *     taxonomy nodes; neither had a row.
 *
 *     990 (Becker's Healthcare, show `1452376188`) HAD ROWS AND UNREADABLE
 *     BODIES. The writer names a body file `slug(guid).slice(0,60)-sha1(guid)`
 *     (`fetch-transcripts.mjs`'s `safeKey`); the reader looked for a file
 *     starting with `slug(guid).slice(0,80)` (`transcriptArchiveLookup`'s
 *     `guidSlug`). For any guid whose slug runs past 60 characters the reader's
 *     prefix is LONGER than the name the writer wrote, so the match fails. Every
 *     Becker's guid is a permalink URL, so all 990 failed and 0 of 990 bodies
 *     resolved. `corpusSafeKey` below is the writer's rule, so the two agree.
 *
 * The other rule here is about a body that IS readable and should not be
 * quoted: see `isLetterSpacedCue`.
 *
 * NO FILESYSTEM, NO IMPORTS FROM THE TWO MODULES THAT USE IT. Both
 * `transcriptArchiveLookup.ts` (the reader) and `transcriptTextIndex.ts` (the
 * index) need these rules, and the index already imports the reader — so the
 * rules live below both of them, where neither import direction is a cycle.
 */

/**
 * The on-disk key for one episode body, byte-identical to
 * `tools/segments/fetch-transcripts.mjs`'s `safeKey` — the function that
 * NAMED the file.
 *
 * Sixty characters, not eighty, and the sha1 suffix is not optional: it is what
 * keeps two episodes whose titles agree for sixty characters apart, which is
 * exactly the case a permalink-guid feed produces
 * (`https://blubrry.com/beckershealthcarepodcast/<id>/<long-title-slug>/`).
 *
 * MIRRORED RATHER THAN IMPORTED, for the same reason
 * `canonicalizeForAnchorMatch` mirrors `merge-segments.mjs`'s `canonical()`:
 * that module is an ESM `.mjs` build script and this is a CommonJS backend
 * module. The ALGORITHM is what has to match, and `transcriptCorpus.test.ts`
 * pins it against the real names on disk.
 */
export function corpusSafeKey(guid: string): string {
  const raw = String(guid ?? "");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return slug ? `${slug}-${hash}` : hash;
}

/**
 * Single-character words that are ordinary English and must never count as
 * evidence of letter-spacing. "I think I built. I built a thing. I don't" is
 * five single-character tokens in ten — a clean 50 % — and it is a sentence a
 * person said.
 */
const REAL_ONE_LETTER_WORDS = new Set(["a", "i", "o"]);

/** A cue shorter than this is never judged: "N E C T O." is four tokens and so
 * is "Yeah, I get it." Below the floor the ratio is noise. */
export const LETTER_SPACED_MIN_TOKENS = 8;

/** The share of counted tokens that must be lone letters or digits before a cue
 * is called letter-spaced. Calibrated below, not guessed. */
export const LETTER_SPACED_RATIO = 0.5;

/**
 * WHETHER ONE CUE IS LETTER-SPACED JUNK RATHER THAN SPEECH (issue #703's
 * "also seen, separately").
 *
 * WHAT IT CATCHES. `sigma-nutrition-radio` #595 is a PDF premium transcript
 * whose cover page was dumped into the opening cues:
 *
 *     "Sigm a Nutrition Prem ium T r a n s c r i p t - E p i s o d e # 5 9 5"
 *
 * That cue was indexed, ranked SECOND under "Medicine" on the germ-theory
 * research map, and quoted into the spine prompt as tape. A clip cut there is
 * unlistenable and the words are not reliably the speaker's — the page is
 * printed matter, not something anybody said.
 *
 * THE RULE, AND WHY IT IS PER-CUE. A cue of at least
 * `LETTER_SPACED_MIN_TOKENS` alphanumeric tokens, at least
 * `LETTER_SPACED_RATIO` of which are a single letter or digit that is not a
 * real one-letter word. Measured over all 5,041 bodies on the generation
 * machine: 652 cues of 2,980,363 (0.0219 %), spread over 506 of 5,037
 * episodes, and the worst single episode is 2.20 % of its cues. So an
 * EPISODE-level rejection would refuse 10 % of the corpus to remove 0.02 % of
 * it — and would still not refuse #595, whose bad cues are 3 of 1,065. The cue
 * is the unit the defect has, so the cue is the unit the rule uses.
 *
 * WHAT IT WOULD WRONGLY REJECT, NAMED. Every false positive in that 652 is a
 * person spelling something out loud:
 *
 *     "It's g l a I s t e r, interiors, plural."   (Around the House)
 *     "Customers of a company called Gritty g R I D"   (Stuff You Should Know)
 *     "only k a r r. Marion Spears, k"   (Becker's Healthcare)
 *
 * Those are real speech and the transcript is right about them. They are also,
 * every one, tape nobody wants a clip of — a Foray does not quote six seconds
 * of a host spelling a surname — so losing them from the searchable text is a
 * cost worth naming and paying. What the rule does NOT do is drop the episode
 * around them: the other 99.4 % of that Around the House episode stays
 * searchable and quotable.
 *
 * WHAT IT WOULD MISS. Letter-spacing confined to fewer than eight tokens
 * ("T E M P R." on its own), and garbling of other kinds — a transcript in the
 * wrong language, or one whose words are right and whose timings are not. #703
 * suspected #595's timeline was degenerate too; it is not (span 2,300.7 s over
 * 665 distinct cue windows), so this rule is the whole of that defect.
 */
export function isLetterSpacedCue(text: string): boolean {
  let counted = 0;
  let lone = 0;
  for (const token of String(text ?? "").split(/\s+/)) {
    if (!token) continue;
    /* Punctuation-only tokens ("-", "#") are neither evidence nor noise: a
       dash between spaced letters should not dilute the ratio that finds them. */
    const word = token.replace(/[^A-Za-z0-9]/g, "");
    if (!word) continue;
    counted += 1;
    if (word.length === 1 && !REAL_ONE_LETTER_WORDS.has(word.toLowerCase())) lone += 1;
  }
  if (counted < LETTER_SPACED_MIN_TOKENS) return false;
  return lone / counted >= LETTER_SPACED_RATIO;
}

/** One show directory under `data-local/transcripts/normalized/`. */
export interface CorpusShowOnDisk {
  /** The directory's own name, `<show_id>-<10 hex>`. */
  dirName: string;
  /** The show id a digest row would carry — the directory name with the
   * `safeKey` hash suffix removed. */
  showId: string;
  /** Body files in it. Counted from the listing; nothing is parsed. */
  episodes: number;
}

/** The `-<10 hex>` suffix `corpusSafeKey` appends to a show id to name its
 * directory. Stripped to recover the id a digest row uses. */
const SHOW_DIR_HASH = /-[0-9a-f]{10}$/;

/**
 * Every show directory on this machine, with how many bodies each holds.
 *
 * A LISTING, NOT A READ: two `readdir` calls per show and no JSON parsed, so
 * this is cheap enough to run at the top of a generation run. It is the only
 * thing that knows the DENOMINATOR — 22 shows, 5,041 episodes — and without a
 * denominator a run cannot say it drew on 14 of 22 shows, which is the whole of
 * #703's second ask.
 */
export function scanNormalizedCorpus(root: string): CorpusShowOnDisk[] {
  const shows: CorpusShowOnDisk[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied corpus root, listed only.
  if (!fs.existsSync(root)) return shows;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  for (const dirName of fs.readdirSync(root)) {
    const dir = path.join(root, dirName);
    let episodes = 0;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      if (!fs.statSync(dir).isDirectory()) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) episodes += 1;
    } catch {
      continue;
    }
    if (episodes === 0) continue;
    shows.push({ dirName, showId: dirName.replace(SHOW_DIR_HASH, ""), episodes });
  }
  return shows;
}

/** One show the corpus holds and tape sourcing could not search, with the
 * reason it could not. */
export interface CorpusBlindSpot {
  showId: string;
  /** Bodies on disk for it. */
  episodes: number;
  /** `"no-digest-row"`: nothing in any digest names this show, so it is not in
   * the searchable universe at all. `"no-body-resolved"`: it has rows and not
   * one of them resolves to a file on this machine. */
  reason: "no-digest-row" | "no-body-resolved";
}

/** What a run can and cannot see of the corpus on its own disk. */
export interface CorpusCoverage {
  showsOnDisk: number;
  episodesOnDisk: number;
  showsSearchable: number;
  episodesSearchable: number;
  /** Shows on disk that sourcing cannot reach, worst first. Empty is the
   * healthy state and the one a warmed machine reports. */
  blindSpots: CorpusBlindSpot[];
}

/**
 * THE GAP, COUNTED (#703 ask 2).
 *
 * The 2026-09-14 run drew its research map from 14 of the 22 shows on its own
 * disk and said nothing about the other eight; it looked healthy, and only
 * reading the tape quotes revealed it. This is the number that makes that
 * impossible to miss, and a run prints it whether or not it is bad news.
 *
 * `hasBody` is passed in rather than computed here because only the cue
 * provider knows how a digest row maps to a file — this module owns the naming
 * RULE, not the directory walk.
 */
export function corpusCoverage(options: {
  archive: Array<{ show_id: string }>;
  hasBody: (entry: { show_id: string }, showId: string) => boolean;
  normalizedRoot: string;
}): CorpusCoverage {
  const disk = scanNormalizedCorpus(options.normalizedRoot);
  const byShow = new Map<string, Array<{ show_id: string }>>();
  for (const entry of options.archive) {
    const list = byShow.get(entry.show_id);
    if (list) list.push(entry);
    else byShow.set(entry.show_id, [entry]);
  }

  let showsSearchable = 0;
  let episodesSearchable = 0;
  const blindSpots: CorpusBlindSpot[] = [];
  for (const show of disk) {
    const rows = byShow.get(show.showId) ?? [];
    if (rows.length === 0) {
      blindSpots.push({ showId: show.showId, episodes: show.episodes, reason: "no-digest-row" });
      continue;
    }
    let resolved = 0;
    for (const row of rows) if (options.hasBody(row, show.showId)) resolved += 1;
    if (resolved === 0) {
      blindSpots.push({ showId: show.showId, episodes: show.episodes, reason: "no-body-resolved" });
      continue;
    }
    showsSearchable += 1;
    episodesSearchable += resolved;
  }
  blindSpots.sort((a, b) => b.episodes - a.episodes || (a.showId < b.showId ? -1 : 1));
  return {
    showsOnDisk: disk.length,
    episodesOnDisk: disk.reduce((n, s) => n + s.episodes, 0),
    showsSearchable,
    episodesSearchable,
    blindSpots
  };
}

/** One line a human reads on stdout, and the same sentence `report.json`
 * carries. Says the good news too — a run that can see everything says so. */
export function corpusCoverageLine(coverage: CorpusCoverage): string {
  const head = `transcript corpus: ${coverage.showsSearchable} of ${coverage.showsOnDisk} shows searchable (${coverage.episodesSearchable} of ${coverage.episodesOnDisk} episodes)`;
  if (coverage.blindSpots.length === 0) return `${head} — the whole corpus`;
  const named = coverage.blindSpots
    .map((b) => `${b.showId} (${b.episodes}, ${b.reason})`)
    .join(", ");
  return `${head}; NOT SEARCHABLE: ${named}. Run \`node tools/generation/warm-transcript-index.mjs\` before this run.`;
}
