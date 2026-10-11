import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_LANE_PROFILES,
  LANE_IDS,
  MACHINE_PROFILES_FILE_ENV,
  MachineProfilesError,
  loadLaneProfiles,
  mergeLaneProfiles
} from "../src/config/machineProfiles";

/**
 * GV-03 (W2-05): the generation hardware as data. The defaults carry the plan's
 * numbers and its prose ruling; FORAY_MACHINE_PROFILES_FILE overrides them
 * field by field, and a bad file fails loudly naming the variable, never
 * echoing what the file held.
 */

const FILE = "C:/profiles/lanes.json";

function sourceWithFile(): NodeJS.ProcessEnv {
  return { [MACHINE_PROFILES_FILE_ENV]: FILE };
}

function loadFrom(text: string) {
  return loadLaneProfiles(sourceWithFile(), () => text);
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("machineProfiles — lane profiles as config (GV-03)", () => {
  /* Mutation: change any default below (e.g. spark prefill 1900 -> 1800, or
     second allowsProse false -> true) and this fails. */
  it("defaults carry the plan's numbers for the Spark and the second box", () => {
    expect(LANE_IDS).toEqual(["spark", "second"]);
    const spark = DEFAULT_LANE_PROFILES.spark;
    expect(spark).toMatchObject({
      id: "spark",
      modelAlias: "local-heavy",
      maxConcurrent: 2,
      reservedCritical: 1,
      prefillTokPerSec: 1900,
      decodeTokPerSec: { json: 83, prose: 21.8 },
      promptCeilingTokens: null,
      allowsProse: true,
      structuredOutput: "json_schema",
      usdPerMtokIn: 0,
      usdPerMtokOut: 0
    });
    expect(spark.serverPriority.enabled).toBe(false);
    const second = DEFAULT_LANE_PROFILES.second;
    expect(second).toMatchObject({
      id: "second",
      modelAlias: "local-worker",
      maxConcurrent: 2,
      prefillTokPerSec: 895,
      decodeTokPerSec: { json: 51 },
      promptCeilingTokens: 2000,
      allowsProse: false,
      structuredOutput: "json_schema"
    });
  });

  /* Mutation: set a default that breaks the schema (spark reservedCritical
     1 -> 3, above maxConcurrent) and merging the empty override throws. */
  it("the defaults pass their own schema", () => {
    expect(mergeLaneProfiles({})).toEqual(DEFAULT_LANE_PROFILES);
  });

  /* Mutation: read the file unconditionally (drop the `file === undefined`
     early return) and the spy is called. */
  it("without the variable, returns the defaults and reads no file", () => {
    const readFile = vi.fn(() => "{}");
    expect(loadLaneProfiles({}, readFile)).toBe(DEFAULT_LANE_PROFILES);
    expect(loadLaneProfiles({ [MACHINE_PROFILES_FILE_ENV]: "   " }, readFile)).toBe(DEFAULT_LANE_PROFILES);
    expect(readFile).not.toHaveBeenCalled();
  });

  /* Mutation: replace the merge `{ ...d, ...o }` with `o` alone and the
     untouched fields vanish. */
  it("a file overrides only the fields it names (the OQ-01 V100 edit)", () => {
    const profiles = loadFrom(JSON.stringify({ second: { allowsProse: true, maxConcurrent: 4 } }));
    expect(profiles.second.allowsProse).toBe(true);
    expect(profiles.second.maxConcurrent).toBe(4);
    expect(profiles.second.prefillTokPerSec).toBe(895);
    expect(profiles.second.modelAlias).toBe("local-worker");
    expect(profiles.spark).toEqual(DEFAULT_LANE_PROFILES.spark);
  });

  /* Mutation: drop the nested decodeTokPerSec merge and `json` is lost, so
     the schema rejects the lane. */
  it("nested objects merge one level deep", () => {
    const profiles = loadFrom(JSON.stringify({ spark: { decodeTokPerSec: { prose: 30 }, serverPriority: { enabled: true } } }));
    expect(profiles.spark.decodeTokPerSec).toEqual({ json: 83, prose: 30 });
    expect(profiles.spark.serverPriority).toEqual({ enabled: true, critical: 0, background: 0 });
  });

  /* Mutation: let JSON.parse's SyntaxError escape (it quotes the bad text). */
  it("a non-JSON file throws naming the variable, never echoing the content", () => {
    const err = thrown(() => loadFrom("{ spark: SECRET_CONTENT_9f2 "));
    expect(err).toBeInstanceOf(MachineProfilesError);
    expect(err.message).toContain(MACHINE_PROFILES_FILE_ENV);
    expect(err.message).not.toContain("SECRET_CONTENT_9f2");
  });

  /* Mutation: drop `.strict()` from the override schema and the typo is
     silently ignored. */
  it("a misspelt field throws instead of being ignored", () => {
    const err = thrown(() => loadFrom(JSON.stringify({ second: { allowProse: true } })));
    expect(err).toBeInstanceOf(MachineProfilesError);
    expect(err.message).toContain(MACHINE_PROFILES_FILE_ENV);
  });

  /* Mutation: drop `.strict()` from the file schema and a third lane is
     accepted. */
  it("an unknown lane throws", () => {
    expect(() => loadFrom(JSON.stringify({ third: { maxConcurrent: 1 } }))).toThrow(MachineProfilesError);
  });

  /* Mutation: remove the reservedCritical <= maxConcurrent refine, or the
     int/min(1) on maxConcurrent, and one of these loads. */
  it("invalid values throw naming the variable and the field, never the value", () => {
    const zero = thrown(() => loadFrom(JSON.stringify({ spark: { maxConcurrent: 0 } })));
    expect(zero).toBeInstanceOf(MachineProfilesError);
    expect(zero.message).toContain(MACHINE_PROFILES_FILE_ENV);
    expect(zero.message).toContain("maxConcurrent");
    expect(() => loadFrom(JSON.stringify({ spark: { reservedCritical: 3 } }))).toThrow(/reservedCritical/);
    expect(() => loadFrom(JSON.stringify({ second: { structuredOutput: "grammar-xyz" } }))).toThrow(MachineProfilesError);
    const alias = thrown(() => loadFrom(JSON.stringify({ spark: { modelAlias: 12345678 } })));
    expect(alias.message).not.toContain("12345678");
  });

  /* Mutation: drop the id check and a "second" entry can claim to be the
     Spark. */
  it("a lane entry whose id names the other lane throws", () => {
    expect(() => loadFrom(JSON.stringify({ second: { id: "spark" } }))).toThrow(/second\.id/);
  });

  /* Mutation: let the read error escape (its message carries the path). */
  it("an unreadable file throws naming the variable", () => {
    const err = thrown(() =>
      loadLaneProfiles(sourceWithFile(), () => {
        throw new Error(`ENOENT: no such file, open '${FILE}'`);
      })
    );
    expect(err).toBeInstanceOf(MachineProfilesError);
    expect(err.message).toContain(MACHINE_PROFILES_FILE_ENV);
    expect(err.message).not.toContain(FILE);
  });
});
