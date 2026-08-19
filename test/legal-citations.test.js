/* The store-submission documents cite code. This suite makes the citations true.
 *
 * WHY THIS SUITE EXISTS, AND WHAT IT IS WRITTEN TO CATCH
 * `docs/legal/privacy-policy.md` and `docs/legal/data-safety.md` are read by a
 * store reviewer, and every answer in them carries a code reference so the
 * answer can be checked rather than trusted. Those references used to be LINE
 * NUMBERS — 27 of them into `app.js` alone — and at `main` 0104598 twenty-six of
 * the twenty-seven pointed at a line that had nothing to do with the claim
 * citing it. `app.js:966` was offered as the nine thumbs-down reason codes and
 * was `function currentContinue()`. `app.js:1775` was offered as the first-load
 * `session_shown` emit and was `const strip = $("#fy-strip")`.
 *
 * THE FAILURE MODE IS THE ONE WORTH NAMING: they all still resolved. A line
 * number in a 3,160-line file lands on SOMETHING, so a stale pointer reads as
 * precision instead of failing visibly. #280 inserted ~250 lines and corrected
 * exactly the one cell it rewrote, which is how 26 went wrong in one PR without
 * a single check going red.
 *
 * So citations are now `file:anchor`, where the anchor is a DECLARED SYMBOL, and
 * this suite refuses the old form outright. A rename now breaks the document
 * loudly. The pattern is `test/data-deletion.test.js`'s `cp_` key inventory,
 * deliberately: derive the truth from the shipped source, assert the document
 * against it, and assert it in BOTH directions.
 *
 * WHICH SUITE COVERS WHICH MECHANISM (CLAUDE.md § A green test is not evidence)
 *   §1 here  the citation grammar and its resolution. Nothing else in the repo
 *            reads these documents as anything but prose.
 *   §2 here  the transmitted-event inventory. `backend` has suites over the
 *            events TABLE; none of them can see what the client chooses to send,
 *            and none reads the declaration that promises it.
 *   §3 here  the cache bucket name in the documents. `test/sw-generation.test.js`
 *            pins the name inside `sw.js` (it asserts the literal `foray-v5`),
 *            which is why the code was right and the documents were three
 *            versions of wrong: nothing compared the two.
 *   §4 here  the CSP's `connect-src` and the two input length caps — the numeric
 *            claims the documents make about data leaving the device.
 *   test/data-deletion.test.js  the `cp_` key inventory, and §7 of the policy.
 *   test/app-security.test.js   the client's own storage and network posture.
 *
 * EVERY TEST BELOW NAMES THE ONE-LINE MUTATION THAT KILLS IT. They were run.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF normalised on the way in, and it is load-bearing rather than tidy. Both
   legal documents are committed CRLF (this repo is developed on Windows), so the
   `\n\n` in `sentTypesInPolicy()`'s block regex matches nothing without this and
   the Sent table comes back as "could not be located".

   MUTATION: delete the `.replace()`. Ran it — the §2 inventory test goes red.
   The count test below survives it, because its regex is single-line; that is
   the honest blast radius, not the wider one I predicted.

   See .gitattributes for the same trap one layer down. */
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const DOCS = ["docs/legal/privacy-policy.md", "docs/legal/data-safety.md"];

/* ---------- the grammar ---------- */

/* A citation is a markdown code span. Only these extensions make a span a
   citation, which is what keeps the 43 publisher hostnames in policy §4.1 out of
   it: `pdst.fm` and `2.gum.fm` are path-shaped and are not files. */
const SOURCE_EXT = "js|mjs|cjs|ts|html|json|sql|css|md";
const PATH_SRC = `[A-Za-z0-9_./-]+\\.(?:${SOURCE_EXT})`;

const BARE_RE = new RegExp(`^${PATH_SRC}$`);
const ANCHORED_RE = new RegExp(`^(${PATH_SRC}):(.+)$`);
/* The banned form. This is the regression pin: it is not enough to have
   converted the 27, because the next author will reach for a line number unless
   something says no. */
const LINE_CITE_RE = new RegExp(`^(${PATH_SRC}):[0-9]`);

