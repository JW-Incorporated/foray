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
  byRankBucket,
  checkTranchePairing,
  isAnchorable,
  measuredDispositions,
  measurementCoverage,
  projectFootprint,
  suspectAnchorable,
  repoRelative,
  summaryRow,
  trancheLabel,
  yieldOf,
} from "./breadth-yield.mjs";
import { AD_FREE_SHOWS, isAnchorableShow } from "./fetch-transcripts.mjs";
import { MEASURED_REPORT_RELS } from "./ledgers.mjs";

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

/* MUTATION: give `MEASURED_AD_FREE` its own array literal again instead of
   re-exporting the fetcher's. THIS ALREADY HAPPENED: the first version of this
   file restated the list as three names, #316's ad-inflation scan grew the real
   one to 14, and CI caught the report and the fetcher disagreeing about which
   transcripts are anchorable. `deepEqual` on two copies only tells you they have
   drifted; a re-export makes drifting impossible, so this test now pins the
   IDENTITY rather than the contents. Verified failing against a copy. */
test("the measured ad-free list IS the fetcher's, not a copy of it", () => {
  assert.equal(MEASURED_AD_FREE, AD_FREE_SHOWS, "must be the same array, not an equal one");
  assert.ok(AD_FREE_SHOWS.length >= 3, "sanity: the list is not empty");
  const src = readFileSync(new URL("./breadth-yield.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /MEASURED_AD_FREE\s*=\s*\[/, "no local array literal may shadow the re-export");
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
  /* And the NET rate, which the module's own comment calls "the one to quote".
     It had no denominator assertion: mutating it to `per(net, ok.length)` left
     the suite green, and on tranche 1 the two differ by 0.003 — invisible there,
     and not invisible on a tranche with a real failure rate. Verified failing. */
  assert.equal(y.net_anchorable_per_show_swept, 50, "net is per feed SWEPT too, not per feed that worked");
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
  const row = summaryRow({
    ...rec(),
    episodes: [{ guid: "e1" }, { guid: "e2" }],
    transcript_types: { "text/vtt": 9 },
    /* EVERY NON-SCALAR THE SWEEP CAN PRODUCE MUST BE FED IN HERE, or the loop
       below asserts over a row that could not have violated it. `enclosure_chain`
       arrives from `sweepShow` as an ARRAY and was added to `summaryRow`
       without landing in this fixture — so this guard stayed green while the
       real shape it exists to police went past it. That is the hollow-guard
       failure #318 named, reproduced in the suite that was supposed to catch
       it. `summaryRow` joins the chain to a string; the assertion below is
       what makes that a requirement rather than a preference. */
    enclosure_chain: ["dts.podtrac.com", "api.spreaker.com", "d1bxy2pveef3fq.cloudfront.net"],
  });
  assert.equal(row.episodes, undefined, "episode rows must never reach the committed file");
  assert.equal(row.enclosure_chain, "dts.podtrac.com > api.spreaker.com > d1bxy2pveef3fq.cloudfront.net");
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
  /* An IMPORT of the politeness layer, not a mention of it: the first version
     matched the bare string and failed the moment a comment explained why this
     module needs no throttle. A guard that forbids discussing the rule is a
     guard people delete. */
  assert.doesNotMatch(src, /^import .*politeness\.mjs/m, "nothing to be polite about — it makes no requests");
  /* AND THE ONE MODULE THIS FILE IMPORTS FOR DATA STAYS EMPTY. `ledgers.mjs`
     exists so that this report can share the ledger list with the SCANNER
     without importing the scanner's fetch stack, and that argument holds only
     while `ledgers.mjs` imports nothing itself. The whitelist below names the
     imports this file may have; it cannot see one added a level down, which is
     precisely where the boundary would break silently. */
  const ledgers = readFileSync(new URL("./ledgers.mjs", import.meta.url), "utf8");
  assert.deepEqual(ledgers.match(/^import\s/m), null, "ledgers.mjs holds two frozen arrays and must import nothing");
  assert.deepEqual(ledgers.match(/(?<!\w)fetch\s*\(/g), null);
  // dai.mjs also exports `classifyShow`, which DOES fetch. Importing the whole
  // module and calling the pure predicate is fine; importing the fetcher into a
  // reporting tool would be a second, unthrottled route into publishers' hosts
  // sitting one autocomplete away from being called.
  const daiImport = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/refresh\/dai\.mjs"/.exec(src);
  assert.ok(daiImport, "the dai import should be a named import, not a namespace one");
  assert.deepEqual(daiImport[1].split(",").map((x) => x.trim()).filter(Boolean), ["isDaiHost"]);
  /* Same rule for the fetcher: `fetch-transcripts.mjs` is the only file in this
     directory allowed to request a transcript body, so this may import its
     measured LIST and nothing that makes a request. */
  const fetchImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/fetch-transcripts\.mjs"/.exec(src);
  assert.ok(fetchImport, "the fetcher import should be a named import, not a namespace one");
  assert.deepEqual(fetchImport[1].split(",").map((x) => x.trim()).filter(Boolean), ["AD_FREE_SHOWS"]);
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

/* --------------------------------------------- depth down the ranking (#320)

   These four are about the number that decides WHERE TO STOP sweeping, and
   every one of them fails in the direction of a flatter, more encouraging
   curve. */

/* MUTATION: in `attachArms`, advance the rank counter for every tranche row
   rather than only for exploit rows — i.e. use the array index. The explore arm
   is a uniform random sample and has no rank; giving it one splices random rows
   into the depth axis at whatever positions they occupy in the file, which on
   tranche 2 would put 400 random feeds after rank 600 and produce a "decay"
   that is entirely the arm change. Verified failing. */
test("rank_position is the exploit arm's order, and the explore arm has none", () => {
  const tranche = {
    shows: [
      { show_id: "a", arm: "exploit" },
      { show_id: "b", arm: "exploit" },
      { show_id: "r", arm: "explore" },
      { show_id: "c", arm: "exploit" },
    ],
  };
  const rows = attachArms([rec({ show_id: "c" }), rec({ show_id: "r" }), rec({ show_id: "a" }), rec({ show_id: "b" })], tranche).map(summaryRow);
  const byId = new Map(rows.map((r) => [r.show_id, r]));
  // Position comes from the TRANCHE file's order, not from the swept index's.
  assert.equal(byId.get("a").rank_position, 1);
  assert.equal(byId.get("b").rank_position, 2);
  assert.equal(byId.get("c").rank_position, 3, "an explore row in between must not consume a rank");
  assert.equal(byId.get("r").rank_position, null);
});

/* MUTATION: sort `byRankBucket`'s rows by yield instead of by
   `rank_position`. The output then decays monotonically for ANY input — the
   curve is the sort, not the ranking — and it is indistinguishable from a real
   finding at a glance, which is exactly what makes it worth a test.
   Verified failing. */
test("depth buckets follow the ranking, not the yield", () => {
  const rows = [
    summaryRow(rec({ show_id: "d", rank_position: 4, dai_suspected: false, episodes_with_timed_transcript: 400 })),
    summaryRow(rec({ show_id: "a", rank_position: 1, dai_suspected: false, episodes_with_timed_transcript: 10 })),
    summaryRow(rec({ show_id: "c", rank_position: 3, dai_suspected: false, episodes_with_timed_transcript: 20 })),
    summaryRow(rec({ show_id: "b", rank_position: 2, dai_suspected: false, episodes_with_timed_transcript: 30 })),
  ];
  const buckets = byRankBucket(rows, [], { buckets: 2 });
  assert.deepEqual(buckets.map((b) => [b.rank_from, b.rank_to]), [[1, 2], [3, 4]]);
  // Ranks 1-2 hold 40 transcripts and ranks 3-4 hold 420. A yield sort would
  // report the buckets the other way round and call it decay.
  assert.deepEqual(buckets.map((b) => b.timed_transcripts), [40, 420]);
});

/* MUTATION: bucket on equal TRANSCRIPT counts instead of equal feed counts.
   The budget is denominated in requests, so a bucket has to be a fixed number
   of requests; equal-transcript buckets put the two enormous shows in bucket
   one on their own and hide the whole of the decay inside it. Verified
   failing. */
test("a depth bucket is a fixed number of requests, not of transcripts", () => {
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    rows.push(summaryRow(rec({ show_id: `s${i}`, rank_position: i, dai_suspected: false, episodes_with_timed_transcript: i <= 2 ? 500 : 1 })));
  }
  const buckets = byRankBucket(rows, [], { buckets: 3 });
  assert.deepEqual(buckets.map((b) => b.shows_swept), [2, 2, 2]);
  assert.deepEqual(buckets.map((b) => b.timed_per_show_swept), [500, 1, 1]);
});

/* MUTATION: drop the `suspects` argument from the `yieldOf` call inside
   `byRankBucket`. Suspect rows are concentrated — five Spreaker shows were 62%
   of tranche 1's entire anchorable haul — so a bucket that happens to contain
   one reports a gross figure many times its net one, and the decay curve then
   measures where the suspects landed rather than where the ranking stopped
   paying. Verified failing. */
test("depth buckets are netted of suspects, the same as the arms are", () => {
  const rows = [
    summaryRow(rec({ show_id: "a", rank_position: 1, feed_url: "https://www.spreaker.com/x", dai_suspected: false, enclosure_host: "anon.cloudfront.net", episodes_with_timed_transcript: 900 })),
    summaryRow(rec({ show_id: "b", rank_position: 2, dai_suspected: false, episodes_with_timed_transcript: 10 })),
  ];
  const suspects = suspectAnchorable(rows, { isDaiHost: (h) => h === "spreaker.com" });
  assert.equal(suspects.length, 1, "sanity: the fixture must actually produce a suspect");
  const [bucket] = byRankBucket(rows, suspects, { buckets: 1 });
  assert.equal(bucket.anchorable_timed_transcripts, 910, "the gross figure stays visible");
  assert.equal(bucket.anchorable_net_of_suspects, 10, "the net figure is the one the curve is read from");
});

/* MUTATION: default a missing `rank_position` to 0 rather than dropping the
   row. Explore rows and baseline rows then all pile into bucket one at rank 0,
   which both invents a first bucket and drags every later bucket's boundary.
   Verified failing. */
test("rows with no rank are not bucketed at all", () => {
  const rows = [
    summaryRow(rec({ show_id: "x", dai_suspected: false, episodes_with_timed_transcript: 900 })),
    summaryRow(rec({ show_id: "y", dai_suspected: false, episodes_with_timed_transcript: 900 })),
  ];
  assert.deepEqual(byRankBucket(rows, [], { buckets: 3 }), [], "no ranked rows means no depth report, not a fabricated one");
  assert.deepEqual(byRankBucket([], [], { buckets: 3 }), []);
});

/* MUTATION: label every row from the tranche file's own `shows` array instead
   of from the pairing, or drop `tranche` from the summary row. Two tranches
   are ranked on DIFFERENT priors, so their rank axes are different orderings;
   without a label the two depth curves concatenate into one axis that does not
   exist, and tranche 2's rank 1 reads as a continuation of tranche 1's rank
   300. Verified failing. */
test("rows are labelled with the tranche they came from", () => {
  const rows = [
    ...attachArms([rec({ show_id: "a" })], { shows: [{ show_id: "a", arm: "exploit" }] }, { name: "tranche-01" }),
    ...attachArms([rec({ show_id: "b" })], { shows: [{ show_id: "b", arm: "exploit" }] }, { name: "tranche-02" }),
  ].map(summaryRow);
  assert.deepEqual(rows.map((r) => r.tranche), ["tranche-01", "tranche-02"]);
  // Both are rank 1 OF THEIR OWN TRANCHE. That is only meaningful with the label.
  assert.deepEqual(rows.map((r) => r.rank_position), [1, 1]);
  assert.equal(attachArms([rec({ show_id: "c" })], null)[0].tranche, null, "an unpaired index still reports");
});

/* MUTATION: strip the directory but not the extension in `trancheLabel`, or
   return the whole path. The label ends up in every one of ~1,500 committed
   rows, so a path there is both noise and a leak of one machine's directory
   layout into a file everyone reads. Verified failing. */
test("the tranche label is the file's basename, on either separator", () => {
  assert.equal(trancheLabel("data-local/breadth/tranche-02.json"), "tranche-02");
  assert.equal(trancheLabel("C:\\x\\data-local\\breadth\\tranche-02.json"), "tranche-02");
  // No tranche file: fall back to the index's name rather than leaving it null.
  assert.equal(trancheLabel(null, "data-local/breadth/availability-breadth.json"), "availability-breadth");
});

/* ------------------------------------------- measured suspects (#319, #320) */

const adTech = (over) =>
  summaryRow(rec({ feed_url: "https://x.podigee.io/feed/mp3", dai_suspected: false, enclosure_host: "adswizz.podigee-cdn.net", ...over }));

/* MUTATION: key `measuredDispositions` on `verdict` instead of `disposition`.
   The two DISAGREE on four of the seven shows #319 measured: `verdict` is a
   median ratio over five episodes and reads "ad-free" for shows caught
   inserting into some of those five, while `dispositionOf` looks at whether any
   sample was caught mid-insert. Reading `verdict` here readmits 481 timed
   transcripts from shows already measured injecting — and it reads as a
   recovery, i.e. as good news. Verified failing. */
test("a measured disposition outranks the hostname heuristic, and it is not the verdict", () => {
  const rows = [
    adTech({ show_id: "clean", episodes_with_timed_transcript: 14 }),
    adTech({ show_id: "dirty", episodes_with_timed_transcript: 337 }),
  ];
  // The real file's shape: 'dirty' is Baseball-Prospectus-like — median says
  // ad-free, one of five probes caught an insert, so the disposition is drop.
  const measured = measuredDispositions({
    results: [
      { show_id: "clean", verdict: "ad-free", disposition: "recover" },
      { show_id: "dirty", verdict: "ad-free", disposition: "drop" },
    ],
  });
  const suspects = suspectAnchorable(rows, { measured });
  assert.deepEqual(suspects.map((s) => s.show_id), ["dirty"], "the measured-clean show stops being a suspect");
  assert.equal(suspects[0].reason, "measured-injecting", "a settled row must not read as an open question");
  assert.equal(anchorableNetOfSuspects(rows, suspects), 14);

  // Without the measurement both are suspect on the hostname alone — which is
  // the conservative fallback, and the number the tool reported before #320.
  assert.equal(anchorableNetOfSuspects(rows, suspectAnchorable(rows, {})), 0);
});

/* MUTATION: default an absent entry to "recover" — i.e. treat "nobody has
   measured this" as "measured clean". The unmeasured set is the entire rest of
   the catalogue, so this is the largest single overstatement available in this
   file, and it produces a bigger number that still looks like arithmetic.
   Verified failing. */
test("a show nobody measured keeps its heuristic verdict", () => {
  const rows = [adTech({ show_id: "unmeasured", episodes_with_timed_transcript: 500 })];
  const measured = measuredDispositions({ results: [{ show_id: "someone-else", disposition: "recover" }] });
  assert.deepEqual(suspectAnchorable(rows, { measured }).map((s) => s.reason), ["ad-tech-origin"]);
  assert.equal(anchorableNetOfSuspects(rows, suspectAnchorable(rows, { measured })), 0);
  // A missing or malformed report is the same as no report, never a recovery.
  assert.equal(measuredDispositions(null).size, 0);
  assert.equal(measuredDispositions({ results: [{ show_id: "x" }] }).size, 0, "an entry with no disposition is not a verdict");
});

/* MUTATION: match `AD_TECH_HOST_MARKERS` against `enclosure_host` only, which
   is what this did until #320 — and is precisely the defect #319 removed from
   `classifyShow` one level down. A vendor is under no obligation to be the last
   hop: spreaker sat in the MIDDLE of five chains and was discarded for exactly
   this reason, worth 2,470 transcripts. Measured across both tranches the chain
   scan catches 0 extra rows today, so this test is the only thing holding the
   fix in place until the markers list next grows. Verified failing. */
test("an ad-tech vendor anywhere in the chain is a suspect, not only at the last hop", () => {
  const midChain = summaryRow(rec({
    show_id: "mid",
    dai_suspected: false,
    episodes_with_timed_transcript: 400,
    enclosure_host: "cdn.example.net",                       // clean-looking landing
    enclosure_chain: ["prefix.example", "adswizz.example.net", "cdn.example.net"],
  }));
  assert.deepEqual(suspectAnchorable([midChain], {}).map((s) => s.reason), ["ad-tech-origin"]);

  // A chain with no vendor in it anywhere stays clean — the scan must not
  // flag every row that merely has a chain.
  const clean = summaryRow(rec({
    show_id: "clean", dai_suspected: false, episodes_with_timed_transcript: 400,
    enclosure_host: "cdn.example.net", enclosure_chain: ["dts.podtrac.com", "cdn.example.net"],
  }));
  assert.deepEqual(suspectAnchorable([clean], {}), []);

  // And a row swept before #319 has no chain at all; the last hop still counts.
  const noChain = summaryRow(rec({
    show_id: "old", dai_suspected: false, episodes_with_timed_transcript: 400,
    enclosure_host: "adswizz.podigee-cdn.net",
  }));
  assert.deepEqual(suspectAnchorable([noChain], {}).map((s) => s.reason), ["ad-tech-origin"]);
});

/* ------------------------------------------- what a reviewer found (#320) */

/* MUTATION: delete `checkTranchePairing` from `main`, or make either branch of
   it a warning. This is the SAME silent failure this branch made fatal in
   `rank-breadth.mjs`, and it was left standing in the tool that writes the
   number people quote. The arms are joined out of the tranche file, so a list
   short by one gives an entire index `arm: null`: those rows drop out of BOTH
   arm yields, stay in `breadth_all`, and vanish from the depth report — while
   every printed rate still looks like a rate. Verified failing. */
test("a --tranche list that does not pair with --breadth is fatal", () => {
  const exists = () => true;
  // Short by one — the shape a mangled comma-separated list actually produces.
  assert.throws(
    () => checkTranchePairing(["a.json", "b.json"], ["t1.json"], { exists }),
    /paired positionally/,
  );
  assert.throws(() => checkTranchePairing(["a.json"], ["t1.json", "t2.json"], { exists }), /1/);
  // Present but absent from disk.
  assert.throws(
    () => checkTranchePairing(["a.json"], ["gone.json"], { exists: (p) => p !== "gone.json" }),
    (e) => e.message.includes("gone.json"),
  );
  // NO --tranche at all stays legal: an index with no tranche reports under a
  // null arm on purpose, which the test above this one pins.
  assert.doesNotThrow(() => checkTranchePairing(["a.json", "b.json"], [], { exists }));
  assert.doesNotThrow(() => checkTranchePairing(["a.json"], ["t1.json"], { exists }));
});

/* MUTATION: go back to `size = Math.ceil(n / buckets)` and slicing by `size`.
   That does not produce `buckets` buckets — 10 rows into 6 gives FIVE of 2, and
   7 into 3 gives 3+3+1, putting a rate computed from ONE feed on the same axis
   as two computed from three. It divides evenly on this tranche's 300 and 600,
   which is the only reason it looked right. Verified failing. */
test("depth buckets are equal to within one feed, and there are as many as asked for", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(summaryRow(rec({ show_id: `s${i}`, rank_position: i, dai_suspected: false, episodes_with_timed_transcript: 1 })));

  const six = byRankBucket(rows, [], { buckets: 6 });
  assert.equal(six.length, 6, "six asked for, six returned");
  assert.deepEqual(six.map((b) => b.shows_swept), [2, 2, 2, 2, 1, 1], "the remainder is spread, not dumped in a tail");
  assert.deepEqual(six.map((b) => [b.rank_from, b.rank_to]), [[1, 2], [3, 4], [5, 6], [7, 8], [9, 9], [10, 10]]);
  // Every feed lands in exactly one bucket.
  assert.equal(six.reduce((n, b) => n + b.shows_swept, 0), rows.length);

  // More buckets than rows is one bucket per row, not empty buckets that would
  // each report a 0/feed rate over nothing.
  assert.equal(byRankBucket(rows, [], { buckets: 25 }).length, 10);
  assert.deepEqual(byRankBucket(rows.slice(0, 1), [], { buckets: 6 }).map((b) => b.shows_swept), [1]);
});

/* MUTATION: keep `buckets < 1` as the only guard. A non-integer then reaches
   the arithmetic — `Math.floor(n / NaN)` is NaN, the slice is empty, and the
   loop dereferences `slice[0].rank_position` on undefined. A report that throws
   is better than one that lies, but a report that neither throws nor lies is
   better than both. Verified failing. */
test("a bucket count that is not a whole number returns nothing rather than throwing", () => {
  const rows = [summaryRow(rec({ rank_position: 1, dai_suspected: false, episodes_with_timed_transcript: 5 }))];
  for (const bad of [NaN, 1.5, 0, -3, undefined]) {
    assert.deepEqual(byRankBucket(rows, [], { buckets: bad === undefined ? 0 : bad }), []);
  }
});

/* MUTATION: put the `AD_FREE_SHOWS` short-circuit back ahead of the measured
   `drop` branch, which is the order this file shipped in. `AD_FREE_SHOWS` is a
   measurement too, but an older one keyed on TITLE — so a show appearing in
   both lists is one that has SINCE been caught injecting, and letting the title
   list win readmits it on the strength of the measurement that was superseded.
   The doc-comment claimed this precedence in prose before the code had it.
   Verified failing. */
test("a fresh measured injection outranks the older ad-free title list", () => {
  const row = summaryRow(rec({
    show_id: "both",
    title: AD_FREE_SHOWS[0],
    dai_suspected: false,
    enclosure_host: "adswizz.example.net",
    episodes_with_timed_transcript: 400,
  }));
  const measured = measuredDispositions({ results: [{ show_id: "both", disposition: "drop" }] });
  assert.deepEqual(suspectAnchorable([row], { measured }).map((s) => s.reason), ["measured-injecting"]);
  // With no measurement the title list still wins, which is the existing rule.
  assert.deepEqual(suspectAnchorable([row], {}), []);
});

/* MUTATION: drop `dai_reason` from `summaryRow`, or store `args.breadth`
   verbatim instead of through `repoRelative`. The first makes the headline
   caveat — every anchorable row reads "unknown", not "verified static" —
   checkable only against a gitignored index, which is the wrong place for the
   evidence behind five figures of supply. The second puts one machine's drive
   letter into a committed file, the objection `trancheLabel` exists to avoid.
   Verified failing. */
test("the committed row carries its DAI reason, and committed paths are repo-relative", () => {
  const row = summaryRow(rec({ dai_suspected: false, dai_reason: "unknown (resolve failed: HTTP 403)" }));
  assert.equal(row.dai_reason, "unknown (resolve failed: HTTP 403)");
  assert.equal(summaryRow(rec({})).dai_reason, null, "absent is null, not undefined");

  assert.equal(repoRelative("data/transcript-availability.json"), "data/transcript-availability.json");

  /* BOTH SHAPES OF "OUTSIDE", because this assertion is itself where the first
     version went wrong: it only tried a Windows path, which on POSIX is not an
     absolute path at all, so `relative()` returned it verbatim, the "outside"
     branch never ran, and the drive letter went straight through. Green on the
     machine that wrote it, red in CI. `data-local/` is routinely a sibling
     checkout, so both spellings are real inputs. */
  for (const outsideRaw of [
    "C:/somewhere/else/entirely/data-local/breadth/tranche-02.json",
    "C:\\somewhere\\else\\data-local\\breadth\\tranche-02.json",
    "/somewhere/else/entirely/data-local/breadth/tranche-02.json",
  ]) {
    const outside = repoRelative(outsideRaw);
    assert.doesNotMatch(outside, /^[A-Za-z]:/, `no drive letter may reach the committed file: ${outsideRaw}`);
    assert.doesNotMatch(outside, /\\/, "no backslashes either — one spelling in the file");
    assert.equal(outside, "data-local/breadth/tranche-02.json");
  }
});

/* ============================= #321: measured, or merely not recognised

   `anchorable_net_of_suspects` has always been printed without saying what it
   rests on. Every show behind it carries `dai_reason: "unknown"` — not
   "verified static" but "no host on this redirect chain was recognised", a
   negative filed as a pass. These pin the split that tells the two apart. */

/* MUTATION: make `measuredDispositions` read only the first report when given
   an array. Verified failing.

   There are two measurement files now: #319's settles the shortlist, #321's
   settles the shows the shortlist never flagged. Reading one is how #320 found
   this function — a committed measurement no tool consults decays into
   folklore. Reading only the newer one silently un-drops the five shows #319
   caught injecting. */
test("dispositions merge across every measurement file, not just one", () => {
  const merged = measuredDispositions([
    { results: [{ show_id: "suspect-dirty", disposition: "drop" }] },
    { results: [{ show_id: "anchorable-dirty", disposition: "drop" }] },
  ]);
  assert.equal(merged.get("suspect-dirty"), "drop");
  assert.equal(merged.get("anchorable-dirty"), "drop");
  assert.equal(merged.size, 2);
});

/* MUTATION: let the EARLIER report win a show_id collision. Verified failing.
   The only reason to measure a show twice is that the first answer is stale, so
   an ordering that prefers the stale one inverts the purpose of re-measuring. */
test("a later measurement supersedes an earlier one for the same show", () => {
  const merged = measuredDispositions([
    { results: [{ show_id: "s", disposition: "recover" }] },
    { results: [{ show_id: "s", disposition: "drop" }] },
  ]);
  assert.equal(merged.get("s"), "drop");
});

/* A single report still works unwrapped — #319's call site, and every test
   above, passes one object rather than a list. */
test("a single report is still accepted on its own", () => {
  assert.equal(measuredDispositions({ results: [{ show_id: "s", disposition: "recover" }] }).get("s"), "recover");
  assert.equal(measuredDispositions([]).size, 0);
});

const anch = (over = {}) =>
  summaryRow(rec({ dai_suspected: false, episodes_with_timed_transcript: 100, ...over }));

/* MUTATION: fold `measured_unresolved` into `measured_clean`. Verified failing.

   This is the whole deliverable. A show is unresolved when the probe RAN and
   could not conclude — no declared length to divide by, a sample too thin,
   delivered bytes short of the declaration. Counting it as measured turns
   "10,933, all inferred" into a report that reads like "10,933, measured", and
   on the real corpus it would claim 5,507 transcripts as evidence-backed when
   the evidence is precisely that we could not tell. */
test("probed-but-unsettled is never counted as measured", () => {
  const rows = [
    anch({ show_id: "clean", episodes_with_timed_transcript: 995 }),
    anch({ show_id: "cannot-tell", episodes_with_timed_transcript: 5461 }),
    anch({ show_id: "never-probed", episodes_with_timed_transcript: 525 }),
  ];
  const measured = measuredDispositions({
    results: [
      { show_id: "clean", disposition: "recover" },
      { show_id: "cannot-tell", disposition: "unresolved" },
    ],
  });
  const cov = measurementCoverage(rows, [], measured);
  assert.deepEqual(cov.measured_clean, { shows: 1, timed_transcripts: 995 });
  assert.deepEqual(cov.measured_unresolved, { shows: 1, timed_transcripts: 5461 });
  assert.deepEqual(cov.inferred, { shows: 1, timed_transcripts: 525 });
  assert.equal(cov.measured_pct_of_net, 14.3, "995 of 6,981");
});

/* MUTATION: in `measurementCoverage`, test the disposition BEFORE suspect
   membership. Verified failing.

   A row's disposition says what the bytes showed; `suspects` says whether this
   report counts it. A heuristic suspect that was probed and came back
   `unresolved` is still netted OUT, so filing it under `measured_unresolved`
   would put a row outside the headline number into a bucket that is required to
   sum to it — and the identity below would quietly stop holding. */
test("the three in-corpus buckets reconstruct the headline number exactly", () => {
  const rows = [
    anch({ show_id: "clean", episodes_with_timed_transcript: 995 }),
    anch({ show_id: "cannot-tell", episodes_with_timed_transcript: 5461 }),
    anch({ show_id: "never-probed", episodes_with_timed_transcript: 525 }),
    anch({ show_id: "caught", episodes_with_timed_transcript: 1368 }),
    anch({ show_id: "suspect-unprobed", episodes_with_timed_transcript: 337 }),
    anch({ show_id: "suspect-unsettled", episodes_with_timed_transcript: 42 }),
  ];
  const measured = measuredDispositions({
    results: [
      { show_id: "clean", disposition: "recover" },
      { show_id: "cannot-tell", disposition: "unresolved" },
      { show_id: "caught", disposition: "drop" },
      { show_id: "suspect-unsettled", disposition: "unresolved" },
    ],
  });
  const suspects = [
    { show_id: "caught" },
    { show_id: "suspect-unprobed" },
    { show_id: "suspect-unsettled" },
  ];
  const cov = measurementCoverage(rows, suspects, measured);

  assert.equal(
    cov.measured_clean.timed_transcripts + cov.measured_unresolved.timed_transcripts + cov.inferred.timed_transcripts,
    cov.anchorable_net_of_suspects,
  );
  assert.equal(cov.anchorable_net_of_suspects, anchorableNetOfSuspects(rows, suspects));
  assert.deepEqual(cov.excluded_measured_injecting, { shows: 1, timed_transcripts: 1368 });
  assert.deepEqual(cov.excluded_by_heuristic, { shows: 2, timed_transcripts: 379 });
  assert.equal(cov.measured_unresolved.timed_transcripts, 5461, "the netted-out unresolved suspect is not in here");
});

/* MUTATION: add a `status !== "ok"` test to `measurementCoverage`'s filter, or
   drop the `r.anchorable` test. Verified failing on both.

   The buckets must sum to `anchorableNetOfSuspects`, and that function reads
   `r.anchorable` and nothing else — `isAnchorable` never consults `status`. So
   a coverage filter that ALSO screens on status disagrees with the number it is
   required to reconstruct, and the yield file would carry two different values
   under one key. The earlier version of this test asserted 100 for both and so
   encoded the divergence rather than the agreement its name claims: it passed
   because the fixture had no row that was anchorable AND failed. This one has
   one. */
test("coverage counts exactly the anchorable rows the headline counts", () => {
  const rows = [
    anch({ show_id: "ok" }),
    /* Not reachable from a real sweep — a failed row has no timed transcripts,
       so `isAnchorable` rejects it — but the two predicates must agree because
       they are the same predicate, not because of what today's data holds. */
    anch({ show_id: "anchorable-but-failed", status: "error", episodes_with_timed_transcript: 55 }),
    summaryRow(rec({ show_id: "prose", dai_suspected: false, episodes_with_timed_transcript: 0 })),
  ];
  const cov = measurementCoverage(rows, [], new Map());
  assert.equal(cov.inferred.shows, 2, "the non-anchorable row is excluded; the failed anchorable one is not");
  assert.equal(cov.anchorable_net_of_suspects, anchorableNetOfSuspects(rows, []));
  assert.equal(cov.anchorable_net_of_suspects, 155);
});

/* THE COMMITTED FILES AGREE WITH EACH OTHER. Two measurement files and one
   yield report; if the report's coverage block were computed from a different
   set of dispositions than the files contain, nothing else would notice.

   MUTATION: change a disposition in either inflation file, or the coverage
   block in the yield file, by hand. Verified failing. */
test("the yield report's coverage block matches the measurement files it cites", () => {
  const y = JSON.parse(readFileSync(new URL("../../data/breadth-transcript-yield.json", import.meta.url), "utf8"));
  const cov = y.measurement_coverage;
  assert.ok(cov, "the yield report says what its corpus rests on");

  const measured = measuredDispositions(
    (y.source.measured || []).map((p) =>
      JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8")),
    ),
  );
  assert.deepEqual(
    measurementCoverage(y.shows, y.suspect_anchorable, measured),
    cov,
    "the committed coverage block is reproducible from the committed evidence",
  );
  assert.equal(cov.anchorable_net_of_suspects, y.anchorable_net_of_suspects);
  assert.equal(
    cov.measured_clean.timed_transcripts +
      cov.measured_unresolved.timed_transcripts +
      cov.inferred.timed_transcripts,
    y.anchorable_net_of_suspects,
  );
  /* EVERY measurement file is cited, not just the ones that existed when this
     test was written. The count used to be the literal `2`, which made the
     assertion's own message false the moment #326 committed a third ledger: a
     report that read two of three would have filed a whole tranche under
     `inferred` and this line would have called that "every measurement file
     that exists". Compared against `MEASURED_REPORT_RELS` — the same list the
     tools default to — so the report and the tools cannot disagree about what
     the evidence is. */
  assert.deepEqual(
    (y.source.measured || []).map((p) => p.replaceAll("\\", "/")),
    [...MEASURED_REPORT_RELS],
    "the report reads every measurement file that exists",
  );
});
