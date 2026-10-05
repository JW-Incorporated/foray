import * as fs from "fs";
import * as path from "path";
import { tokenizeForSourcing } from "../generation/catalogueLookup";
import { isLetterSpacedCue, scanNormalizedCorpus } from "../generation/transcriptCorpus";

/**
 * ONE DF TABLE FOR THE WHOLE CORPUS, AND THE TERMS EACH EPISODE IS ABOUT
 * (docs/roadmap/corpus.md §3, PKG-26; roadmap G-13).
 *
 * The text index keeps its postings per show, and that is right for search:
 * a show's index can be built and invalidated on its own. But a term's
 * rarity is a fact about the CORPUS, not about one show — "semmelweis" is
 * everyday vocabulary inside *This Podcast Will Kill You* and vanishingly rare
 * across the 22 shows on the generation machine. This pass writes that one
 * corpus-wide table, plus the top-k tf-idf terms for every episode, which is
 * what the topic assignment (PKG-28/29) reads instead of inheriting a show's
 * label. No model call: it is counting.
 *
 * Outputs, both machine-local and never committed:
 *
 *   data-local/transcripts/corpus-df.json
 *     {version: 1, built_at, docs, df: {term: n}}   — terms with df >= 2 only
 *   data-local/transcripts/episode-terms.jsonl
 *     {show_id, guid, n_tokens, terms: [[term, tfidf], …]}   — one per episode
 *
 * THE TOKENIZER IS THE INDEX'S. Every term here comes from
 * `tokenizeForSourcing` over cue text, the same call
 * `transcriptTextIndex.ts`'s `countTerms` makes, so a term this table counts
 * is a term the index can post and a claim can match. A second tokenizer would
 * make the corpus idf disagree with the per-search idf about what a word is.
 *
 * TWO PASSES, SO MEMORY HOLDS ONLY THE DF MAP. Pass one reads every body and
 * counts, for each term, the distinct episodes it appears in. Pass two reads
 * every body again and scores its terms against the finished table, writing
 * one JSONL line and dropping the episode before the next. The machine this
 * runs on has 16 GB and other agents on it (see `warmTranscriptIndex.ts`); the
 * largest thing that ever exists here is the df map itself.
 *
 * WHICH CUES COUNT. The same ones the cue reader returns
 * (`transcriptArchiveLookup.ts`'s `readCues`): a string `text` with finite,
 * ordered `start_sec`/`end_sec`, and never a letter-spaced cue
 * (`isLetterSpacedCue`, #703). A cue the reader drops is a cue the index never
 * saw, so it must not move the corpus df either.
 *
 * Run from `backend/`:
 *
 *     npx tsx src/cli/buildCorpusTerms.ts
 *     npx tsx src/cli/buildCorpusTerms.ts --show this-podcast-will-kill-you
 *     npx tsx src/cli/buildCorpusTerms.ts --normalized <dir> --out <dir>
 *
 * (`tools/foraycorpus-export/build-terms.mjs`, PKG-27, is the launcher.)
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TRANSCRIPTS_ROOT = path.join(REPO_ROOT, "data-local", "transcripts");

/** Terms kept per episode in `episode-terms.jsonl`. */
export const EPISODE_TERMS_TOP_K = 30;

/** A term must appear in at least this many episodes to be written to
 * `corpus-df.json`. A singleton has no corpus-wide rarity to report beyond
 * "unique", and it is most of the vocabulary (names, typos, ASR misses) — the
 * scorer treats an absent term as df 1, so nothing is lost by leaving it out. */
export const CORPUS_DF_MIN = 2;

export interface TermsArgs {
  /** `--show <id>` (repeatable): only these shows. Empty means every show. */
  shows: string[];
  /** `--normalized <dir>`: the body tree. Defaults to `data-local/transcripts/normalized/`. */
  normalizedRoot: string;
  /** `--out <dir>`: where the two outputs go. Defaults to `data-local/transcripts/`. */
  outDir: string;
}

export function parseTermsArgs(argv: string[]): TermsArgs {
  const shows: string[] = [];
  let normalizedRoot = path.join(TRANSCRIPTS_ROOT, "normalized");
  let outDir = TRANSCRIPTS_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (flag === "--show") {
      shows.push(String(value));
      i += 1;
    } else if (flag === "--normalized") {
      normalizedRoot = path.resolve(value);
      i += 1;
    } else if (flag === "--out") {
      outDir = path.resolve(value);
      i += 1;
    }
  }
  return { shows, normalizedRoot, outDir };
}

/** Per-episode term frequencies, with the index's tokenizer. */
export function termFrequencies(cueTexts: Iterable<string>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const text of cueTexts) {
    for (const term of tokenizeForSourcing(text)) tf.set(term, (tf.get(term) ?? 0) + 1);
  }
  return tf;
}

/** Count one episode into the df map: each DISTINCT term once, however many
 * times the episode says it. */
export function addEpisodeToDf(df: Map<string, number>, tf: ReadonlyMap<string, number>): void {
  for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
}

/** The df map as written to `corpus-df.json`: singletons dropped, keys sorted
 * so two builds of the same corpus are byte-identical. A null-prototype object
 * (F-85), so a transcript token such as "constructor" is a key like any other. */
