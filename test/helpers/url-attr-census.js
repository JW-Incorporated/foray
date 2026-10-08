/* The href/src census, shared by test/app-security.test.js (the whole client) and
 * test/tactile-find-typing.test.js (ui/search.js).
 *
 * It finds EVERY href/src written into a template literal or string whose value
 * holds an interpolation ANYWHERE, not only one that opens with it: the first
 * version matched `href="${` and so a `href="#/${esc(route)}"` walked past it,
 * which is how two un-guarded in-app links reached review. The whole attribute
 * value is read to its closing quote (braces balanced, so a ternary inside ${...}
 * that holds its own quotes is one value), and EVERY interpolation in it must name
 * safeUrl. A value with no interpolation (a literal "#/library") is not scanned:
 * there is nothing to inject.
 *
 *   interpolatedUrlAttrs(src)           [{ at, value, exprs }] one per attribute
 *   unguardedInterpolatedUrlAttrs(src)  the values (clipped) with an interpolation
 *                                       that does not name safeUrl(
 */
"use strict";

function interpolatedUrlAttrs(src) {
  const found = [];
  const open = /\b(?:href|src)\s*=\s*(?:(["'])|(?=\$\{))/g;
  let m;
  while ((m = open.exec(src))) {
    const quote = m[1] || null;
    let depth = 0, value = "", cur = "";
    const exprs = [];
    for (let i = open.lastIndex; i < src.length; i++) {
      const c = src[i];
      if (depth === 0) {
        if (quote && c === quote) break;
        if (c === "\n") break;
        if (c === "$" && src[i + 1] === "{") { depth = 1; cur = ""; value += "${"; i++; continue; }
        if (!quote) break;
        value += c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { exprs.push(cur); value += cur + "}"; if (!quote) break; continue; }
      }
      cur += c;
    }
    if (exprs.length) found.push({ at: m.index, value, exprs });
  }
  return found;
}

const unguardedInterpolatedUrlAttrs = (src) =>
  interpolatedUrlAttrs(src)
    .filter((a) => a.exprs.some((e) => !/\bsafeUrl\(/.test(e)))
    .map((a) => (a.value.length > 120 ? a.value.slice(0, 117) + "..." : a.value));

module.exports = { interpolatedUrlAttrs, unguardedInterpolatedUrlAttrs };
