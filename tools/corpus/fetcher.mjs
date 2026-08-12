/* Polite single-URL fetcher for the research corpus.
 *
 * Policy (docs/research/corpus/PLAN.md, Workstream A):
 * - Per-host serialization with >=2s spacing (or the host's robots
 *   Crawl-delay, whichever is larger). Requests to different hosts may
 *   interleave; requests to one host never do.
 * - robots.txt respected per host (cached for the process lifetime).
 * - Honest User-Agent naming the project and a contact address.
 * - Retries: up to 3 attempts on 429/5xx/network errors, exponential backoff
 *   with jitter, honoring a sane Retry-After.
 * - Redirects followed manually (max 5) so every hop gets the same rate
 *   limiting and an https-only guarantee; http:// targets are upgraded.
 * - Hard response-size cap: a research corpus fetch has no business pulling
 *   more than RESPONSE_CAP bytes (largest expected artifact is a court PDF).
 *
 * Everything is injectable (fetchImpl, sleep, now) so the test suite runs
 * fixture-only with zero network and zero real waiting.
 */

import { parseRobots } from "./robots.mjs";

export const USER_AGENT =
  "ForayCorpusBot/1.0 (+https://github.com/JW-Incorporated/foray; internal research corpus, one-shot fetches; contact: sffan15@gmail.com)";
export const AGENT_TOKEN = "ForayCorpusBot";