export function corpusDfTable(df: ReadonlyMap<string, number>, minDf: number = CORPUS_DF_MIN): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const term of [...df.keys()].sort()) {
    const n = df.get(term) ?? 0;
    if (n >= minDf) out[term] = n;
  }
  return out;
}

/**
 * An episode's top-k terms by `tf × log(1 + (docs − df + 0.5)/(df + 0.5))` —
 * the BM25 idf `transcriptTextIndex.ts` already scores with, so the two rank
 * rarity the same way. Sorted by score descending, then term ascending, so the
 * order is total and a rebuild is reproducible. A term the df map does not
 * carry is treated as df 1 (seen only here).
 */
export function scoreTerms(
  tf: ReadonlyMap<string, number>,
  df: ReadonlyMap<string, number>,
  docs: number,
  k: number
): Array<[string, number]> {
  if (k <= 0) return [];
  const scored: Array<[string, number]> = [];
  for (const [term, count] of tf) {
    const n = df.get(term) ?? 1;
    const idf = Math.log(1 + (docs - n + 0.5) / (n + 0.5));
    scored.push([term, count * idf]);
  }
  scored.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return scored.slice(0, k);
}

/** One body file's guid and the text of the cues the reader would return, or
 * null for a file that is not a usable body. */
function readBody(file: string): { guid: string; texts: string[] } | null {
  let parsed: { guid?: unknown; cues?: unknown };
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path came from this module's own walk of the corpus root.
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { guid?: unknown; cues?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.guid !== "string" || !Array.isArray(parsed.cues)) return null;
  const texts: string[] = [];
  for (const c of parsed.cues as Array<Record<string, unknown>>) {
    const text = typeof c?.text === "string" ? c.text : null;
    const start = typeof c?.start_sec === "number" ? c.start_sec : null;
    const end = typeof c?.end_sec === "number" ? c.end_sec : null;
    if (text === null || start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (isLetterSpacedCue(text)) continue;
    texts.push(text);
  }
  return { guid: parsed.guid, texts };
}

/** Every body in the corpus, one at a time, in a stable order (show dir, then
 * file name), with the episode's term frequencies. Episodes with no content
 * words are skipped, identically in both passes. */
function* episodes(args: TermsArgs): Generator<{ showId: string; guid: string; tf: Map<string, number> }> {
  const shows = scanNormalizedCorpus(args.normalizedRoot).sort((a, b) => a.dirName.localeCompare(b.dirName));
  for (const show of shows) {
    if (args.shows.length > 0 && !args.shows.includes(show.showId)) continue;
    const dir = path.join(args.normalizedRoot, show.dirName);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory came from `scanNormalizedCorpus`.
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      const body = readBody(path.join(dir, name));
      if (!body) continue;
      const tf = termFrequencies(body.texts);
      if (tf.size === 0) continue;
      yield { showId: show.showId, guid: body.guid, tf };
    }
  }
}

function writeAtomic(file: string, body: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the output directory (default or `--out`).
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.writeFileSync(tmp, body, "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.renameSync(tmp, file);
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function main(): void {
  const args = parseTermsArgs(process.argv.slice(2));
  const startedAt = Date.now();

  /* Pass 1: the df table. */
  const df = new Map<string, number>();
  let docs = 0;
  for (const { tf } of episodes(args)) {
    addEpisodeToDf(df, tf);
    docs += 1;
  }
  if (docs === 0) {
    console.error(`no transcript bodies under ${args.normalizedRoot}${args.shows.length ? ` for ${args.shows.join(", ")}` : ""}; nothing written.`);
    process.exitCode = 1;
    return;
  }
  const table = corpusDfTable(df);
  const dfFile = path.join(args.outDir, "corpus-df.json");
  const dfBody = JSON.stringify({ version: 1, built_at: new Date().toISOString(), docs, df: table });
  writeAtomic(dfFile, dfBody);
  console.log(
    `pass 1: ${docs} episodes, ${df.size} distinct terms, ${Object.keys(table).length} with df >= ${CORPUS_DF_MIN} -> ${dfFile} (${mb(Buffer.byteLength(dfBody))}, RSS ${mb(process.memoryUsage().rss)})`
  );

  /* Pass 2: per-episode scores against the finished table, streamed. */
  const termsFile = path.join(args.outDir, "episode-terms.jsonl");
  const tmp = `${termsFile}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the output directory (default or `--out`).
  const fd = fs.openSync(tmp, "w");
  let lines = 0;
  try {
    for (const { showId, guid, tf } of episodes(args)) {
      let nTokens = 0;
      for (const n of tf.values()) nTokens += n;
      const terms = scoreTerms(tf, df, docs, EPISODE_TERMS_TOP_K).map(([t, s]): [string, number] => [t, Math.round(s * 10000) / 10000]);
      fs.writeSync(fd, `${JSON.stringify({ show_id: showId, guid, n_tokens: nTokens, terms })}\n`);
      lines += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
  fs.renameSync(tmp, termsFile);
  console.log(`pass 2: ${lines} episode lines -> ${termsFile}`);
  console.log(`total ${((Date.now() - startedAt) / 1000).toFixed(1)} s, RSS at exit ${mb(process.memoryUsage().rss)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(2);
  }
}
