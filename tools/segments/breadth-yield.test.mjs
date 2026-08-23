/* Tests for the breadth yield report (#114).
   Run: node --test tools/segments/

   WHAT THIS SUITE IS PROTECTING. The report produces exactly one thing anybody
   will act on: a per-request yield rate that gets multiplied by ~19,000 to
   decide whether the rest of the catalogue is worth sweeping. Every way that
   number can be wrong is a way of being quietly optimistic — pooling the two
   arms, dropping failed feeds from the denominator, counting DAI transcripts
   as anchorable — and all three produce a larger, more encouraging number that
   still looks like arithmetic. So the tests below are mostly about the
   denominator and the classification, not about formatting.

   No network, no fixtures on disk: the inputs are the same JSON shapes
   `sweep-transcripts.mjs` writes. Each test names the one-line mutation that
   makes it fail, and each was run against that mutation before being
   committed. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MEASURED_AD_FREE,
  anchorableNetOfSuspects,
  policyString,
  attachArms,
  byHost,
  isAnchorable,
  projectFootprint,
  suspectAnchorable,
  summaryRow,
  yieldOf,
} from "./breadth-yield.mjs";
import { AD_FREE_SHOWS, isAnchorableShow } from "./fetch-transcripts.mjs";

const rec = (over = {}) => ({
  show_id: over.show_id ?? "s1",
  title: over.title ?? "A Show",
  feed_url: over.feed_url ?? "https://feeds.example.com/f",
  status: "ok",
  dai_suspected: null,
  episodes_total: 100,
  episodes_with_transcript: 0,
  episodes_with_timed_transcript: 0,
  episodes_with_chapters: 0,
  ...over,
});

/* ---------------------------------------------------------- anchorability */

/* MUTATION: treat `dai_suspected === true` as anchorable, i.e. drop the DAI
   test entirely. The measured breadth tranche is overwhelmingly DAI, so this
   single change turns a five-figure "anchorable transcripts" number out of a
   corpus from which not one segment can be cut: ADR-0007's whole point is that
   a DAI show's publisher timestamps do not describe the audio we receive.
   Verified failing. */
test("a DAI show's timed transcripts are not anchorable", () => {
  assert.equal(isAnchorable(rec({ dai_suspected: true, episodes_with_timed_transcript: 900 })), false);
  assert.equal(isAnchorable(rec({ dai_suspected: false, episodes_with_timed_transcript: 3 })), true);
});

/* MUTATION: treat `dai_suspected == null` (the DAI probe could not resolve) as
   anchorable. Unresolved shows are the single largest source of optimism
   available — an unresolved show is an unknown, and counting unknowns as wins
   is how a yield rate becomes a promise the corpus cannot keep.
   Verified failing. */
test("an unresolved DAI verdict counts as not anchorable, and stays visible", () => {
  assert.equal(isAnchorable(rec({ dai_suspected: null, episodes_with_timed_transcript: 500 })), false);
  const y = yieldOf([summaryRow(rec({ dai_suspected: null, episodes_with_timed_transcript: 500 }))]);
  assert.equal(y.anchorable_timed_transcripts, 0);
  assert.equal(y.shows_dai_unresolved, 1, "unresolved must be reported, not just excluded");
});

/* MUTATION: delete a name from MEASURED_AD_FREE, or let it drift from
   fetch-transcripts.mjs's AD_FREE_SHOWS. Those three shows are DAI-flagged and
   MEASURED delivering byte-identical audio, so they are the only reason the
   DAI flag is a haircut rather than a wall — and this file and the fetcher
   would then disagree about which transcripts exist. Verified failing. */
test("the measured ad-free list matches the fetcher's, exactly", () => {
  assert.deepEqual([...MEASURED_AD_FREE].sort(), [...AD_FREE_SHOWS].sort());
  assert.equal(isAnchorable(rec({ title: AD_FREE_SHOWS[0], dai_suspected: true, episodes_with_timed_transcript: 10 })), true);
  assert.equal(isAnchorable(rec({ title: "Not On The List", dai_suspected: true, episodes_with_timed_transcript: 10 })), false);
});

/* MUTATION: return true when `episodes_with_timed_transcript` is 0 but the
   show is non-DAI. Every non-DAI show in the catalogue — including the 87
   swept feeds that publish nothing at all — then counts as an anchorable show,
   and `shows_anchorable` stops meaning anything. Verified failing. */
test("a show with no timed transcript is not anchorable however clean its audio", () => {
  assert.equal(isAnchorable(rec({ dai_suspected: false, episodes_with_timed_transcript: 0, episodes_with_transcript: 90 })), false);
});

