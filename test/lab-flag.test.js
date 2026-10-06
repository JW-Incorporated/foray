/* Lab builds never write to production (Redesign 2026, phase 0e).
 *
 * The "4a Lab" app carries `window.__FORAY_LAB__ = true` (tools/mobile/
 * lab-variant.mjs, injected by prepare-webdir.mjs). With it set, app.js must not
 * mint an anonymous Supabase user (/auth/v1/signup), refresh a token
 * (/auth/v1/token) or POST event rows (/rest/v1/events). Three layers, because
 * each is one `return` away from disappearing in a refactor:
 *
 *   1. sbAuth()               -- the one function every auth POST goes through
 *   2. ensureAnonSessionOnce() -- the sign-up / refresh decision
 *   3. syncEventsOnce()       -- the events POST loop
 *
 * HARNESS, AND WHY IT IS NOT MORE FORGIVING THAN THE REAL THING. Each function is
 * LIFTED out of the real app source and run in a vm context (the technique of
 * test/event-sync-mapping.test.js), and every layer is tested with the layers
 * beside it replaced by SPIES that record a call rather than refuse it, so a
 * missing gate in one layer cannot be hidden by the gate in the next. Each lab-on
 * test has a lab-off twin that proves the same fixture DOES reach the network
 * (otherwise "no fetch happened" would be vacuous: the fixture would be the only
 * reason). Reads are untouched, and are not under test here.
 *
 * MUTATIONS (each run red on its named test):
 *   - delete `if (isLabBuild()) return { ok: false, ... }` in sbAuth     -> test 1
 *   - delete `if (isLabBuild()) return null;` in ensureAnonSessionOnce   -> test 2
 *   - delete `if (isLabBuild()) return;` in syncEventsOnce               -> test 3
 *   - make isLabBuild() `return false`                                   -> 1, 2, 3
 *   - make isLabBuild() `return Boolean(window.__FORAY_LAB__)`           -> test 4 ("true" string)
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { readAppSource } = require("./helpers/app-source.js");

const SRC = readAppSource().replace(/\r\n/g, "\n");

function lift(re, what) {
  const m = re.exec(SRC);
  assert.ok(m, `${what} could not be located in the app source`);
  return m[0];
}
const IS_LAB_SRC = lift(/function isLabBuild\(\) \{[\s\S]*?\n\}/, "isLabBuild");
const SB_AUTH_SRC = lift(/async function sbAuth\(path, body\) \{[\s\S]*?\n\}/, "sbAuth");
const ENSURE_SRC = lift(/async function ensureAnonSessionOnce\(epoch\) \{[\s\S]*?\n\}/, "ensureAnonSessionOnce");
const SYNC_SRC = lift(/async function syncEventsOnce\(epoch\) \{[\s\S]*?\n\}/, "syncEventsOnce");
for (const [name, body] of [["isLabBuild", IS_LAB_SRC], ["sbAuth", SB_AUTH_SRC], ["ensureAnonSessionOnce", ENSURE_SRC], ["syncEventsOnce", SYNC_SRC]]) {
  assert.ok(!/\n(?:async )?function /.test(body), `the ${name} extraction ran into another function`);
}

const NOW = Math.floor(Date.now() / 1000);

/** A sandbox where `win.__FORAY_LAB__` is whatever the test sets and every
 *  collaborator is a recording stub. */
