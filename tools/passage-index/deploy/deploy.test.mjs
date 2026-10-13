/* GV-66 (W3-22, docs/roadmap/generation-v2.md): the retrieval deployment kit
 * for the DGX Spark, read statically.
 *
 * The units in this directory are copied onto the Spark by hand under D8
 * (merged PR plus the founder-moved spark-live tag), next to the R2 read key
 * and the retrieval token, so nothing exercises them before they run there.
 * This suite parses them and pins what the card and the GV-25 security review
 * ask for: every ExecStart path exists in the repo, the argv is one the real
 * CLIs accept, no secret is in the kit (the env example holds names only), the
 * server binds loopback only so the bearer token never crosses a network in
 * plain http, the nightly yields to SGLang, and the runbook names every live
 * step and who runs it. No systemd, no network, no backend/node_modules.
 *
 * Every test names the mutation that turns it red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_DB, parseNightlyArgs, REPO_ROOT as NIGHTLY_ROOT } from "../nightly.mjs";
import { EMBEDDER_KINDS } from "../embedder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const RUNBOOK = path.join(ROOT, "docs", "plans", "retrieval-on-spark.md");
const SERVER_SOURCE = path.join(ROOT, "backend", "src", "cli", "retrievalServer.ts");

const SERVER_UNIT = "foray-retrieval.service";
const NIGHTLY_UNIT = "foray-index-nightly.service";
const NIGHTLY_TIMER = "foray-index-nightly.timer";
const ENV_EXAMPLE = "retrieval.env.example";
const UNIT_FILES = [SERVER_UNIT, NIGHTLY_UNIT, NIGHTLY_TIMER];

/* Where the units put the checkout and the one writable directory. */
const CHECKOUT = "/opt/foray";
const DATA_DIR = "/var/lib/foray/retrieval";
const ENV_FILE = "/etc/foray/retrieval.env";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** A systemd unit file as {section: [[key, value], ...]}: comments and blank
 *  lines dropped, trailing-backslash continuations joined, keys in order. */