/** Every code span in a document, with the line it sits on for the failure text. */
function codeSpans(rel) {
  const out = [];
  const lines = read(rel).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      out.push({ span: m[1], doc: rel, line: i + 1 });
    }
  });
  return out;
}

const allSpans = () => DOCS.flatMap(codeSpans);

/* ---------- resolving a file ---------- */

/* Basename index over the repo, so `sessionBuilder.ts` resolves without the
   document having to spell out `backend/src/curation/`. It is not a loophole: a
   renamed file has no basename anywhere, so the citation still fails. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "audio-cache", "data-local", ".claude", "build",
  "DerivedData", "Pods", ".gradle", ".idea",
]);

let byBasename = null;
function basenameIndex() {
  if (byBasename) return byBasename;
  byBasename = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const rel = path.relative(ROOT, abs).split(path.sep).join("/");
        if (!byBasename.has(e.name)) byBasename.set(e.name, []);
        byBasename.get(e.name).push(rel);
      }
    }
  };
  walk(ROOT);
  return byBasename;
}

/**
 * The repo-relative path a cited path denotes, or null.
 *
 * An exact path wins. Otherwise the basename must be UNIQUE in the repo: taking
 * the first of several hits would let a renamed file go on resolving against an
 * unrelated namesake, which is the whole failure this suite exists to stop. Five
 * citations resolve this way today (`sessionBuilder.ts`, `buildSession.ts`,
 * `createUserInterestsProvider.ts` and the two documents' references to each
 * other), and each is unique. `package.json` has eight namesakes and resolves
 * exactly, so the ambiguity never arises — but it would the moment the root one
 * were renamed, and then the citation should fail rather than quietly land on
 * `backend/package.json`.
 */
function resolveFile(cited) {
  if (fs.existsSync(path.join(ROOT, cited))) return cited;
  const hits = basenameIndex().get(path.basename(cited)) || [];
  if (hits.length === 1) return hits[0];
  return null;
}

/* ---------- resolving an anchor ---------- */

/** Comments stripped before scanning, the same trick `test/data-deletion.test.js`
    and `test/app-security.test.js` use: these files discuss their own symbols at
    length in prose, and a symbol named only in a comment is not a declaration.
    Without this a DELETED function would still "resolve" against the comment
    that mourns it — the forgiving-fixture failure CLAUDE.md lists five times. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
/* One level of nested parens, so `save(id, seconds, meta = {})` and
   `constructor({ a = null } = {})` are declarations while `trySyncEvents();` is
   not: a call has no `)` followed by `{`. That distinction is the whole point —
   `app.js` calls `trySyncEvents()` in four places and declares it in one. */
const PARAMS = "(?:[^()]|\\([^()]*\\))*";
/* An optional TypeScript return annotation between `)` and `{`. `backend/` is
   TypeScript, and without this `function buildWhyLinePrompt(input: WhyLineInput):
   string {` is not a declaration — the first thing this suite told me. */
const RETURNS = "(?::\\s*[^{;=]+)?";

/** `name()` — a function declaration, arrow const, or class method. */
function declaresFunction(src, name) {
  const n = name.replace(/[$]/g, "\\$&");
  const decl = new RegExp(
    `(?:^|[^\\w.$])(?:(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*)?` +
      `${n}\\s*\\(${PARAMS}\\)\\s*${RETURNS}\\{`
  );
  const arrow = new RegExp(
    `(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?(?:\\(${PARAMS}\\)|${IDENT})\\s*=>`
  );
  const assigned = new RegExp(
    `(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s+)?function\\b`
  );
  return decl.test(src) || arrow.test(src) || assigned.test(src);
}

