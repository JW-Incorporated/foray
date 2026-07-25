import { describe, it, expect } from "vitest";
import { EventRowSchema, parseEventRow, safeParseEventRow } from "../src/types/events";

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