function parseUnit(text) {
  const sections = {};
  let current = null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i].trim()}`;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] ??= [];
      continue;
    }
    const eq = line.indexOf("=");
    assert.ok(current && eq > 0, `not a unit-file line: ${line}`);
    sections[current].push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return sections;
}

const unit = (name) => parseUnit(readFileSync(path.join(HERE, name), "utf8"));
const values = (u, section, key) => (u[section] ?? []).filter(([k]) => k === key).map(([, v]) => v);
const one = (u, section, key) => {
  const v = values(u, section, key);
  assert.equal(v.length, 1, `[${section}] ${key}= must appear exactly once, found ${v.length}`);
  return v[0];
};

/** ExecStart's argv: the systemd prefixes (- @ + ! :) dropped, split on
 *  whitespace with simple quoting. */
function execArgv(value) {
  const argv = [];
  for (const m of value.replace(/^[-@+!:]+/, "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(m[1] ?? m[2] ?? m[3]);
  return argv;
}
const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
};
const envPairs = (u) =>
  values(u, "Service", "Environment").flatMap((v) =>
    execArgv(v).map((a) => {
      const eq = a.indexOf("=");
      return [a.slice(0, eq), a.slice(eq + 1)];
    })
  );

/** An absolute path on the Spark, as the repo-relative path it stands for:
 *  /opt/foray/x -> x; anything else -> null. */
const repoRelative = (p) => (p.startsWith(`${CHECKOUT}/`) ? p.slice(CHECKOUT.length + 1) : null);

/* The secret scan: shapes of real credentials. A 32+ character run of key
   characters is the catch-all (R2 secrets are 64 hex, tokens from
   `openssl rand -hex 32` are 64 hex). */
const SECRET_SHAPES = [
  ["AWS-style access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["OpenAI/Anthropic-style key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["bearer value", /Bearer\s+(?!<|\$|\/)[A-Za-z0-9._~+/-]{16,}/],
  ["long key-shaped string", /(?<![A-Za-z0-9/._-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9/._-])/],
];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS(WORD)?|CREDENTIAL|AUTH|BEARER|SESSION|COOKIE/i;
const CREDENTIAL_DIRECTIVES = ["PassEnvironment", "LoadCredential", "LoadCredentialEncrypted", "SetCredential", "SetCredentialEncrypted", "ImportCredential"];

function secretFindings(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, re] of SECRET_SHAPES) if (re.test(line)) found.push(`line ${i + 1}: ${label}`);
  });
  return found;
}

/** The flags parseRetrievalServerArgs reads, from the server's own source:
 *  value flags (`value("--x")` and `--shows`) and boolean ones (`argv.includes`). */
function serverFlags() {
  const src = readFileSync(SERVER_SOURCE, "utf8");
  const start = src.indexOf("export function parseRetrievalServerArgs");
  assert.ok(start >= 0, "parseRetrievalServerArgs is gone from retrievalServer.ts");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const booleans = new Set([...body.matchAll(/argv\.includes\("(--[a-z0-9-]+)"\)/g)].map((m) => m[1]));
  const all = new Set([...body.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]));
  return { booleans, valued: new Set([...all].filter((f) => !booleans.has(f))) };
}

/** The runbook's "Live steps" table: [{step, who}]. */
function liveSteps(runbook) {
  const at = runbook.indexOf("### Live steps");
  assert.ok(at >= 0, "the runbook has no 'Live steps' table");
  const rows = [];
  for (const line of runbook.slice(at).split("\n").slice(1)) {
    if (line.startsWith("## ")) break;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !/^\d+$/.test(cells[1])) continue;
    rows.push({ step: cells[2], who: cells[3] });
  }
  return rows;
}

test("every ExecStart runs /usr/bin/node on a script that exists in the repo, from the checkout", () => {
  /* MUTATION: rename serve.mjs or nightly.mjs in an ExecStart (a typo the
     Spark would only show as a restart loop) -> red; run plain `node` (PATH
     differs under systemd) -> red; point --passages-db at /opt/foray/x where x
     is neither in the repo nor under data-local/ -> red; a Documentation= URL
     naming a file that is not in the repo -> red. */
  for (const name of [SERVER_UNIT, NIGHTLY_UNIT]) {
    const u = unit(name);
    const argv = execArgv(one(u, "Service", "ExecStart"));
    assert.equal(argv[0], "/usr/bin/node", `${name}: ExecStart must run /usr/bin/node`);
    assert.match(argv[1], /^tools\/passage-index\/[a-z-]+\.mjs$/, `${name}: ExecStart runs ${argv[1]}`);
    assert.ok(existsSync(path.join(ROOT, argv[1])), `${name}: ${argv[1]} is not in the repo`);
    assert.equal(one(u, "Service", "WorkingDirectory"), CHECKOUT);
    for (const arg of argv.slice(2)) {
      const rel = arg.startsWith("/") ? repoRelative(arg) : null;
      if (arg.startsWith("/")) assert.ok(rel !== null, `${name}: ${arg} is outside the checkout`);
      if (rel !== null) assert.ok(rel.startsWith("data-local/") || existsSync(path.join(ROOT, rel)), `${name}: ${arg} does not exist in the repo`);
    }
  }
  for (const name of UNIT_FILES) {
    for (const doc of values(unit(name), "Unit", "Documentation")) {
      const m = /^https:\/\/github\.com\/JW-Incorporated\/foray\/blob\/main\/(.+)$/.exec(doc);
      assert.ok(m, `${name}: Documentation=${doc} is not a repo link`);
      assert.ok(existsSync(path.join(ROOT, m[1])), `${name}: Documentation= names ${m[1]}, not in the repo`);
    }
  }
});

test("the secret scan: no unit, env example or runbook holds a key-shaped value", () => {
  /* The founder alone places secrets on the Spark (D8): the token and the R2
     read key live in files /etc/foray/retrieval.env names.
     MUTATION: paste a 64-hex token into the env example or the runbook -> red;
     add `Environment=FORAY_RETRIEVAL_TOKEN=abc` to a unit -> red; add
     `LoadCredential=` or a second EnvironmentFile= (say ~/.foray/r2.env) ->
     red; put `--token x` or `Authorization: Bearer <a real token>` in an
     ExecStart -> red. The scanner itself is checked against planted shapes,
     so a regex that matches nothing cannot pass. */
  for (const planted of ["AKIAABCDEFGHIJKLMNOP", "a".repeat(64), "-----BEGIN RSA PRIVATE KEY-----", "Authorization: Bearer abcdefghijklmnop1234", "sk-ant-abcdefghijklmnopqrst", "ghp_abcdefghijklmnopqrstuvwxyz"]) {
    assert.ok(secretFindings(planted).length > 0, `the scanner misses ${planted.slice(0, 12)}...`);
  }
  const files = [...readdirSync(HERE).filter((f) => f !== "deploy.test.mjs").map((f) => path.join(HERE, f)), RUNBOOK];
  for (const file of files) {
    assert.deepEqual(secretFindings(readFileSync(file, "utf8")), [], `${path.relative(ROOT, file)} holds a secret-shaped value`);
  }
  for (const name of UNIT_FILES) {
    const u = unit(name);
    for (const [section, pairs] of Object.entries(u)) {
      for (const [key, value] of pairs) {
        assert.ok(!CREDENTIAL_DIRECTIVES.includes(key), `${name} [${section}] ${key}= brings a credential into the unit`);
        if (key === "EnvironmentFile") assert.equal(value, ENV_FILE, `${name}: the only EnvironmentFile= is ${ENV_FILE}`);
        assert.ok(!/(^|\s)--(token|key|secret|password)\b/i.test(value), `${name}: ${key}= passes a secret on argv`);
      }
    }
    for (const [envName] of envPairs(u)) assert.ok(!SECRET_NAME.test(envName), `${name} sets ${envName}, which looks like a secret`);
  }
});

test("the env example holds names only, each one a variable the code reads", () => {
  /* MUTATION: give any line a value (`R2_CREDENTIALS_FILE=/etc/foray/r2.env`
     or a token) -> red; misspell a name (FORAY_RETRIEVAL_TOKN_FILE, which the
     server would silently ignore and then refuse its bind) -> red; drop
     FORAY_RETRIEVAL_TOKEN_FILE or R2_CREDENTIALS_FILE -> red. */
  const text = readFileSync(path.join(HERE, ENV_EXAMPLE), "utf8");
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=$/.exec(line);
    assert.ok(m, `${ENV_EXAMPLE}: not a bare NAME= line: ${line.replace(/=.*/, "=...")}`);
    names.push(m[1]);
  }
  for (const required of ["FORAY_RETRIEVAL_TOKEN_FILE", "R2_CREDENTIALS_FILE"]) assert.ok(names.includes(required), `${ENV_EXAMPLE} lacks ${required}`);
  const readers = [
    SERVER_SOURCE,
    path.join(ROOT, "tools", "passage-index", "nightly.mjs"),
    path.join(ROOT, "tools", "passage-index", "embedder.mjs"),
    path.join(ROOT, "tools", "foraycorpus-export", "config.mjs"),
  ].map((f) => readFileSync(f, "utf8"));
  for (const name of names) assert.ok(readers.some((src) => src.includes(`"${name}"`) || src.includes(`.${name}`)), `${name} is read by no server, nightly, embedder or R2 code`);
});

test("the server binds loopback only and every path it gets is absolute; its argv is one the server accepts", () => {
  /* GV-25 review: the bearer token must never travel in plain http to a
     non-loopback host. The unit binds 127.0.0.1; other boxes come in through
     TLS on the tailnet (tailscale serve).
     MUTATION: `--host 0.0.0.0` or `--host 192.168.0.72`, or drop --host
     (pinned explicitly so a default change cannot widen it) -> red; a relative
     --passages-db (serve.mjs starts the server with cwd backend/, so it would
     open backend/data-local/...) -> red; a flag parseRetrievalServerArgs does
     not read (`--cue-cache-size`) -> red; drop --r2 while keeping
     --cue-cache-gb (the server refuses) -> red; --embedder without
     --passages-db -> red; --embedder bogus -> red. */
  const argv = execArgv(one(unit(SERVER_UNIT), "Service", "ExecStart"));
  const args = argv.slice(2);
  const host = flagValue(args, "--host");
  assert.ok(host !== undefined, "the server unit must pass --host explicitly");
  assert.ok(LOOPBACK.has(host), `the server must bind loopback only, got --host ${host}`);
  const { booleans, valued } = serverFlags();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    assert.ok(flag.startsWith("--"), `stray argument ${flag}`);
    if (booleans.has(flag)) continue;
    assert.ok(valued.has(flag), `${flag} is not a flag parseRetrievalServerArgs reads`);
    const value = args[++i];
    assert.ok(value !== undefined && !value.startsWith("--"), `${flag} needs a value`);
    if (["--index-root", "--manifest", "--normalized-root", "--passages-db", "--cue-cache"].includes(flag)) {
      assert.ok(value.startsWith("/"), `${flag} ${value} must be absolute (the server runs with cwd backend/)`);
    }
  }
  assert.ok(args.includes("--r2"), "the card's server serves R2-only bodies (--r2)");
  assert.equal(Number(flagValue(args, "--cue-cache-gb")), 50);
  const embedder = flagValue(args, "--embedder");
  if (embedder !== undefined) {
    assert.ok(EMBEDDER_KINDS.includes(embedder), `--embedder ${embedder}`);
    assert.ok(flagValue(args, "--passages-db"), "--embedder needs --passages-db");
  }
});

test("the nightly argv is one nightly.mjs accepts, on the server's store and embedder, over loopback", () => {
  /* MUTATION: `--source r2-all` (nightly.mjs refuses it today; see the
     runbook's Known gaps) -> red; `--url http://192.168.0.72:7311` (the token
     on the LAN in plain http) -> red; an unknown flag -> red; a --db or
     --embedder that differs from the server's --passages-db / --embedder (the
     nightly would embed into a store the server never reads, or with a model
     the server cannot query) -> red. */
  const argv = execArgv(one(unit(NIGHTLY_UNIT), "Service", "ExecStart"));
  const parsed = parseNightlyArgs(argv.slice(2), {});
  const url = new URL(parsed.url);
  assert.equal(url.protocol, "http:");
  assert.ok(LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, "")), `the nightly must talk to the loopback server, got ${parsed.url}`);
  const serverArgs = execArgv(one(unit(SERVER_UNIT), "Service", "ExecStart")).slice(2);
  assert.equal(url.port, flagValue(serverArgs, "--port") ?? "7311", "the nightly reloads a different port from the one the server binds");
  const nightlyDb = flagValue(argv, "--db") ?? path.relative(NIGHTLY_ROOT, DEFAULT_DB).split(path.sep).join("/");
  const nightlyDbRel = nightlyDb.startsWith("/") ? repoRelative(nightlyDb) : nightlyDb;
  assert.equal(repoRelative(flagValue(serverArgs, "--passages-db")), nightlyDbRel, "server --passages-db and the nightly's --db differ");
  assert.equal(parsed.embedder, flagValue(serverArgs, "--embedder"), "server and nightly use different embedders");
});