/* ------------------------------------------------------------ denominator */

/* MUTATION: divide by `ok.length` instead of `rows.length` in
   `timed_per_show_swept`. Failed feeds cost a request — three, through the
   retry ladder — so excluding them inflates every projection built on this
   rate by the failure rate, and the failure rate on breadth feeds is the thing
   we do not know yet. Verified failing. */
test("the per-request rate is denominated in feeds SWEPT, failures included", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", episodes_with_timed_transcript: 100, dai_suspected: false })),
    summaryRow(rec({ show_id: "b", status: "error", error_code: "HTTP_404", episodes_total: 0 })),
  ];
  const y = yieldOf(rows);
  assert.equal(y.shows_swept, 2);
  assert.equal(y.shows_failed, 1);
  assert.equal(y.timed_per_show_swept, 50, "100 transcripts over 2 requests, not over 1");
  assert.equal(y.anchorable_per_show_swept, 50);
});

/* MUTATION: have `yieldOf` include errored shows' zeroed counts in the
   numerator sums via `rows` rather than `ok`. Harmless today because errors
   zero their counts, but it silently couples the report to that convention;
   more importantly this pins that `shows_ok` and `shows_failed` add up, so a
   failure can never vanish from the report. Verified failing when
   `shows_failed` is computed as a constant 0. */
test("every swept feed lands in exactly one of ok or failed", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", episodes_with_timed_transcript: 10 })),
    summaryRow(rec({ show_id: "b", status: "error", error_code: "TIMEOUT" })),
    summaryRow(rec({ show_id: "c", status: "error", error_code: "HTTP_404" })),
  ];
  const y = yieldOf(rows);
  assert.equal(y.shows_ok + y.shows_failed, y.shows_swept);
  assert.equal(y.shows_failed, 2);
});

/* ------------------------------------------------------------------- arms */

/* MUTATION: join the arms on `title` instead of `show_id`, or drop
   `attachArms` and default every row to one arm. The exploit and explore
   yields then merge, and the merged number is an upper bound being read as a
   population estimate — the single most consequential way this report can
   mislead, because the whole point of the second arm is that the first one is
   biased by construction. Verified failing. */
test("arms are joined by show_id and reported separately", () => {
  const swept = [rec({ show_id: "1", episodes_with_timed_transcript: 900, dai_suspected: false }), rec({ show_id: "2", episodes_with_timed_transcript: 0 })];
  const tranche = { shows: [{ show_id: "1", arm: "exploit" }, { show_id: "2", arm: "explore" }] };
  const rows = attachArms(swept, tranche).map(summaryRow);
  assert.deepEqual(rows.map((r) => r.arm), ["exploit", "explore"]);

  const exploit = yieldOf(rows.filter((r) => r.arm === "exploit"));
  const explore = yieldOf(rows.filter((r) => r.arm === "explore"));
  assert.equal(exploit.timed_per_show_swept, 900);
  assert.equal(explore.timed_per_show_swept, 0);
  // The pooled rate is true of neither arm; that is exactly why both are kept.
  assert.equal(yieldOf(rows).timed_per_show_swept, 450);
});

/* MUTATION: have `attachArms` throw or drop rows when no tranche file is
   present. The report is then unusable against any index that was not produced
   by a tranche — including the curated baseline it exists to compare against.
   Verified failing. */
test("an index with no tranche still reports, with a null arm", () => {
  const rows = attachArms([rec({ show_id: "x" })], null).map(summaryRow);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].arm, null);
});

/* -------------------------------------------------------------- the shape */

/* MUTATION: let `episodes` through in `summaryRow`. This is the file's reason
   to exist: at ~951 bytes per episode row the full catalogue is GBs, and the
   whole design is that only per-SHOW rows are committed while episode rows
   stay in gitignored data-local/ (#255). A single passed-through field
   reintroduces the size problem invisibly. Verified failing. */
test("a summary row carries nothing that scales with episode count", () => {
  const row = summaryRow({ ...rec(), episodes: [{ guid: "e1" }, { guid: "e2" }], transcript_types: { "text/vtt": 9 } });
  assert.equal(row.episodes, undefined, "episode rows must never reach the committed file");
  for (const v of Object.values(row)) {
    assert.ok(!Array.isArray(v) && (v === null || typeof v !== "object"), `summary rows must be flat scalars, got ${JSON.stringify(v)}`);
  }
});

/* MUTATION: derive `host_key` from the full hostname rather than through
   `hostKeyOf`. The by-host table then splits each platform across its
   subdomains, and that table is what `rank-breadth.mjs` reads as priors for the
   next tranche — so the ranking would stop learning from this run.
   Verified failing. */