const DEFAULT_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const ATTEMPT_TIMEOUT_MS = 30_000;
const RESPONSE_CAP = 50 * 1024 * 1024; // 50MB
const MAX_RETRY_AFTER_S = 60;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFetcher({
  fetchImpl = globalThis.fetch,
  sleep = sleepReal,
  now = () => Date.now(),
  defaultDelayMs = DEFAULT_DELAY_MS,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  /* Optional cross-process gate (hostgate.mjs). The in-process limiter can't
   * see sibling area-ingestion processes; the gate can. */
  hostGate = null,
} = {}) {
  /* host -> { chain: Promise, nextAllowedAt: number, robots: parsed|null } */
  const hosts = new Map();

  function hostState(host) {
    let s = hosts.get(host);
    if (!s) {
      s = { chain: Promise.resolve(), nextAllowedAt: 0, robots: undefined };
      hosts.set(host, s);
    }
    return s;
  }

  /* Serialize work per host and enforce spacing between hits. */
  function withHostSlot(host, delayMs, fn) {
    const s = hostState(host);
    const run = s.chain.then(async () => {
      const wait = s.nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      if (hostGate) await hostGate.reserve(host, delayMs);
      try {
        return await fn();
      } finally {
        s.nextAllowedAt = now() + delayMs;
      }
    });
    // The chain must survive rejections or one failure poisons the host.
    s.chain = run.then(() => {}, () => {});
    return run;
  }

  async function rawGet(url, accept) {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(attemptTimeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: accept ?? "*/*",
      },
    });
    return res;
  }

  async function robotsFor(urlObj) {
    const s = hostState(urlObj.host);
    if (s.robots !== undefined) return s.robots;
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    try {
      const res = await withHostSlot(urlObj.host, defaultDelayMs, () =>
        rawGet(robotsUrl, "text/plain")
      );
      if (res.status >= 200 && res.status < 300) {
        const text = await res.text();
        s.robots = parseRobots(text, AGENT_TOKEN);
      } else {
        // 4xx: no robots → everything allowed. 5xx: can't know; we proceed
        // (single documented fetch, honest UA) but note it upstream.
        s.robots = null;
      }
    } catch {
      s.robots = null;
    }
    return s.robots;
  }

  function retryDelayMs(attempt, res) {
    const retryAfter = res?.headers?.get?.("retry-after");
    if (retryAfter) {
      const n = Number(retryAfter);
      if (Number.isFinite(n) && n >= 0 && n <= MAX_RETRY_AFTER_S) return n * 1000;
    }
    const base = [1000, 4000, 10_000][Math.min(attempt, 2)];
    return base + Math.floor(Math.random() * 500);
  }

  /**
   * Fetch one URL under the politeness policy.
   * Returns { ok, status, finalUrl, contentType, body (Buffer|null), notes[] }.
   * Never throws for HTTP-level failures — the caller records status and
   * moves on (dead-links policy). Throws only on programmer error.
   */
  async function fetchUrl(inputUrl) {
    const notes = [];
    let urlObj = new URL(inputUrl);
    if (urlObj.protocol === "http:") {
      urlObj.protocol = "https:";
      notes.push("upgraded http→https");
    }
    if (urlObj.protocol !== "https:") {
      return { ok: false, status: 0, finalUrl: urlObj.href, contentType: null, body: null, notes: [`unsupported protocol ${urlObj.protocol}`] };
    }

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const robots = await robotsFor(urlObj);
      if (robots && !robots.isAllowed(urlObj.pathname + urlObj.search)) {
        return { ok: false, status: -1, finalUrl: urlObj.href, contentType: null, body: null, notes: [...notes, "blocked by robots.txt"] };
      }
      const delayMs = Math.max(
        defaultDelayMs,
        (robots?.crawlDelay ?? 0) * 1000
      );

      let res = null;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          res = await withHostSlot(urlObj.host, delayMs, () =>
            rawGet(urlObj.href)
          );
          lastErr = null;
        } catch (err) {
          lastErr = err;
          res = null;
        }
        const retryable = lastErr !== null || res.status === 429 || res.status >= 500;
        if (!retryable) break;
        if (attempt < MAX_ATTEMPTS - 1) {
          const d = retryDelayMs(attempt, res);
          notes.push(`attempt ${attempt + 1} ${lastErr ? `error: ${lastErr.name ?? "fetch failed"}` : `status ${res.status}`}, retrying in ${Math.round(d / 1000)}s`);
          await sleep(d);
        }
      }

      if (lastErr !== null) {
        return { ok: false, status: 0, finalUrl: urlObj.href, contentType: null, body: null, notes: [...notes, `network failure after ${MAX_ATTEMPTS} attempts: ${lastErr.message ?? lastErr}`] };
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: null, body: null, notes: [...notes, "redirect without Location"] };
        }
        const next = new URL(loc, urlObj);
        if (next.protocol === "http:") {
          next.protocol = "https:";
          notes.push("redirect upgraded http→https");
        }
        if (next.protocol !== "https:") {
          return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: null, body: null, notes: [...notes, `refusing non-https redirect to ${next.protocol}`] };
        }
        notes.push(`redirect ${res.status} → ${next.href}`);
        urlObj = next;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: res.headers.get("content-type"), body: null, notes };
      }

      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > RESPONSE_CAP) {
        return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: res.headers.get("content-type"), body: null, notes: [...notes, `response ${len} bytes exceeds ${RESPONSE_CAP} cap`] };
      }
      // Enforce the cap WHILE streaming: content-length can be absent
      // (chunked) or a lie, and buffering-then-checking would already have
      // paid the memory cost the cap exists to prevent.
      let buf;
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        const parts = [];
        let total = 0;
        let overflow = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > RESPONSE_CAP) {
            overflow = true;
            await reader.cancel();
            break;
          }
          parts.push(value);
        }
        if (overflow) {
          return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: res.headers.get("content-type"), body: null, notes: [...notes, `response exceeded ${RESPONSE_CAP} cap mid-stream`] };
        }
        buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
      } else {
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > RESPONSE_CAP) {
          return { ok: false, status: res.status, finalUrl: urlObj.href, contentType: res.headers.get("content-type"), body: null, notes: [...notes, `response ${buf.length} bytes exceeds ${RESPONSE_CAP} cap`] };
        }
      }
      return {
        ok: true,
        status: res.status,
        finalUrl: urlObj.href,
        contentType: res.headers.get("content-type"),
        body: buf,
        notes,
      };
    }
    return { ok: false, status: 0, finalUrl: urlObj.href, contentType: null, body: null, notes: [...notes, `more than ${MAX_REDIRECTS} redirects`] };
  }

  return { fetchUrl };
}