test("the nightly yields to SGLang and the timer fires it at 03:30; both units are sandboxed system units", () => {
  /* OQ-07: the Spark is shared and the Qwen lane goes first.
     MUTATION: Nice=0, CPUQuota=800% or no CPUQuota=, no MemoryMax=, drop the
     idle I/O class -> red; Type=simple -> red; the timer at another time, or
     naming a unit not in this directory, or without Persistent= -> red; a
     ReadWritePaths= other than the data directory, or ProtectSystem= not
     strict (the checkout must stay read-only) -> red; the two services as
     different users (the nightly writes files the server reads) -> red. */
  const nightly = unit(NIGHTLY_UNIT);
  assert.equal(one(nightly, "Service", "Type"), "oneshot");
  assert.ok(Number(one(nightly, "Service", "Nice")) >= 10, "Nice= must be 10 or more");
  const quota = /^(\d+)%$/.exec(one(nightly, "Service", "CPUQuota"));
  assert.ok(quota && Number(quota[1]) > 0 && Number(quota[1]) <= 400, "CPUQuota= must be at most 400%");
  assert.equal(one(nightly, "Service", "IOSchedulingClass"), "idle");
  assert.match(one(nightly, "Service", "MemoryMax"), /^\d+[KMG]$/);
  assert.match(one(nightly, "Service", "TimeoutStartSec"), /^\d+h$/);

  const timer = unit(NIGHTLY_TIMER);
  assert.equal(one(timer, "Timer", "Unit"), NIGHTLY_UNIT);
  assert.ok(existsSync(path.join(HERE, one(timer, "Timer", "Unit"))));
  assert.equal(one(timer, "Timer", "OnCalendar"), "*-*-* 03:30:00");
  assert.equal(one(timer, "Timer", "Persistent"), "true");
  assert.equal(one(timer, "Install", "WantedBy"), "timers.target");

  const server = unit(SERVER_UNIT);
  assert.equal(one(server, "Service", "Type"), "simple");
  assert.match(one(server, "Service", "Restart"), /^(on-failure|always)$/);
  assert.match(one(server, "Service", "MemoryMax"), /^\d+[KMG]$/);
  assert.equal(one(server, "Install", "WantedBy"), "multi-user.target", "a system unit, so MemoryMax= and CPUQuota= are enforced");
  for (const u of [server, nightly]) {
    assert.equal(one(u, "Service", "User"), "foray");
    assert.equal(one(u, "Service", "Group"), "foray");
    assert.equal(one(u, "Service", "ProtectSystem"), "strict");
    assert.equal(one(u, "Service", "ReadWritePaths"), DATA_DIR);
    assert.equal(one(u, "Service", "NoNewPrivileges"), "yes");
  }
});

