import type { WrittenSeam } from "./NarrationWriterBuilder";
import { RawWrittenSeamLineSchema } from "./replySchemas";

/**
 * GV-43 (W4-09, docs/roadmap/generation-v2.md; covers R1-06, R2-08): the
 * incremental parser for a streamed act reply.
 *
 * THE CONTRACT. A streamed writer reply is JSONL: one seam object per line
 * (replySchemas.ts's RawWrittenSeamLineSchema, every field required), in
 * listening order. A seam is usable the moment its line closes, so the
 * first seam of an act can go to TTS while the model is still writing the
 * rest -- the point of streaming the writer at all (R1-06).
 *
 * WHAT THE PARSER DOES. `push(chunk)` appends a chunk of reply text and
 * returns an event for every line the chunk closed; `end()` flushes what is
 * left. A chunk may end anywhere -- mid-line, mid-string, mid-escape -- and
 * the parser only ever looks at a line once its '\n' has arrived, so the
 * same reply split at any boundaries yields the same events in the same
 * order (the property test in seamStream.test.ts).
 *
 *   - Blank lines are skipped, and so is a markdown fence line (``` or
 *     ```json) before the first content line: a model that wraps the reply
 *     in a fence despite the prompt costs nothing.
 *   - A bare ``` after content is the matching closing fence and is skipped
 *     too, including as the unterminated last line at end().
 *   - Every other line is JSON.parsed and zod-validated on its own. A line
 *     that fails either becomes a 'bad-line' event with the error, and the
 *     parser carries on: a bad line costs that one seam, never the act's
 *     other seams (JSONL's advantage over one whole-act JSON object, where
 *     one bad byte loses everything).
 *   - JSON escapes cannot split a line: a newline inside a JSON string is
 *     always the two characters '\' 'n', and a raw '\n' only ever ends a
 *     line, so splitting on '\n' is exact.
 *
 * end() NEVER GUESSES. A non-empty unterminated buffer at end() is reported
 * as 'unfinished', never parsed as a seam: a reply cut at the token cap
 * stops mid-line, and a truncated line that happens to be valid JSON (a
 * script cut at a sentence end is still a string) must not pass as the
 * seam the model meant to write. A caller whose reply ended NORMALLY
 * (finish 'stop') and whose model omitted the final newline pushes '\n'
 * before end(), so its last line parses as usual.
 *
 * Pure and synchronous; no I/O, no clock. Nothing on the default path calls
 * it: the stream is consumed only behind W4-10's flag.
 */

export type SeamLineEvent =
  | { type: "seam"; seam: WrittenSeam }
  | { type: "bad-line"; line: string; error: string }
  | { type: "unfinished"; partial: string };

const OPENING_FENCE = /^```[A-Za-z]*$/;
const CLOSING_FENCE = /^```$/;

export class JsonlSeamParser {
  private buffer = "";
  /** True once a non-blank, non-fence line has been read: a fence after
   * that is a closing fence, and an opening one is no longer expected. */
  private sawContent = false;

  /** Appends a chunk and returns an event for each line it closed, in order. */
  push(chunk: string): SeamLineEvent[] {
    this.buffer += chunk;
    const events: SeamLineEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const event = this.readLine(line);
      if (event) events.push(event);
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** Flushes the parser: an unterminated non-empty remainder is one
   * 'unfinished' event (a bare closing fence excepted); nothing else. The
   * parser is empty afterwards. */
  end(): SeamLineEvent[] {
    const partial = this.buffer;
    this.buffer = "";
    const trimmed = partial.trim();
    if (trimmed === "") return [];
    if (this.sawContent && CLOSING_FENCE.test(trimmed)) return [];
    return [{ type: "unfinished", partial }];
  }

  private readLine(raw: string): SeamLineEvent | null {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (trimmed === "") return null;
    if (!this.sawContent && OPENING_FENCE.test(trimmed)) return null;
    if (this.sawContent && CLOSING_FENCE.test(trimmed)) return null;
    this.sawContent = true;
    return parseSeamLine(line);
  }
}

/** One complete line -> a 'seam' or a 'bad-line' event. Never throws. */
export function parseSeamLine(line: string): SeamLineEvent {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    return { type: "bad-line", line, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = RawWrittenSeamLineSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
    return { type: "bad-line", line, error: `not a seam line: ${issues}` };
  }
  return { type: "seam", seam: parsed.data };
}