test("by-host groups a platform's subdomains together", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", feed_url: "https://feeds.buzzsprout.com/1.rss", episodes_with_timed_transcript: 10 })),
    summaryRow(rec({ show_id: "b", feed_url: "https://rss.buzzsprout.com/2.rss", episodes_with_timed_transcript: 5 })),
  ];
  const hosts = byHost(rows);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, "buzzsprout.com");
  assert.equal(hosts[0].timed_transcripts, 15);
});

/* MUTATION: project from `shows_ok` rather than the rows actually written, or
   drop the projection entirely. The footprint number is the one that decides
   whether a file may be committed at full scale, and #313's storage rule
   exists because a 30MB surprise was noticed only after the fact.
   Verified failing. */
test("the footprint projection scales linearly from what was measured", () => {
  const p = projectFootprint(200_000, 500, 19_436);
  assert.equal(p.bytes_per_show, 400);
  assert.equal(p.projected_bytes, 400 * 19_436);
  assert.ok(p.projected_mb > 7 && p.projected_mb < 8, `${p.projected_mb}`);
  assert.equal(projectFootprint(1, 0, 100), null, "no measurement means no projection, not a divide by zero");
});

/* MUTATION: add a `fetch(` call to this module. It reads two JSON files and
   does arithmetic; a reporting tool that acquired a network path would be a
   second, unthrottled route into publishers' hosts, outside the shared
   politeness gate every other file here routes through. Verified failing. */
test("the report has no network path at all", () => {
  const src = readFileSync(new URL("./breadth-yield.mjs", import.meta.url), "utf8");
  /* The lookbehind excludes `\w` only. An earlier version excluded `.` as well,
     to let identifiers like `fetchBody(` through — and that also blinded it to
     every QUALIFIED call: a reviewer added `globalThis.fetch(u)` to this module
     and the assertion stayed green. It was the one mutation of 42 that survived
     a full pass over these suites, in the test whose stated claim is "no network
     path at all". Verified failing against `globalThis.fetch(`. */
  assert.deepEqual(src.match(/(?<!\w)fetch\s*\(/g), null);
  assert.deepEqual(src.match(/(?<!\w)(?:request|get)\s*\(\s*["'`]?https?:/g), null);
  assert.equal(/politeness\.mjs/.test(src), false, "nothing to be polite about — it makes no requests");
  // dai.mjs also exports `classifyShow`, which DOES fetch. Importing the whole
  // module and calling the pure predicate is fine; importing the fetcher into a
  // reporting tool would be a second, unthrottled route into publishers' hosts
  // sitting one autocomplete away from being called.
  const daiImport = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/refresh\/dai\.mjs"/.exec(src);
  assert.ok(daiImport, "the dai import should be a named import, not a namespace one");
  assert.deepEqual(daiImport[1].split(",").map((x) => x.trim()).filter(Boolean), ["isDaiHost"]);
});

/* -------------------------------------------------- contradicted verdicts */

/* MUTATION: only check the resolved `enclosure_host` against the DAI list and
   drop the feed-host check. This is the one that actually happened, and it is
   why the check exists: `spreaker.com` IS on dai.mjs's host list, but its
   enclosures redirect to an anonymous CloudFront distribution that is not — so
   following the redirect DISCARDS a positive identification the feed URL
   already carried, and five Spreaker shows worth 2,470 timed transcripts, 62%
   of the tranche's anchorable haul, were filed as clean. Verified failing. */
test("a known-DAI feed platform is still suspect after an anonymous redirect", () => {
  const rows = [
    summaryRow(rec({
      show_id: "wwe",
      title: "The WWE Podcast",
      feed_url: "https://www.spreaker.com/show/2187791/episodes/feed",
      dai_suspected: false,
      enclosure_host: "d1bxy2pveef3fq.cloudfront.net",
      episodes_with_timed_transcript: 991,
    })),
  ];
  const suspects = suspectAnchorable(rows, { isDaiHost: (h) => h === "spreaker.com" });
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].reason, "dai-host-lost-in-redirect");
  assert.equal(suspects[0].timed_transcripts, 991);
});

/* MUTATION: have `suspectAnchorable` set `anchorable = false` on what it
   matches, i.e. turn the label into an exclusion. The standing rule is
   label-never-exclude, and there is a mechanical reason too: `isAnchorable` is
   pinned to `fetch-transcripts.mjs`'s selection predicate, so a private
   stricter definition here would make the report and the fetcher disagree about
   what the corpus contains. The conservative number is reported ALONGSIDE.
   Verified failing. */
test("suspects are labelled, never removed from the headline counts", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", feed_url: "https://www.spreaker.com/x", dai_suspected: false, enclosure_host: "d1b.cloudfront.net", episodes_with_timed_transcript: 991 })),
    summaryRow(rec({ show_id: "b", feed_url: "https://feeds.blubrry.com/x", dai_suspected: false, enclosure_host: "content.blubrry.com", episodes_with_timed_transcript: 995 })),
  ];
  const suspects = suspectAnchorable(rows, { isDaiHost: (h) => h === "spreaker.com" });
  assert.equal(rows[0].anchorable, true, "the label must not change the classification");
  assert.equal(yieldOf(rows).anchorable_timed_transcripts, 1986, "suspects stay in the headline count");
  assert.equal(anchorableNetOfSuspects(rows, suspects), 995, "and the conservative number is reported too");
});

/* MUTATION: match the ad-tech marker against `feed_url` instead of
   `enclosure_host`. DAI happens on the audio delivery path, not the feed path —
   which is the entire reason `resolveDai` follows the enclosure's redirects at
   all. Verified failing. */
test("the ad-tech marker is matched on the resolved origin, not the feed host", () => {
  const viaFeed = [summaryRow(rec({ show_id: "a", feed_url: "https://adswizz.example.com/f", dai_suspected: false, enclosure_host: "content.example.com", episodes_with_timed_transcript: 5 }))];
  assert.deepEqual(suspectAnchorable(viaFeed), []);

  const viaOrigin = [summaryRow(rec({ show_id: "b", feed_url: "https://sz.podigee.io/feed/mp3", dai_suspected: false, enclosure_host: "adswizz.podigee-cdn.net", episodes_with_timed_transcript: 337 }))];
  const suspects = suspectAnchorable(viaOrigin);
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].reason, "ad-tech-origin");
});