test("the runbook names every live step and who runs it, and never sends the token over plain http off the box", () => {
  /* MUTATION: drop the body-transfer step, the secrets step or the
     first-build step from the Live steps table, or leave a row's Who empty or
     to an agent other than the orchestrator -> red; delete a card section
     (the body transfer, the nightly timer, rollback, privacy ...) -> red;
     drop the rsync line, the first-build commands or a unit file's install
     line -> red; write `FORAY_RETRIEVAL_URL=http://192.168.0.72:7311` (the
     card's first draft) or `--host 0.0.0.0` anywhere -> red; name a tools/
     script that does not exist -> red. */
  const runbook = readFileSync(RUNBOOK, "utf8");
  const rows = liveSteps(runbook);
  assert.ok(rows.length >= 8, `only ${rows.length} live steps`);
  for (const { step, who } of rows) {
    assert.ok(who.length > 0, `live step "${step}" has no owner`);
    const owners = who.match(/\b(Founder|Joey|Orchestrator)\b/g) ?? [];
    assert.ok(owners.length > 0, `live step "${step}" names no owner among Founder, Joey, Orchestrator: ${who}`);
  }
  const steps = rows.map((r) => r.step).join("\n");
  for (const needle of [/Disk budget/, /Hermes/, /spark-live/, /Secrets/, /Body transfer/, /First build/, /\/healthz/, /nightly timer/, /FORAY_RETRIEVAL_URL/, /pull-archive/, /Rollback/]) {
    assert.match(steps, needle, `no live step matches ${needle}`);
  }
  for (const heading of ["What runs where", "Disk and RAM budget", "Body transfer", "First build", "The server unit", "The nightly timer", "Pointing generation at it", "/healthz checks", "Rollback", "Privacy", "Known gaps"]) {
    assert.ok(new RegExp(`^## ${heading.replace(/[/]/g, "\\/")}`, "m").test(runbook), `the runbook has no "## ${heading}" section`);
  }
  for (const needle of [
    "rsync",
    "corpus-digest.json",
    "--source local --full",
    "--source r2-all --full",
    "--resolve-legacy",
    "--from-staged",
    "--supply-report",
    "index-db.mjs ingest",
    "index-db.mjs embed",
    "/v1/shortlist/rebuild",
    "tailscale serve",
    "unset `FORAY_RETRIEVAL_URL`",
  ]) {
    assert.ok(runbook.includes(needle), `the runbook does not mention ${needle}`);
  }
  for (const name of UNIT_FILES) assert.ok(runbook.includes(`deploy/${name}`), `the runbook does not install ${name}`);
  assert.ok(runbook.includes(`deploy/${ENV_EXAMPLE}`), "the runbook does not place the env file");

  for (const m of runbook.matchAll(/http:\/\/([^/\s:`'"]+|\[[^\]]+\])/g)) {
    assert.ok(LOOPBACK.has(m[1].replace(/^\[|\]$/g, "")), `the runbook points a client at plain ${m[0]}: the token must not travel in plain http off the box`);
  }
  assert.ok(!/--host\s+(?!127\.0\.0\.1|::1|localhost)\S+/.test(runbook), "the runbook binds the server off loopback");
  for (const m of runbook.matchAll(/\btools\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|md|json|service|timer|example)\b/g)) {
    assert.ok(existsSync(path.join(ROOT, m[0])), `the runbook names ${m[0]}, which is not in the repo`);
  }
});