/** `NAME` — a declared binding. Not a mention, a declaration. */
function declaresBinding(src, name) {
  const n = name.replace(/[$]/g, "\\$&");
  return new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*=`).test(src);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/* A control-flow keyword is not a declaration, and `declaresFunction` cannot tell
   the difference: `if (!store) {` satisfies "identifier, parens, brace" perfectly.
   Verified before adding this — `app.js:if()`, `app.js:for()`, `app.js:switch()`
   and `app.js:catch()` all resolved. No document would cite them, and that is not
   the standard: a resolver looser than the thing it stands for is the failure
   CLAUDE.md lists five times, so it is closed rather than left to good manners. */
const RESERVED = new Set([
  "if", "for", "while", "do", "switch", "case", "catch", "try", "finally",
  "else", "return", "function", "class", "new", "typeof", "await", "with",
]);

/** `#dom-id` — an element this file creates. */
function declaresElement(src, id) {
  return new RegExp(`id=["']${escape(id)}["']`).test(src);
}

/**
 * Resolve one `file:anchor` citation.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
function resolveAnchor(citedPath, anchor) {
  const rel = resolveFile(citedPath);
  if (!rel) return { ok: false, why: `no such file: ${citedPath}` };
  const src = codeOnly(read(rel));

  if (anchor.startsWith("#")) {
    return declaresElement(src, anchor.slice(1))
      ? { ok: true }
      : { ok: false, why: `${rel} creates no element with id ${anchor}` };
  }
  const fn = new RegExp(`^(${IDENT})\\(\\)$`).exec(anchor);
  if (fn) {
    if (RESERVED.has(fn[1])) {
      return { ok: false, why: `"${fn[1]}" is a keyword, not a declaration` };
    }
    return declaresFunction(src, fn[1])
      ? { ok: true }
      : { ok: false, why: `${rel} declares no function ${fn[1]}` };
  }
  if (new RegExp(`^${IDENT}$`).test(anchor)) {
    if (RESERVED.has(anchor)) {
      return { ok: false, why: `"${anchor}" is a keyword, not a declaration` };
    }
    return declaresBinding(src, anchor)
      ? { ok: true }
      : { ok: false, why: `${rel} declares no binding ${anchor}` };
  }
  return {
    ok: false,
    why: `anchor "${anchor}" is not a symbol, a constant or an #element-id`,
  };
}

/* ================= 1. the citations resolve, and cannot be line numbers ======= */

test("no legal document cites code by line number", () => {
  /* MUTATION THAT KILLS THIS: put `app.js:220` back anywhere in either
     document. Ran it — red here, and red in the next test too, because a line
     number does not resolve as an anchor either. Two gates, deliberately: this
     one names the FORM so the reason is legible.

     This is the direction that had no gate at all. Line numbers are not wrong
     because they are imprecise; they are wrong because they stay RESOLVABLE
     while becoming false, so no amount of care at the citing end helps. */
  const offenders = allSpans()
    .filter((s) => LINE_CITE_RE.test(s.span))
    .map((s) => `${s.doc}:${s.line}  \`${s.span}\``);
  assert.deepStrictEqual(
    offenders, [],
    "a line number cannot be kept true by anyone. Cite a declared symbol " +
      "instead — `app.js:toEventRow()`, `app.js:SB_ARCHETYPES`, " +
      "`app.js:#pl-input`:\n" + offenders.join("\n")
  );
});

test("every anchored citation resolves to a declaration in the file it names", () => {
  /* MUTATIONS THAT KILL THIS — one per anchor sub-form, all four run:

       rename the DECLARATION `async function trySyncEvents()` to
         `trySyncEvents2()` and leave all FOUR call sites spelled the old way.
         Red. This is the mutation that proves the resolver is not vacuous: a
         forgiving regex would find `trySyncEvents();` four times over and call
         the citation resolved. `)` followed by `{` is what excludes them.
       rename `function toEventRow(e, userId)` to `toEventRow2`. Red from six
         citations across both documents.
       rename the constant `SB_ARCHETYPES` to `SB_ARCHETYPE_SET`. Red.
       rename the element id `fy-sheet-note` to `fy-sheet-remark`. Red.

     And the reverse direction: change a citation to `app.js:toEventRowX()` with
     the source untouched. Red. Both ways, like the `cp_` key inventory. */
  const bad = [];
  for (const s of allSpans()) {
    const m = ANCHORED_RE.exec(s.span);
    if (!m) continue;
    const r = resolveAnchor(m[1], m[2]);
    if (!r.ok) bad.push(`${s.doc}:${s.line}  \`${s.span}\` — ${r.why}`);
  }
  assert.deepStrictEqual(
    bad, [],
    "these code citations do not resolve. A store reviewer is being pointed at " +
      "something that is not there:\n" + bad.join("\n")
  );
});

test("every bare file a legal document names exists", () => {
  /* MUTATION THAT KILLS THIS: rename `sw.js`. Ran it — red.
     Cheaper than it looks and worth having: policy §1 and data-safety §A6 name
     nine shipped files with no anchor at all, and a file rename is exactly the
     change that would leave them pointing nowhere. */
  const missing = [];
  for (const s of allSpans()) {
    if (!BARE_RE.test(s.span)) continue;
    if (!resolveFile(s.span)) missing.push(`${s.doc}:${s.line}  \`${s.span}\``);
  }
  assert.deepStrictEqual(missing, [], "cited files that do not exist:\n" + missing.join("\n"));
});

/**
 * The anchors that carry a data claim — the ones that make an answer checkable
 * rather than merely asserted.
 *
 * WHY THIS IS A SET AND NOT A COUNT. It was a count first: "at least 33 anchored
 * citations". That went vacuous within the hour, and by my own hand — adding a
 * three-sentence note to data-safety's header brought three more citations with
 * it, the total went 33 -> 36, and the mutation that deletes a citation started
 * passing with 35. A floor measures the wrong thing: it cannot tell a citation
 * added to a header from the one deleted off the `nudgeTopics` claim.
 *
 * So each entry below is a claim a store reviewer can audit, and every one must
 * be cited SOMEWHERE in the two documents. Occurrence counts are deliberately
 * not pinned — `toEventRow()` is cited ten times because ten answers rest on it,
 * and that number should be free to move.
 *
 * Adding a row here is how a new auditable claim gets protected. Removing one is
 * the deliberate act: it says the documents no longer need to prove that answer.
 */
const LOAD_BEARING = [
  // what leaves the device, and how
  "app.js:toEventRow()",
  "app.js:trySyncEvents()",
  "app.js:SB_URL",
  "app.js:sbAuth()",
  "app.js:ensureAnonSession()",
  // the fields whose narrowness the documents claim
  "app.js:SB_ARCHETYPES",
  "app.js:bindPickLogging()",
  "app.js:FB_CHIPS",
  "app.js:bindFeedback()",
  "app.js:#fy-sheet-note",
  "app.js:#pl-input",
  // the answers that turn on local-only storage
  "app.js:profileId()",
  "app.js:storageBackend()",
  "player/durable-store.js:_recordHealth()",
  "player/position-store.js:save()",
  // purpose, deletion, and the first-load sync caveat
  "app.js:nudgeTopics()",
  "app.js:deleteMyData()",
  "app.js:init()",
  // the third parties
  "player/html-audio-backend.js:load()",
  "backend/src/enrich/AnthropicEnricher.ts:buildWhyLinePrompt()",
];

test("every load-bearing claim still carries a citation", () => {
  /* A guard on the resolution tests above, which are vacuously green if the
     citations are simply deleted — an uncited claim resolves perfectly.

     MUTATION THAT KILLS THIS: delete any one citation, e.g. replace
     "(`app.js:nudgeTopics()`)" in A3's Personalization bullet with "(the
     interest weights)". Ran it — red, naming the anchor. Ran it against the
     count-floor version this replaced: GREEN, which is why it was replaced. */
  const cited = new Set(
    allSpans().filter((s) => ANCHORED_RE.test(s.span)).map((s) => s.span)
  );
  const uncited = LOAD_BEARING.filter((a) => !cited.has(a));
  assert.deepStrictEqual(
    uncited, [],
    "these claims are no longer backed by a citation in either document, so " +
      "nothing a reviewer reads points at the code that makes them true:\n" +
      uncited.join("\n")
  );
});

test("the load-bearing list is not carrying an entry nobody cites", () => {
  /* The other direction on the list itself, so it cannot rot into a wish. Every
     entry must be a real citation AND resolve — which the resolution test already
     covers for whatever is in the documents, but not for an entry here that was
     never added to them.

     MUTATION THAT KILLS THIS: add "app.js:neverCited()" to LOAD_BEARING. Ran it
     — red from the test above, which is the same signal: the list and the
     documents must agree. This test adds the reason WHY, by resolving each. */
  const bad = [];
  for (const a of LOAD_BEARING) {
    const m = ANCHORED_RE.exec(a);
    if (!m) { bad.push(`${a} — not a well-formed citation`); continue; }
    const r = resolveAnchor(m[1], m[2]);
    if (!r.ok) bad.push(`${a} — ${r.why}`);
  }
  assert.deepStrictEqual(bad, [], "LOAD_BEARING entries that do not resolve:\n" + bad.join("\n"));
});

/* ================= 2. the transmitted-event inventory ======================== */

/** The event types `toEventRow` turns into a row — i.e. the ones that leave the
    device. Derived from the shipped switch, never listed here: a typed list
    would rot exactly the way the line numbers did. */
function transmittedTypes() {
  const src = read("app.js");
  const body = /function toEventRow\([\s\S]*?\n\}/.exec(src);
  assert.ok(body, "toEventRow could not be located in app.js");
  /* PREMISE GUARDS on the extraction, because both ways it can go wrong are
     silent. The regex stops at the first `}` in column 0, so a `toEventRow`
     wrapped in a block would under-capture and this function would report FEWER
     transmitted types than exist — which is the direction that lets undisclosed
     collection through. Over-capture would pull in `case` labels from another
     switch entirely. Neither is detectable from the returned list, so assert the
     shape instead: the arm every non-transmitted type falls to must be inside,
     and no second function declaration may be. */
  assert.match(
    body[0], /default:\s*\n?\s*return null/,
    "toEventRow's `default: return null` arm is not inside the extracted body — " +
      "the extraction under-captured, and every type below the cut would be " +
      "counted as local-only"
  );
  assert.ok(
    !/\n(?:async )?function /.test(body[0]),
    "the extraction ran past the end of toEventRow and into another function, so " +
      "`case` labels from an unrelated switch may be counted as transmitted"
  );
  /* Split on the case labels themselves, so each arm is examined for whether it
     reaches `row(` — `thumbs` has an early `return null` guard AND returns a
     row, and only the second fact makes it transmitted. */
  const arms = body[0].split(/case\s+"/).slice(1);
  const out = [];
  for (const arm of arms) {
    const name = /^([a-z_]+)":/.exec(arm);
    if (!name) continue;
    const upToNext = arm.split(/\n\s*(?:case\s+"|default:)/)[0];
    if (/return\s+row\(/.test(upToNext)) out.push(name[1]);
  }
  return out.sort();
}

/** The `Sent` table in policy §2 — the document's own inventory of the same set. */
function sentTypesInPolicy() {
  const doc = read("docs/legal/privacy-policy.md");
  const block = /\*\*Sent\*\*[\s\S]*?\n\n([\s\S]*?)\*\*Not sent/.exec(doc);
  assert.ok(block, "policy §2's Sent table could not be located");
  return [...block[1].matchAll(/^\|\s*`([a-z_]+)`/gm)].map((m) => m[1]).sort();
}

test("the event types that leave the device are exactly the ones policy §2 lists", () => {
  /* THE SECOND DIRECTION, and the reason this suite is modelled on the `cp_` key
     inventory rather than on a link checker. A citation test proves a pointer
     lands somewhere; it cannot notice that the app started transmitting a sixth
     kind of event. This can.

     MUTATION THAT KILLS IT, forwards: add
       case "player_pref": return row("player_pref", {});
     to `toEventRow`. Ran it — red: `player_pref` is transmitted and undocumented.
     MUTATION THAT KILLS IT, backwards: delete the `saved` row from policy §2's
     Sent table. Ran it — red: `saved` is documented nowhere. */
  const inCode = transmittedTypes();
  const inDoc = sentTypesInPolicy();
  assert.deepStrictEqual(
    inCode, inDoc,
    "app.js's toEventRow and privacy-policy.md §2 disagree about what leaves " +
      "the device. A type in the code and not in the table is undisclosed " +
      `collection.\n  code: ${inCode.join(", ")}\n  doc:  ${inDoc.join(", ")}`
  );
});

test("data-safety's \"exactly N of 18\" is the number the code produces", () => {
  /* The same fact in the other document, which states it as a count in prose
     rather than as a table — so the count is what there is to pin, and it is the
     sentence a store reviewer reads first.

     MUTATION THAT KILLS THIS: the same added `case` above. Ran it — red,
     "declares 5 transmitted types, the code produces 6". */
  const n = transmittedTypes().length;
  const doc = read("docs/legal/data-safety.md");
  const claim = /\*\*Exactly (\d+) of (\d+) event types are transmitted\*\*/.exec(doc);
  assert.ok(claim, "data-safety's transmitted-count sentence could not be located");
  assert.strictEqual(
    Number(claim[1]), n,
    `docs/legal/data-safety.md declares ${claim[1]} transmitted types, the ` +
      `code produces ${n}`
  );
});

/* ================= 3. the cache bucket name ================================== */

/** The bucket `sw.js` actually ships. */
function shippedCacheName() {
  const m = /const CACHE = "([^"]+)"/.exec(read("sw.js"));
  assert.ok(m, "sw.js's CACHE constant could not be located");
  return m[1];
}

test("both legal documents name the cache bucket sw.js actually ships", () => {
  /* THE DRIFT THIS PIN EXISTS FOR: #233 bumped `sw.js` to `foray-v5` and left
     `foray-v4` in three places across the two documents, for nine weeks, with
     `test/sw-generation.test.js` green the whole time — it pins the name inside
     `sw.js` and has no idea the documents quote it.

     MUTATION THAT KILLS THIS: change `sw.js` to `const CACHE = "foray-v6";`.
     Ran it — red on both documents. The next bump cannot land in `sw.js` alone. */
  const name = shippedCacheName();
  for (const rel of DOCS) {
    const doc = read(rel);
    assert.ok(
      doc.includes(`\`${name}\``),
      `${rel} never names the shipped cache bucket \`${name}\``
    );
    const stale = [...doc.matchAll(/`(foray-v\d+)`/g)]
      .map((m) => m[1])
      .filter((v) => v !== name);
    assert.deepStrictEqual(
      [...new Set(stale)], [],
      `${rel} still names a cache bucket the app does not use: ${stale.join(", ")}`
    );
  }
});

/* ================= 4. the numeric claims ==================================== */

test("connect-src names exactly the app's own origin and the Supabase project", () => {
  /* This replaces a pointer with an assertion, deliberately. The documents used
     to cite `index.html:13` for the CSP; they now cite `index.html`, and the
     claim they rest on — "`connect-src` names only two origins" — is checked
     here instead. A store reviewer needs the claim to be true, not the line
     number to be current.

     MUTATION THAT KILLS THIS: add any origin to `connect-src` in index.html.
     Ran it — red. That is the tripwire data-safety § What would change these
     answers says is the narrowest reliable one in the client, so it should have
     a check and did not. */
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/
    .exec(read("index.html"));
  assert.ok(csp, "index.html's CSP meta tag could not be located");
  const directive = /connect-src ([^;"]*)/.exec(csp[1]);
  assert.ok(directive, "the CSP has no connect-src");
  const sources = directive[1].trim().split(/\s+/);

  const sbUrl = /const SB_URL = "([^"]+)"/.exec(read("app.js"));
  assert.ok(sbUrl, "app.js's SB_URL could not be located");

  assert.deepStrictEqual(
    sources, ["'self'", sbUrl[1]],
    "policy §5 and data-safety §A4 both rest on connect-src naming exactly the " +
      "app's own origin and our Supabase project. It now names: " +
      sources.join(" ")
  );
});

test("the two input length caps the documents quote are the shipped ones", () => {
  /* Both numbers are claims about user data: 120 bounds text that is searched
     on-device and never sent (the In-app search history answer is No because of
     it), and 200 bounds free text that IS transmitted.

     MUTATION THAT KILLS THIS: change `maxlength="200"` to `maxlength="500"` on
     `#fy-sheet-note` in app.js. Ran it — red. */
  const src = read("app.js");
  const capOf = (id) => {
    const m = new RegExp(`id="${id}"[^>]*maxlength="(\\d+)"`).exec(src);
    assert.ok(m, `#${id} has no maxlength in app.js`);
    return m[1];
  };
  const doc = read("docs/legal/data-safety.md");
  for (const [id, where] of [["pl-input", "In-app search history"],
    ["fy-sheet-note", "Other user-generated content"]]) {
    const cap = capOf(id);
    assert.ok(
      doc.includes(`\`maxlength=${cap}\``),
      `data-safety's ${where} answer quotes a cap for #${id} that app.js does ` +
        `not ship — the shipped value is ${cap}`
    );
  }
});