/* MUTATION: flag every show rather than only the anchorable ones. The list is a
   work queue for the ad-inflation scan, and a DAI-flagged show is already
   outside the usable pool — measuring it again buys nothing, and burying the
   handful that matter under hundreds of rows is how a finding stops being read.
   Verified failing. */
test("only anchorable shows are worth flagging for measurement", () => {
  const rows = [summaryRow(rec({ show_id: "a", feed_url: "https://www.spreaker.com/x", dai_suspected: true, enclosure_host: "adswizz.cdn.example", episodes_with_timed_transcript: 900 }))];
  assert.deepEqual(suspectAnchorable(rows, { isDaiHost: () => true }), []);
});

/* MUTATION: have `anchorableNetOfSuspects` subtract a total instead of
   filtering by show_id. Both look right on a single-suspect fixture and differ
   the moment a suspect show is also counted somewhere else; filtering by
   identity is what keeps the two numbers reconcilable row by row.
   Verified failing. */
test("the conservative count is a filter over rows, not a subtraction", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", dai_suspected: false, episodes_with_timed_transcript: 10 })),
    summaryRow(rec({ show_id: "b", dai_suspected: false, episodes_with_timed_transcript: 20 })),
  ];
  // A suspect naming a show that is not in `rows` must not change the answer.
  assert.equal(anchorableNetOfSuspects(rows, [{ show_id: "zz", timed_transcripts: 999 }]), 30);
  assert.equal(anchorableNetOfSuspects(rows, [{ show_id: "b", timed_transcripts: 20 }]), 10);
});

/* MUTATION: flag `MEASURED_AD_FREE` shows like any other. This was a live bug,
   not a hypothetical: the feed-host rule fires on Being an Engineer, Geology
   Bites and Practical AI — which are exactly the shows someone MEASURED
   delivering byte-identical audio — and flagging them cuts the curated baseline
   from 587 anchorable transcripts to 67. Every breadth-vs-curated comparison in
   the report would then be against a baseline this file had just invented, in
   the flattering direction. A measurement outranks a hostname heuristic.
   Verified failing. */
test("a measured ad-free show is never flagged by a hostname heuristic", () => {
  const rows = [
    summaryRow(rec({ show_id: "meas", title: AD_FREE_SHOWS[0], dai_suspected: true, feed_url: "https://feeds.transistor.fm/x", enclosure_host: "adswizz.example.net", episodes_with_timed_transcript: 337 })),
    summaryRow(rec({ show_id: "guess", title: "Unmeasured", dai_suspected: false, feed_url: "https://feeds.transistor.fm/y", enclosure_host: "adswizz.example.net", episodes_with_timed_transcript: 10 })),
  ];
  const suspects = suspectAnchorable(rows, { isDaiHost: (h) => h === "transistor.fm" });
  assert.deepEqual(suspects.map((x) => x.show_id), ["guess"]);
  assert.equal(anchorableNetOfSuspects(rows, suspects), 337);
});