function sandbox({ lab, session = null }) {
  const calls = { fetch: [], sbAuth: [], ensure: 0, markSynced: 0 };
  const store = { cp_sb_session: session };
  const win = {
    forayEventLog: {
      unsynced: async () => [{ id: 1, ts: "2026-10-05T00:00:00.000Z", type: "saved", payload: { episode_id: "ep-1", topics: [] } }],
      markSynced: async () => { calls.markSynced++; },
      pruneToRetention: async () => {},
    },
  };
  if (lab !== undefined) win.__FORAY_LAB__ = lab;
  const ctx = vm.createContext({
    window: win,
    SB_URL: "https://sb.invalid",
    SB_KEY: "k",
    JSON, Math, Date, Boolean, Number, Promise, Error,
    fetch: async (url, init) => { calls.fetch.push({ url, method: init && init.method }); return { ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", user: { id: "u" } }) }; },
    syncOutlived: () => false,
    sessionKeepable: () => true,
    lsGet: (k, d) => (store[k] === undefined || store[k] === null ? d : store[k]),
    lsSet: (k, v) => { store[k] = v; },
    refreshTokenDead: () => true,
    sbAuth: async (path) => { calls.sbAuth.push(path); return { ok: true, status: 200, body: { access_token: "at", refresh_token: "rt", user: { id: "u" } } }; },
    ensureAnonSession: async () => { calls.ensure++; return { user_id: "u", access_token: "at" }; },
    toEventRow: (e, uid) => ({ user_id: uid, ts: e.ts, type: e.type, archetype: null, payload: {} }),
    flushBufferedEvents: () => {},
    dataDeletionInProgress: false,
    localClears: 0,
  });
  return { ctx, calls, run: (src, expr) => vm.runInContext(`${src}\n${expr}`, ctx) };
}

const EXPIRED = { access_token: "old", refresh_token: "rt-old", user_id: "u", expires_at: NOW - 1000 };

test("1. sbAuth: in a lab build no auth request leaves the device; in the real build it does", async () => {
  const lab = sandbox({ lab: true });
  const r = await lab.run(`${IS_LAB_SRC}\n${SB_AUTH_SRC}`, 'sbAuth("/auth/v1/signup", {})');
  assert.deepStrictEqual({ ok: r.ok, status: r.status, body: r.body }, { ok: false, status: 0, body: null });
  assert.strictEqual(lab.calls.fetch.length, 0, "a lab build called the auth endpoint");

  const real = sandbox({ lab: undefined });
  const r2 = await real.run(`${IS_LAB_SRC}\n${SB_AUTH_SRC}`, 'sbAuth("/auth/v1/signup", {})');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(real.calls.fetch.length, 1, "the twin fixture never reached the network, so the lab-on result above proves nothing");
  assert.match(real.calls.fetch[0].url, /\/auth\/v1\/signup$/);
});

test("2. ensureAnonSessionOnce: a lab build neither signs up nor refreshes, with or without a stored session", async () => {
  for (const [label, session] of [["no stored session (would sign up)", null], ["expired session (would refresh)", EXPIRED]]) {
    const lab = sandbox({ lab: true, session });
    const s = await lab.run(`${IS_LAB_SRC}\n${ENSURE_SRC}`, "ensureAnonSessionOnce(0)");
    assert.strictEqual(s, null, `${label}: a lab build produced a session`);
    assert.deepStrictEqual(lab.calls.sbAuth, [], `${label}: a lab build reached the auth layer`);
  }
  /* twins: the same two fixtures DO reach the auth layer in the real build */
  const signup = sandbox({ lab: false, session: null });
  assert.ok(await signup.run(`${IS_LAB_SRC}\n${ENSURE_SRC}`, "ensureAnonSessionOnce(0)"));
  assert.deepStrictEqual(signup.calls.sbAuth, ["/auth/v1/signup"]);
  const refresh = sandbox({ lab: false, session: EXPIRED });
  assert.ok(await refresh.run(`${IS_LAB_SRC}\n${ENSURE_SRC}`, "ensureAnonSessionOnce(0)"));
  assert.match(refresh.calls.sbAuth[0], /grant_type=refresh_token/);
});

test("3. syncEventsOnce: a lab build POSTs no events, asks for no session, and marks nothing synced", async () => {
  const lab = sandbox({ lab: true });
  await lab.run(`${IS_LAB_SRC}\n${SYNC_SRC}`, "syncEventsOnce(0)");
  assert.strictEqual(lab.calls.fetch.length, 0, "a lab build POSTed events");
  assert.strictEqual(lab.calls.ensure, 0, "a lab build asked for a session");
  assert.strictEqual(lab.calls.markSynced, 0, "a lab build marked its local rows as synced");

  const real = sandbox({ lab: undefined });
  await real.run(`${IS_LAB_SRC}\n${SYNC_SRC}`, "syncEventsOnce(0)");
  assert.strictEqual(real.calls.fetch.length, 1, "the twin fixture never POSTed, so the lab-on result proves nothing");
  assert.match(real.calls.fetch[0].url, /\/rest\/v1\/events$/);
  assert.strictEqual(real.calls.fetch[0].method, "POST");
  assert.strictEqual(real.calls.markSynced, 1);
});

test("4. only the boolean true turns the lab on: the web, the real app and a stray string do not", () => {
  const isLab = (win) => vm.runInNewContext(`${IS_LAB_SRC}\nisLabBuild()`, { window: win });
  assert.strictEqual(isLab({}), false, "the real app and the web never set the flag");
  assert.strictEqual(isLab({ __FORAY_LAB__: false }), false);
  assert.strictEqual(isLab({ __FORAY_LAB__: "true" }), false, "a truthy string must not switch off the real app's sync");
  assert.strictEqual(isLab({ __FORAY_LAB__: 1 }), false);
  assert.strictEqual(isLab({ __FORAY_LAB__: true }), true);
});

test("5. the real app's source never sets the flag (only the lab bundle's injected script does)", () => {
  /* MUTATION: add `window.__FORAY_LAB__ = true;` anywhere in app.js or ui/ -> red.
     The one writer is tools/mobile/lab-variant.mjs's generated foray-lab.js. */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  const writes = code.match(/__FORAY_LAB__\s*=[^=]/g) || [];
  assert.deepStrictEqual(writes, [], "app source assigns the lab flag; the real build would stop syncing");
});
