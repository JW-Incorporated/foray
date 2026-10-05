/* Row sources for the corpus export (PKG-02, G-10; docs/roadmap/corpus.md).

   A row source is `{ kind, rows(table), counts(), describe() }`: `rows` is an
   async generator of plain row objects for one corpus table, `counts` the row
   count per table, `describe` a printable identity that never carries a
   credential. jsonlRowSource reads a directory of `<table>.jsonl` files (the
   synthetic fixture, PKG-03's scrubbed fixture); pg-row-source.mjs (PKG-07)
   implements the same interface against foraycorpus.

   Lines are streamed with readline, never read whole: the scrubbed fixture is
   small, but the interface is the one the exporter runs against millions of
   rows, and a source that buffers would hide that from every test. */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** The eight corpus tables the exporter reads. Column lists: brief §1 for
    podcasts / podcast_feeds / episodes / episode_source_records / assets;
    ASSUMED for podcast_source_records / podcast_source_links /
    feed_host_policies (see fixtures/synthetic/README.md; PKG-03 confirms). */
export const TABLES = Object.freeze([
  "podcasts",
  "podcast_feeds",
  "podcast_source_records",
  "podcast_source_links",
  "episodes",
  "episode_source_records",
  "assets",
  "feed_host_policies",
]);

export class RowSourceError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RowSourceError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function jsonlRowSource(dir) {
  return {
    kind: "jsonl",
    async *rows(table) {
      if (!TABLES.includes(table)) throw new RowSourceError("UNKNOWN_TABLE", String(table));
      const file = join(dir, `${table}.jsonl`);
      const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      let lineNo = 0;
      try {
        for await (const line of lines) {
          lineNo += 1;
          if (line.trim() === "") continue;
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            throw new RowSourceError("MALFORMED_ROW", `${file}:${lineNo}`);
          }
          yield row;
        }
      } finally {
        lines.close();
      }
    },
    async counts() {
      const out = {};
      for (const table of TABLES) {
        let n = 0;
        for await (const _row of this.rows(table)) n += 1;
        out[table] = n;
      }
      return out;
    },
    describe() {
      return `jsonl:${dir}`;
    },
  };
}
