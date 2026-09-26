import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * Round-3 audit gen-7: when an episode's own body file (the writer's exact
 * key) is missing, `locate` fell back to the first file whose name STARTED
 * with the guid's slug. Guid "ep-5" then matched "ep-5-bonus-<hash>.json",
 * another episode's body: its cues were handed to tier 2 under this
 * episode's enclosure, and bodyStat reported a body that does not exist.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "locate-"));
const dir = path.join(root, "show-a");
fs.mkdirSync(dir, { recursive: true });
const body = (guid: string, text: string) => JSON.stringify({ guid, cues: [{ text, start_sec: 0, end_sec: 5 }] });
fs.writeFileSync(path.join(dir, "ep-5-bonus-0123456789.json"), body("ep-5-bonus", "the bonus episode speaking"));
fs.writeFileSync(path.join(dir, "ep-7-oldname.json"), body("ep-7", "episode seven, under an older file name"));
fs.writeFileSync(path.join(dir, "ep-9.json"), body("ep-9", "episode nine, bare legacy name"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const entry = (guid: string): TranscriptDigestEntry => ({ show_id: "show-a", show_title: "Show A", guid, title: guid, cues: 1 });

describe("gen-7: the transcript body lookup never returns another episode's body", () => {
  it("a guid whose slug prefixes another episode's file name finds NO body", () => {
    /* MUTATION THAT KILLS THIS: go back to returning the first `${slug}-`
       prefix match without opening it — ep-5 gets the bonus episode's cues. */
    const provider = new FileTranscriptCueProvider(root);
    expect(provider.getCues(entry("ep-5"))).toBeNull();
    expect(provider.bodyStat(entry("ep-5"))).toBeNull();
    // and the sibling still finds its own
    expect(provider.getCues(entry("ep-5-bonus"))?.[0]?.text).toBe("the bonus episode speaking");
  });

  it("a prefix-named file whose recorded guid IS this guid is still found", () => {
    expect(new FileTranscriptCueProvider(root).getCues(entry("ep-7"))?.[0]?.text).toBe("episode seven, under an older file name");
  });

  it("the legacy bare-slug name is an exact name and is used", () => {
    expect(new FileTranscriptCueProvider(root).getCues(entry("ep-9"))?.[0]?.text).toBe("episode nine, bare legacy name");
  });

  it("a miss is remembered: a body that appears later in the process is not re-walked for", () => {
    const provider = new FileTranscriptCueProvider(root);
    expect(provider.bodyStat(entry("ep-11"))).toBeNull();
    fs.writeFileSync(path.join(dir, "ep-11.json"), body("ep-11", "late"));
    expect(provider.bodyStat(entry("ep-11"))).toBeNull();
    expect(new FileTranscriptCueProvider(root).bodyStat(entry("ep-11"))).not.toBeNull();
  });
});
