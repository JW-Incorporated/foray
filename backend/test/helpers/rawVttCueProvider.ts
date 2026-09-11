import * as fs from "fs";
import * as path from "path";
import { normalize } from "../../../tools/segments/transcript-normalize.mjs";
import type { TranscriptCue, TranscriptDigestEntry } from "../../src/generation/transcriptArchiveLookup";
import type { TranscriptBodySource, TranscriptBodyStat } from "../../src/generation/transcriptTextIndex";

/**
 * A cue source over the RAW transcript bodies (`data-local/transcripts/raw/
 * <show_id>-<hash>/<guid-slug>-<hash>.vtt`), for the offline cases that want
 * the real archive on the generation machine.
 *
 * WHY THIS EXISTS. Production reads the NORMALISED bodies
 * (`FileTranscriptCueProvider`, `data-local/transcripts/normalized/`), which is
 * what a machine running Lane C's fetch+normalise step has. On 2026-09-09 that
 * directory was emptied on the generation machine — the 63 *Practical AI*
 * `.vtt` bodies the WS-H replay was measured from are still in `raw/`, their
 * normalised copies are gone — and the two offline WS-H cases in
 * `sourceBeats.test.ts` began failing deterministically for that reason and no
 * other (the cue provider returns `null` for every episode, so the text index
 * rebuilds to nothing and tier 2 has no candidate to open). Skipping on a
 * machine that plainly HAS the tape would have been the wrong answer, and so
 * would a green tick from a stub.
 *
 * So the offline cases fall back to this: the same bodies, through the same
 * `TranscriptBodySource` seam, parsed by the repo's own normaliser
 * (`tools/segments/transcript-normalize.mjs` — the one place allowed to know
 * how VTT and SRT differ), which is exactly the transformation that produced
 * the normalised files. Nothing here writes anything: `data-local/` is read
 * only, and regenerating the normalised bodies is Lane C's job, not a test's.
 */
export class RawVttCueProvider implements TranscriptBodySource {
  private readonly root: string;
  private readonly dirByShow = new Map<string, string | null>();
  private readonly cuesByKey = new Map<string, TranscriptCue[] | null>();

  constructor(root: string) {
    this.root = root;
  }

  /** Whether this machine holds a raw body for at least one of `entries` — the
   * honest form of "is the archive here", as opposed to "does the directory
   * exist" (which is what let the two offline cases fail rather than skip). */
  hasAnyBody(entries: TranscriptDigestEntry[]): boolean {
    return entries.some((entry) => this.bodyStat(entry) !== null);
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    const key = `${entry.show_id}::${entry.guid}`;
    if (this.cuesByKey.has(key)) return this.cuesByKey.get(key) ?? null;
    let cues: TranscriptCue[] | null = null;
    try {
      const file = this.locate(String(entry.show_id), String(entry.guid));
      if (file) {
        const parsed = normalize(fs.readFileSync(file, "utf8"), "text/vtt") as {
          cues?: Array<{ start_sec: number; end_sec: number; text: string }>;
        };
        const usable = (parsed.cues ?? []).filter(
          (c) => typeof c.text === "string" && c.text.length > 0 && Number.isFinite(c.start_sec) && Number.isFinite(c.end_sec)
        );
        if (usable.length > 0) cues = usable.map((c) => ({ text: c.text, start_sec: c.start_sec, end_sec: c.end_sec }));
      }
    } catch {
      cues = null;
    }
    this.cuesByKey.set(key, cues);
    return cues;
  }

  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null {
    try {
      const file = this.locate(String(entry.show_id), String(entry.guid));
      if (!file) return null;
      const stat = fs.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  private showDir(showId: string): string | null {
    if (this.dirByShow.has(showId)) return this.dirByShow.get(showId) ?? null;
    let found: string | null = null;
    if (fs.existsSync(this.root)) {
      for (const d of fs.readdirSync(this.root)) {
        if (d === showId || d.startsWith(`${showId}-`)) {
          found = path.join(this.root, d);
          break;
        }
      }
    }
    this.dirByShow.set(showId, found);
    return found;
  }

  /** Same naming rule as `FileTranscriptCueProvider`: the guid slugged, then
   * the fetcher's content hash. */
  private locate(showId: string, guid: string): string | null {
    const dir = this.showDir(showId);
    if (!dir) return null;
    const slug = String(guid ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!slug) return null;
    const files = fs.readdirSync(dir);
    const match = files.find((f) => f.toLowerCase().startsWith(`${slug}-`) || f.toLowerCase() === `${slug}.vtt`);
    return match ? path.join(dir, match) : null;
  }
}
