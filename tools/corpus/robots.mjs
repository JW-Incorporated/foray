/* Minimal robots.txt model for the corpus fetcher.
 *
 * Scope: we fetch ~57 known documentation/paper/blog URLs once each. This is
 * not a crawler, but we still honor robots.txt because the dossier includes
 * hosts (publishers, courts, standards bodies) whose goodwill matters to
 * Foray ("legally boring" product principle applies to our tooling too).
 *
 * Semantics implemented (the subset that matters for single-URL fetches):
 * - Group selection: the group whose User-agent token is the longest match
 *   for our agent token wins; `*` is the fallback group.
 * - Allow/Disallow longest-path-match wins; on a tie Allow wins.
 * - `*` wildcards and `$` end-anchors in paths (Google/RFC 9309 style).
 * - Crawl-delay: parsed and surfaced so the rate limiter can take
 *   max(defaultDelay, crawlDelay).
 * - An empty Disallow line means "allow everything" (per the original spec).
 */

function patternToRegex(pattern) {
  // Escape regex chars except our two metacharacters, then translate.
  const escaped = pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/\*/g, ".*");
  const anchored = translated.endsWith("$")
    ? `^${translated.slice(0, -1)}$`
    : `^${translated}`;
  return new RegExp(anchored);
}

export function parseRobots(text, agentToken) {
  const token = agentToken.toLowerCase();
  /* groups: [{ agents: [..], rules: [{type, pattern}], crawlDelay }] */
  const groups = [];
  let current = null;
  let sawRuleInGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; a User-agent line
      // after rules starts a new group.
      if (!current || sawRuleInGroup) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        sawRuleInGroup = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current) {
      if (field === "disallow" || field === "allow") {
        sawRuleInGroup = true;
        if (value === "" && field === "disallow") continue; // empty = allow all
        current.rules.push({ type: field, pattern: value, regex: patternToRegex(value) });
      } else if (field === "crawl-delay") {
        sawRuleInGroup = true;
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
    }
  }

  // Pick the group with the longest agent token that our token contains.
  let best = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === "*") {
        if (bestLen < 0) { best = g; bestLen = 0; }
      } else if (token.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }

  return {
    isAllowed(path) {
      if (!best) return true;
      let winner = null;
      let winnerLen = -1;
      for (const rule of best.rules) {
        if (rule.regex.test(path)) {
          const len = rule.pattern.length;
          // Longest match wins; tie → Allow wins.
          if (len > winnerLen || (len === winnerLen && rule.type === "allow")) {
            winner = rule;
            winnerLen = len;
          }
        }
      }
      return !winner || winner.type === "allow";
    },
    crawlDelay: best ? best.crawlDelay : null,
  };
}
