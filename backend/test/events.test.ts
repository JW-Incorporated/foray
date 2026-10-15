import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { EventRowSchema, EventTypeSchema, parseEventRow, safeParseEventRow } from "../src/types/events";

const USER = "11111111-1111-1111-1111-111111111111";

describe("EventRowSchema — valid rows per type", () => {
  it("card_shown", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "card_shown",
        archetype: "stretch",
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"], archetype: "stretch" }
      })
    ).not.toThrow();
  });

  it("picked", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "picked",
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"], archetype: "deep-learn", app: "Apple Podcasts" }
      })
    ).not.toThrow();
  });

  it("skipped_at", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "skipped_at",
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"], elapsed_seconds: 45 }
      })
    ).not.toThrow();
  });

  it("finished requires a source (observed vs manual_stopgap)", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "finished",
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"], percent_complete: 0.9, source: "manual_stopgap" }
      })
    ).not.toThrow();

    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "finished",
        payload: { episode_slug: "lex-353-whyte", topics: [], percent_complete: 0.9 } // missing source
      })
    ).toThrow();
  });

  it("voice_command", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "voice_command",
        payload: { command: "more_like_this", node_id: "engineering/energy-fusion" }
      })
    ).not.toThrow();
  });

  it("thumbs", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "thumbs",
        payload: { direction: "down", node_id: "news/politics" }
      })
    ).not.toThrow();
  });

  it("saved", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "saved",
        payload: { episode_slug: "lex-353-whyte", topics: ["engineering/energy-fusion"] }
      })
    ).not.toThrow();
  });

  it("session_built", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "session_built",
        payload: { session_key: "2026-07-24-morning", builder: "hand-architect-v1" }
      })
    ).not.toThrow();
  });

  it("session_rated", () => {
    expect(() =>
      parseEventRow({
        user_id: USER,
        type: "session_rated",
        payload: { session_key: "2026-07-24-morning", rating: "good" }
      })
    ).not.toThrow();
  });
});

describe("thumbs: a withdrawn or changed vote (round-3 audit app-2-6)", () => {
  // MUTATION: drop "cleared" from the direction enum, or drop `replaces` from
  // ThumbsPayloadSchema (zod strips it) -> red.
  it("accepts direction 'cleared' and keeps `replaces`", () => {
    const row = parseEventRow({
      user_id: USER,
      type: "thumbs",
      payload: { direction: "cleared", node_id: "engineering/energy-fusion", replaces: { direction: "up", reasons: [] } }
    });
    expect(row.payload).toMatchObject({ direction: "cleared", replaces: { direction: "up", reasons: [] } });
  });

  it("rejects a `replaces` that is not an up or a down", () => {
    expect(safeParseEventRow({
      user_id: USER,
      type: "thumbs",
      payload: { direction: "up", node_id: "engineering/energy-fusion", replaces: { direction: "cleared" } }
    }).success).toBe(false);
  });
});

describe("EventRowSchema — rejects invalid rows", () => {
  it("rejects an unknown type", () => {
    const result = safeParseEventRow({ user_id: USER, type: "not_a_real_type", payload: {} });
    expect(result.success).toBe(false);
  });

  it("rejects finished with percent_complete out of [0,1]", () => {
    const result = safeParseEventRow({
      user_id: USER,
      type: "finished",
      payload: { episode_slug: "x", topics: [], percent_complete: 1.5, source: "observed" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload shape mismatched with its type (discriminated union)", () => {
    const result = safeParseEventRow({
      user_id: USER,
      type: "thumbs",
      // this is a 'finished' payload, not a 'thumbs' payload
      payload: { episode_slug: "x", topics: [], percent_complete: 0.9, source: "observed" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects thumbs without a node_id (the explicit-target requirement)", () => {
    const result = safeParseEventRow({
      user_id: USER,
      type: "thumbs",
      payload: { direction: "up" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid user_id", () => {
    const result = safeParseEventRow({
      user_id: "not-a-uuid",
      type: "saved",
      payload: { episode_slug: "x", topics: [] }
    });
    expect(result.success).toBe(false);
  });

  it("accepts episode_id/session_id explicitly absent — the FK columns are never populated by this contract", () => {
    const parsed = EventRowSchema.parse({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "x", topics: [] }
    });
    expect(parsed.episode_id ?? null).toBeNull();
    expect(parsed.session_id ?? null).toBeNull();
  });
});

/* RV-23 (docs/roadmap/recommender-v1.md D6, #1380): the follow pair and the
   completion fields on `finished`, built dark. Nothing emits them yet. */
describe("RV-23: follows and completion fields", () => {
  // MUTATION: make `episodes_played` required in ShowFollowPayloadSchema -> red.
  it("show_followed payload parses with and without episodes_played", () => {
    expect(() => parseEventRow({ user_id: USER, type: "show_followed", payload: { show_id: "hardcore-history" } })).not.toThrow();
    const row = parseEventRow({ user_id: USER, type: "show_unfollowed", payload: { show_id: "hardcore-history", episodes_played: 3, topics: ["history/military"] } });
    expect(row.payload).toEqual({ show_id: "hardcore-history", episodes_played: 3, topics: ["history/military"] });
    expect(safeParseEventRow({ user_id: USER, type: "show_followed", payload: { show_id: "" } }).success).toBe(false);
    expect(safeParseEventRow({ user_id: USER, type: "show_unfollowed", payload: { show_id: "x", episodes_played: 1.5 } }).success).toBe(false);
  });

  // MUTATION: `percent: z.number().min(0).max(1)` -> red (1.1 is refused).
  it("finished percent is bounded at 1.2", () => {
    const base = { episode_slug: "lex-353-whyte", topics: [], percent_complete: 1, source: "observed" };
    const parse = (extra: Record<string, unknown>) => safeParseEventRow({ user_id: USER, type: "finished", payload: { ...base, ...extra } });
    const ok = parse({ percent: 1.1, eff_len_sec: 3120, censored: false, resumed: true });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.payload).toMatchObject({ percent: 1.1, eff_len_sec: 3120, censored: false, resumed: true });
    expect(parse({ percent: 1.2 }).success).toBe(true);
    expect(parse({ percent: 2 }).success).toBe(false);
    expect(parse({ percent: -0.1 }).success).toBe(false);
    expect(parse({}).success).toBe(true); // every field is optional: rows the client already writes still parse
  });

  /* The effective CHECK is the LAST migration that defines events.type (0009
     inline, then 0023), read the way interestLearning.test.ts reads the
     user_interests CHECKs.
     MUTATION: drop 'show_unfollowed' (or any type) from 0023's CHECK -> red. */
  it("the migration CHECK equals EventTypeSchema's values", () => {
    const dir = path.resolve(__dirname, "..", "migrations");
    let found: string[] | null = null;
    let from = "";
    for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/--[^\n]*/g, "");
      for (const statement of sql.split(";")) {
        // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded, test-only.
        const target = /^\s*(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table)\s+(\w+)/i.exec(statement);
        if (!target || target[1] !== "events") continue;
        const check = /check\s*\(\s*type\s+in\s*\(([^)]*)\)/i.exec(statement);
        if (check) {
          found = [...check[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
          from = file;
        }
      }
    }
    expect(from).toBe("0023_events_follow_types.sql");
    expect([...new Set(found ?? [])].sort()).toEqual([...EventTypeSchema.options].sort());
    expect(found).toHaveLength(EventTypeSchema.options.length);
  });
});
