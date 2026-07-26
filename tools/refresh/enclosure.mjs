/* Audio provenance helpers — shared by scan.mjs and backfill-audio.mjs.

   Codified in one place (CLAUDE.md rule 6) because the RSS enclosure is the
   authoritative source of a playable URL and both the nightly path and the
   one-shot backfill must read it identically. If these two ever disagree,
   the nightly starts producing items the backfill would have handled
   differently, and the difference is invisible until playback fails.

   Field contract produced here (issue #21, epic #20 §4 L1):
     audio_url    original, PRE-redirect enclosure URL. Corner case #1:
                  publishers count downloads at the prefix host, so we never
                  substitute the resolved CDN URL.
     audio_type   enclosure MIME type; used to skip video-only items (#6)
     audio_bytes  enclosure length; download progress + LRU accounting (#29).
                  length="0" is common and means "unknown" -> null.
     duration_sec exact seconds for the scrubber. duration_min stays as-is;
                  copy and fit-lines depend on it.
*/

/** fast-xml-parser gives `{"@_url":…}`, or an array when a malformed feed
    repeats the tag. Take the first audio enclosure, else the first at all. */
export function pickEnclosure(item) {
  let enc = item?.enclosure;
  if (!enc) return { url: null, type: null, bytes: null };
  if (Array.isArray(enc)) {
    enc = enc.find((e) => /^audio\//i.test(String(e?.["@_type"] || ""))) || enc[0];
  }
  const url = enc?.["@_url"] ? String(enc["@_url"]).trim() : null;
  const type = enc?.["@_type"] ? String(enc["@_type"]).trim() : null;
  const rawLen = enc?.["@_length"];
  const bytes = rawLen != null && /^\d+$/.test(String(rawLen).trim())
    ? Number(String(rawLen).trim())
    : null;
  return { url, type, bytes: bytes && bytes > 0 ? bytes : null };
}

/** itunes:duration is wildly inconsistent (corner case #5): HH:MM:SS, MM:SS,
    bare seconds, or garbage. Returns whole seconds, or null when unrecoverable. */
export function durationSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  return null;
}

/** Corner case #6: feeds declare video enclosures in nominally-audio feeds.
    Default policy is to skip video-only items rather than pay the transcode
    or battery cost. A null/absent type is treated as playable — plenty of
    feeds omit it, and the player degrades on its own if it turns out not to be. */
export function isPlayableType(type) {
  if (!type) return true;
  return /^audio\//i.test(type);
}

/* Corner case #9: private/premium feeds carry a bearer token IN the URL. Such
   a URL is a secret and must never land in a public data/*.json. Deliberately
   conservative — many legitimate enclosures carry tracking query params, and
   a false positive silently makes an episode unplayable. We match only param
   names that unambiguously denote credentials. */
const TOKEN_PARAM = /(^|[?&])(token|auth|authorization|api_?key|secret|password|passwd|session|user_?id|subscriber)=/i;

export function looksTokened(url) {
  if (!url) return false;
  const q = url.indexOf("?");
  return q >= 0 && TOKEN_PARAM.test(url.slice(q));
}

/** Everything the pipeline needs from one RSS <item>, or nulls. `reason` is
    set when a URL was deliberately rejected, so callers can log it. */
export function audioFieldsFrom(item) {
  const { url, type, bytes } = pickEnclosure(item);
  const duration_sec = durationSeconds(item?.["itunes:duration"]);

  if (!url) return { audio_url: null, audio_type: type, audio_bytes: bytes, duration_sec, reason: "no enclosure" };
  // https ONLY, not http. A cleartext enclosure is unplayable in the shipped
  // app regardless — iOS App Transport Security and Android's default
  // cleartext-traffic policy both block it, and #24's CSP is `media-src
  // https:`. Rejecting here keeps the data honest instead of publishing a URL
  // that fails at playback time; it also keeps this helper consistent with the
  // CI gate, which fails the build on a non-https audio_url.
  if (!/^https:\/\//i.test(url)) {
    const scheme = (url.split(":")[0] || "?").toLowerCase();
    return { audio_url: null, audio_type: type, audio_bytes: bytes, duration_sec, reason: `non-https enclosure (${scheme})` };
  }
  if (looksTokened(url)) return { audio_url: null, audio_type: type, audio_bytes: bytes, duration_sec, reason: "tokened URL withheld" };
  if (!isPlayableType(type)) return { audio_url: null, audio_type: type, audio_bytes: bytes, duration_sec, reason: `non-audio type ${type}` };

  return { audio_url: url, audio_type: type, audio_bytes: bytes, duration_sec, reason: null };
}

/** Host comparison for the RSS-vs-iTunes disagreement counter. Not an error —
    the two sources genuinely differ (measured: content.blubrry vs ins.blubrry
    for the same episode) and RSS wins, but the rate is worth watching. */
export function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (_) { return null; }
}