/* MUTATION: compute the net-of-suspects figure once over the pooled rows and
   reuse it for every arm — which is what the first version of this file did.
   THE ARITHMETIC IS THE SAME AND THE CONCLUSION REVERSES. On tranche 1 the
   suspects are 71% of the pooled anchorable haul, which leaves the explore arm
   reading 7.8 anchorable per feed against a curated 2.7 — "breadth is 2.9x
   better". Per arm, the explore arm's OWN suspects are 91% of ITS haul, it
   lands at 0.68/feed, and breadth is 3.9x WORSE. The per-arm number is the one
   that generalises to the unswept catalogue, so it has to be computed per arm.
   Verified failing. */
test("the net-of-suspects rate is computed per arm, not pooled", () => {
  const exploitRows = [summaryRow(rec({ show_id: "e1", dai_suspected: false, episodes_with_timed_transcript: 100 }))];
  const exploreRows = [
    summaryRow(rec({ show_id: "x1", dai_suspected: false, feed_url: "https://www.spreaker.com/a", enclosure_host: "anon.cloudfront.net", episodes_with_timed_transcript: 900 })),
    summaryRow(rec({ show_id: "x2", dai_suspected: false, episodes_with_timed_transcript: 10 })),
  ];
  const all = [...exploitRows, ...exploreRows];
  const suspects = suspectAnchorable(all, { isDaiHost: (h) => h === "spreaker.com" });

  const explore = yieldOf(exploreRows, suspects);
  assert.equal(explore.anchorable_timed_transcripts, 910, "gross is unchanged");
  assert.equal(explore.anchorable_net_of_suspects, 10, "the arm's own suspects come off the arm");
  assert.equal(explore.net_anchorable_per_show_swept, 5);

  const exploit = yieldOf(exploitRows, suspects);
  assert.equal(exploit.anchorable_net_of_suspects, 100, "an arm with no suspects loses nothing");
  // Pooling would have charged the exploit arm for the explore arm's suspects.
  assert.notEqual(exploit.anchorable_net_of_suspects, yieldOf(all, suspects).anchorable_net_of_suspects);
});

/* MUTATION: change either predicate so the two disagree somewhere other than
   `null`. `isAnchorable` here is deliberately STRICTER than the fetcher on an
   unresolved DAI verdict and identical everywhere else; the previous version of
   this suite only compared the two ad-free NAME ARRAYS, which is why the
   divergence went undocumented while three files claimed the predicates were
   identical. This drives the whole grid so the relationship is pinned rather
   than asserted in prose. Verified failing. */
test("the report's anchorable predicate tracks the fetcher's, strictly", () => {
  for (const title of [AD_FREE_SHOWS[0], "Some Other Show"]) {
    for (const dai of [null, true, false]) {
      const show = { title, dai_suspected: dai, episodes_with_timed_transcript: 5 };
      const report = isAnchorable(show);
      const fetcher = isAnchorableShow(show);
      if (dai === null) {
        assert.equal(fetcher, true, `fetcher treats null as anchorable (${title})`);
        assert.equal(report, false, `report is deliberately stricter on null (${title})`);
      } else {
        assert.equal(report, fetcher, `predicates must agree for dai=${dai}, title=${title}`);
      }
      if (report) assert.ok(fetcher, "the report must never be LOOSER than the fetcher");
    }
  }
  // Both agree that no timed transcript means nothing to anchor.
  assert.equal(isAnchorable({ title: "x", dai_suspected: false, episodes_with_timed_transcript: 0 }), false);
  assert.equal(isAnchorableShow({ title: "x", dai_suspected: false, episodes_with_timed_transcript: 0 }), false);
});

/* MUTATION: hardcode a bytes-per-show constant in the policy string again. The
   committed file described itself as "~200 bytes/show" while measuring 721 — a
   3.4x error in the one number that decides whether this shape may be committed
   at full scale, sitting inside the file that disproves it. Deriving it from the
   file's own serialised length is what makes that unable to drift.
   Verified failing. */
test("the policy string quotes the file's own measured size", () => {
  const measured = policyString({ bytes_per_show: 721, projected_mb: 13.4, shows_remaining: 19436 });
  assert.match(measured, /721 bytes\/show/);
  assert.match(measured, /13\.4MB/);
  assert.match(measured, /19436 feeds/);
  // First pass, before the object has a length: no number rather than a wrong one.
  assert.doesNotMatch(policyString(null), /\d+ bytes\/show/);
});
