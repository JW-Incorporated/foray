/* Reading a workflow file without a YAML parser — the shared half.
 *
 * WHY THIS MODULE EXISTS (#245). These four helpers were written for
 * `ios-workflow.test.mjs` (#38) and every one of them carries a comment about a
 * REAL DEFECT it was fixed for: a comment inside `on:` that satisfied a path
 * assertion, a `grep`-shaped matcher that matched a LOG FILENAME and then
 * asserted a property of it. `android-workflow.test.mjs` needs exactly the same
 * reading, and hand-copying sixty lines of hard-won parsing into a second file is
 * how two copies of a rule start disagreeing — the failure `tools/ci/path-policy.mjs`
 * was extracted from workflow YAML to prevent, in its own header, for the same
 * reason. So they moved here and both suites import them.
 *
 * WHY IT PARSES RATHER THAN GREPS, AND WHERE IT STOPS. The repo root is
 * dependency-free by design (#209 §2.4), so there is no YAML library available to
 * a root-group suite. Structure that can be read reliably without one — the
 * top-level keys, and a block by its owning key's indentation — is read here;
 * everything past that is a targeted assertion on the text, in the suite, with a
 * message that says what it is protecting. A YAML parser would be better and is
 * not worth a root dependency.
 *
 * NOT A GENERAL YAML READER, and do not grow it into one. It handles the subset
 * GitHub workflow files in this repo actually use. Flow mappings, anchors,
 * multi-document files and quoted keys containing colons will all fool it.
 */

/** Top-level (column-0) keys of a YAML document, in order. Safe because a block
 *  scalar's content must be indented deeper than its key, so nothing inside a
 *  `run: |` can sit at column 0. */
export function topLevelKeys(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][\w-]*:/.test(l))
    .map((l) => l.slice(0, l.indexOf(":")));
}

/** The lines of one block, by its owning key's indentation.
 *
 *  `indent` IS THE KEY'S OWN INDENTATION AND `key` CARRIES NO PADDING. So a
 *  job-level `env:` (four spaces in) is `block(src, "env", 4)`, NOT
 *  `block(src, "    env", 4)` — the second spelling searches for an EIGHT-space
 *  `env:`, finds the first step that happens to have one, and then runs on past
 *  it collecting every following line indented deeper than four, which is most of
 *  the file. That is not hypothetical: it is how #245's first draft "found"
 *  `runner.temp` inside a job-level env block that does not contain it.
 *
 *  COMMENTS AND BLANKS ARE SKIPPED RATHER THAN RETURNED, and that was a real
 *  defect too: an earlier version pushed them, so a *comment* inside `on:` that
 *  happened to mention `"mobile/**"` satisfied the path-filter assertion in the
 *  iOS suite — and that block does carry comments explaining the filter. A test
 *  that a comment can satisfy is not a test. Scanning still continues through
 *  them, so a blank line does not end the block. */
export function block(src, key, indent = 0) {
  const lines = src.split(/\r?\n/);
  const pad = " ".repeat(indent);
  const start = lines.findIndex((l) => l.startsWith(`${pad}${key}:`));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].trimStart().startsWith("#")) continue;
    const lead = lines[i].length - lines[i].trimStart().length;
    if (lead <= indent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Every comment line in the file, unwrapped into one string.
 *
 *  Assertions about the header's PROSE have to read it this way: a claim like
 *  "minutes of wall clock per run" is wrapped across two `#` lines at 80 columns,
 *  so a naive regex over the raw file fails the moment someone reflows a
 *  paragraph — which is a documentation edit, not a behaviour change, and should
 *  not turn a suite red. */
export function prose(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => l.trimStart().startsWith("#"))
    .map((l) => l.trimStart().replace(/^#+\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** One step's YAML, by its `name:`. Used to assert per-step properties that a
 *  whole-file regex cannot see (a `continue-on-error` on the wrong step, say).
 *
 *  THE PREAMBLE IS NOT A STEP, and dropping it fixed a live false pass. Splitting
 *  on the step marker makes the first chunk everything BEFORE the first step —
 *  which in this repo is an 80-to-100-line header comment. So
 *  `step(wf, "actions/setup-java")` returned the header, because the header
 *  explains why `actions/setup-java` is used, and the caller then asserted
 *  `java-version: 21` against a block of prose. Exactly the failure mode
 *  `block()` above already records, one function along. */
export function step(src, nameFragment) {
  const chunks = src
    .split(/\n(?= {6}- (?:name|uses):)/)
    .filter((c) => /^\s*- (?:name|uses):/.test(c));
  return chunks.find((c) => c.includes(nameFragment)) ?? null;
}

/** The file with every FULL-LINE comment removed.
 *
 *  For NEGATIVE assertions — "this workflow contains no `paths-ignore`", "no step
 *  reads a secret", "the AGP intermediates path is not hardcoded". Those have the
 *  comment problem in the other direction from `block()`: a header that
 *  *explains why we do not do X* names X, so a whole-file regex reports the
 *  forbidden thing is present when only the argument against it is. Stripping the
 *  comments makes the assertion about the YAML that GitHub actually executes.
 *
 *  FULL-LINE ONLY, on purpose. A trailing comment after real YAML is left in
 *  place: cutting at the first `#` would corrupt any line with a `#` inside a
 *  quoted string, and this repo's workflows put their reasoning on its own lines. */
export function code(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

/** Every INVOCATION of one command in a workflow, as one line each.
 *
 *  Backslash continuations are joined first, and the match is anchored on the
 *  command as a COMMAND rather than as a substring — the first version of this
 *  (in the iOS suite, for `xcodebuild`) matched the filename
 *  `xcodebuild-simulator.log` and then asserted that a log path disabled code
 *  signing. The three accepted positions are: start of line, after a `;`/`&`/`|`,
 *  and after the `if ! ` this repo's build steps use to capture a log before
 *  failing. */
export function invocationsOf(src, cmd) {
  const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[;&|]\\s*|^if\\s+!\\s+)${esc}\\s`);
  return src
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => re.test(l));
}
