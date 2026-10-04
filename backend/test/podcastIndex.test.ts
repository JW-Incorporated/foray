import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PodcastIndexClient } from "../src/clients/podcastIndex";
import { env } from "../src/config/env";

describe("PodcastIndexClient — dry-run mode (no credentials in env)", () => {
  // The constructor reads env.podcastIndexDryRun, which is derived from these two
  // fields. Pin them to undefined so the suite does not depend on backend/.env
  // being empty (it holds real credentials on the generation PC, #798).
  let savedKey: string | undefined;
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedKey = env.podcastIndexApiKey;
    savedSecret = env.podcastIndexApiSecret;
    env.podcastIndexApiKey = undefined;
    env.podcastIndexApiSecret = undefined;
  });

  afterEach(() => {
    env.podcastIndexApiKey = savedKey;
    env.podcastIndexApiSecret = savedSecret;
  });

  it("reports dryRun = true when no key/secret are configured", () => {
    const client = new PodcastIndexClient();
    expect(client.dryRun).toBe(true);
  });

  it("searchByTerm returns a stub feed without making a network call", async () => {
    const fetchImpl = vi.fn();
    const client = new PodcastIndexClient({ fetchImpl });

    const results = await client.searchByTerm("fusion energy");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toContain("fusion energy");
  });

  it("episodesByFeedId returns a stub episode without making a network call", async () => {
    const fetchImpl = vi.fn();
    const client = new PodcastIndexClient({ fetchImpl });

    const results = await client.episodesByFeedId(12345);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.feedId).toBe(12345);
  });
});
