/**
 * GV-40 (docs/roadmap/generation-v2.md, from W2-02; covers HW-12, GP-06): a
 * Server-Sent Events reader for the OpenAI-compatible streaming endpoint
 * (LiteLLM on the Spark, SGLang, llama-server). Pure: bytes in, the `data`
 * payload of each event out. No network, no dependency.
 *
 * What it handles, per the WHATWG event-stream rules:
 *   - a chunk boundary anywhere, inside a line, inside a CRLF pair or inside
 *     a multi-byte UTF-8 character (the decoder runs in streaming mode);
 *   - LF, CRLF and a lone CR as line ends;
 *   - ':' comment lines (keep-alives) and fields other than `data`, ignored;
 *   - multi-line data: the `data` lines of one event are joined with "\n";
 *   - one optional space after `data:` is stripped, as the spec says;
 *   - `data: [DONE]`, OpenAI's end-of-stream sentinel: never yielded; the
 *     reader calls `onDone` and stops reading.
 *
 * An event is dispatched at its blank line. Bytes after the last blank line
 * (a stream cut mid-event) are dropped, as the spec says, so a consumer
 * never sees half an event.
 */

export interface ParseSseOptions {
  /** Called once when `data: [DONE]` arrives, before the reader stops. */
  onDone?: () => void;
}

export type SseChunk = Uint8Array | string;

export async function* parseSse(byteStream: AsyncIterable<SseChunk>, opts: ParseSseOptions = {}): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder("utf-8");
  const reader = new SseLineReader();
  for await (const chunk of byteStream) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const data of reader.push(text)) {
      if (data === "[DONE]") {
        opts.onDone?.();
        return;
      }
      yield data;
    }
  }
  /* Flush the decoder and any final line end; an event still open at EOF is
     dropped by the reader. */
  for (const data of reader.push(decoder.decode(), true)) {
    if (data === "[DONE]") {
      opts.onDone?.();
      return;
    }
    yield data;
  }
}

/** The line and event state machine, fed decoded text. */
class SseLineReader {
  private pending = "";
  /** The previous chunk ended in CR: a LF opening the next one is its pair. */
  private skipLeadingLf = false;
  private dataLines: string[] = [];

  push(text: string, end = false): string[] {
    const out: string[] = [];
    let buf = this.pending + text;
    if (this.skipLeadingLf && buf.length > 0) {
      if (buf[0] === "\n") buf = buf.slice(1);
      this.skipLeadingLf = false;
    }
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch !== "\n" && ch !== "\r") continue;
      this.line(buf.slice(start, i), out);
      if (ch === "\r") {
        if (i + 1 < buf.length) {
          if (buf[i + 1] === "\n") i++;
        } else {
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
    }
    this.pending = buf.slice(start);
    if (end) {
      /* An unterminated last line cannot complete an event: dropped. */
      this.pending = "";
      this.dataLines = [];
    }
    return out;
  }

  private line(line: string, out: string[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) out.push(this.dataLines.join("\n"));
      this.dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.dataLines.push(value);
  }
}
