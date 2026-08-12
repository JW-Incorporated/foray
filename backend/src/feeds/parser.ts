import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeDuration, type NormalizedDuration } from "./duration";
import { decodeEntities, sanitizeHtmlToText } from "./html";

export interface ParsedEpisode {
  guid: string | null;
  guidIsPermalink: boolean;
  title: string;
  descriptionHtml: string | null;
  descriptionText: string;
  enclosureUrl: string | null;
  enclosureLengthBytes: number | null;
  enclosureType: string | null;
  isVideo: boolean;
  duration: NormalizedDuration;
  publishedAt: string | null; // ISO 8601, null if unparseable
  publishedAtRaw: string | null;
  explicit: boolean | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  transcriptUrl: string | null;
  timedTranscriptUrl: string | null;
  timedTranscriptType: string | null;
  chaptersUrl: string | null;
  warnings: string[];
}

export interface ParsedFeed {
  title: string;
  descriptionText: string;
  link: string | null;
  language: string | null;
  image: string | null;
  explicit: boolean | null;
  newFeedUrl: string | null; // <itunes:new-feed-url> — corner case 4
  episodes: ParsedEpisode[];
  warnings: string[];
}

/**
 * Best-effort repair pass for the malformed-XML corner cases real feeds hit
 * (corner case 5): undeclared/bare ampersands, stray control characters,
 * a UTF-8 BOM. Does NOT attempt to fix mismatched tags — fast-xml-parser
 * itself is a lenient, non-validating parser and tolerates a fair amount of
 * that already.
 */
export function lenientXmlPreprocess(xml: string): string {
  let out = xml;

  // Strip UTF-8 BOM if present.
  if (out.charCodeAt(0) === 0xfeff) {
    out = out.slice(1);
  }

  // Escape bare ampersands that aren't already part of a recognized entity.
  out = out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");

  // Strip illegal XML control characters (keep tab \x09, newline \x0A, CR \x0D).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textOf(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node.trim();
  if (typeof node === "number") return String(node);
  if (isPlainObject(node)) {
    const t = node["#text"];
    if (typeof t === "string") return t.trim();
    if (typeof t === "number") return String(t);
  }
  return null;
}

function attrOf(node: unknown, attr: string): string | null {
  if (isPlainObject(node)) {
    const v = node[`@_${attr}`];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function firstOf<T>(v: T | T[] | undefined | null): T | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length > 0 ? (v[0] as T) : null;
  return v;
}

/**
 * Transcript formats that carry timestamps, in preference order. Only these
 * can anchor a segment boundary (ADR 0007) — `text/plain` and `text/html`
 * are prose with no timeline, which is why they are absent here even though
 * `text/plain` is the third most published format in the wild.
 */
const TIMED_TRANSCRIPT_TYPES = ["text/vtt", "application/srt", "application/x-subrip", "application/json"];

/**
 * Normalizes a `<podcast:transcript type="...">` value for comparison:
 * lowercased, trimmed, parameters dropped ("text/vtt; charset=utf-8" →
 * "text/vtt"). Returns null for a missing or non-string attribute, so a
 * malformed tag simply fails to match rather than throwing.
 */
function normalizeMimeType(raw: string | null): string | null {
  if (raw === null) return null;
  const base = raw.split(";")[0]?.trim().toLowerCase();
  return base ? base : null;
}

function parsePubDate(raw: string | null): { iso: string | null; warning?: string } {
  if (!raw) return { iso: null };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { iso: null, warning: `unparseable pubDate: "${raw}"` };
  }
  return { iso: d.toISOString() };
}

function parseExplicit(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["yes", "true", "explicit"].includes(v)) return true;
  if (["no", "false", "clean"].includes(v)) return false;
  return null; // treat as hint-missing, corner case 6
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (_name, jpath) =>
    typeof jpath === "string" &&
    [
      "rss.channel.item",
      "rss.channel.item.enclosure",
      "rss.channel.item.podcast:transcript",
      "rss.channel.item.itunes:category",
      "rss.channel.itunes:category"
    ].includes(jpath)
});

/**
 * Parses an RSS feed body (podcasting-2.0 aware) into a normalized shape.
 * Never throws on malformed input — worst case returns a feed with an empty
 * episode list and warnings explaining why.
 */
export function parseFeed(xmlBody: string): ParsedFeed {
  const warnings: string[] = [];
  const cleaned = lenientXmlPreprocess(xmlBody);

  const validation = XMLValidator.validate(cleaned);
  if (validation !== true) {
    warnings.push(`xml validation issue: ${validation.err?.msg ?? "unknown"} (proceeding leniently)`);
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(cleaned);
  } catch (err) {
    return {
      title: "",
      descriptionText: "",
      link: null,
      language: null,
      image: null,
      explicit: null,
      newFeedUrl: null,
      episodes: [],
      warnings: [`fatal parse error: ${(err as Error).message}`]
    };
  }

  const root = parsed as Record<string, unknown>;
  const rss = isPlainObject(root.rss) ? root.rss : undefined;
  const channel = rss && isPlainObject(rss.channel) ? rss.channel : undefined;

  if (!channel) {
    warnings.push("no <rss><channel> found");
    return {
      title: "",
      descriptionText: "",
      link: null,
      language: null,
      image: null,
      explicit: null,
      newFeedUrl: null,
      episodes: [],
      warnings
    };
  }

  const title = decodeEntities(textOf(channel.title) ?? "");
  const descriptionRaw = textOf(channel.description) ?? "";
  const link = textOf(channel.link);
  const language = textOf(channel.language);
  const explicit = parseExplicit(textOf(channel["itunes:explicit"]));
  const newFeedUrl = textOf(channel["itunes:new-feed-url"]);

  let image: string | null;
  if (isPlainObject(channel.image)) {
    image = textOf(channel.image.url) ?? attrOf(channel.image, "href");
  } else {
    image = attrOf(channel["itunes:image"], "href");
  }

  const rawItems = channel.item;
  const items: unknown[] = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  if (items.length === 0) {
    warnings.push("feed has zero <item> entries");
  }

  const episodes: ParsedEpisode[] = items.map((rawItem, idx) => parseItem(rawItem, idx));

  return {
    title,
    descriptionText: sanitizeHtmlToText(descriptionRaw),
    link,
    language,
    image,
    explicit,
    newFeedUrl,
    episodes,
    warnings
  };
}

function parseItem(rawItem: unknown, idx: number): ParsedEpisode {
  const warnings: string[] = [];
  const item = isPlainObject(rawItem) ? rawItem : {};

  const title = decodeEntities(textOf(item.title) ?? `(untitled item #${idx})`);
  if (textOf(item.title) === null) warnings.push("missing title");

  let guid: string | null = null;
  let guidIsPermalink = false;
  if (isPlainObject(item.guid)) {
    guid = textOf(item.guid);
    const isPermalinkAttr = attrOf(item.guid, "isPermaLink");
    guidIsPermalink = isPermalinkAttr !== "false"; // default true per RSS spec
  } else if (typeof item.guid === "string") {
    guid = item.guid.trim();
    guidIsPermalink = true;
  }
  if (!guid) warnings.push("missing guid — identity relies on composite key");

  const descriptionRaw =
    textOf(item["content:encoded"]) ?? textOf(item.description) ?? textOf(item.summary) ?? "";
  const descriptionText = sanitizeHtmlToText(descriptionRaw);

  // enclosure: normally singular; some malformed feeds emit multiple, take first.
  const enclosureRaw = firstOf(item.enclosure as unknown);
  const enclosureUrl = attrOf(enclosureRaw, "url");
  const enclosureLengthRaw = attrOf(enclosureRaw, "length");
  const enclosureLengthBytes =
    enclosureLengthRaw !== null && /^\d+$/.test(enclosureLengthRaw) ? parseInt(enclosureLengthRaw, 10) : null;
  if (enclosureLengthRaw === "0") warnings.push("enclosure length=0 (corner case 6)");
  const enclosureType = attrOf(enclosureRaw, "type");
  if (!enclosureUrl) warnings.push("missing enclosure url — item unplayable");

  const isVideo = enclosureType !== null && enclosureType.toLowerCase().startsWith("video/");
  if (isVideo) warnings.push('enclosure type is video/* in what is presumably an "audio" feed (corner case 6)');

  const durationRaw = textOf(item["itunes:duration"]);
  const duration = normalizeDuration(durationRaw);
  if (duration.seconds === null) {
    warnings.push(`duration unresolved: ${duration.reasonIfNull ?? "unknown"} (raw="${duration.raw ?? ""}")`);
  }

  const pubDateRaw = textOf(item.pubDate);
  const { iso: publishedAt, warning: pubWarning } = parsePubDate(pubDateRaw);
  if (pubWarning) warnings.push(pubWarning);

  const explicit = parseExplicit(textOf(item["itunes:explicit"]));

  const seasonRaw = textOf(item["itunes:season"]);
  const seasonNumber = seasonRaw !== null && /^\d+$/.test(seasonRaw) ? parseInt(seasonRaw, 10) : null;
  const episodeRaw = textOf(item["itunes:episode"]);
  const episodeNumber = episodeRaw !== null && /^\d+$/.test(episodeRaw) ? parseInt(episodeRaw, 10) : null;

  // podcasting-2.0 tags
  const transcriptsRaw = item["podcast:transcript"];
  const transcriptList: unknown[] = Array.isArray(transcriptsRaw)
    ? transcriptsRaw
    : transcriptsRaw
      ? [transcriptsRaw]
      : [];
  const preferredTranscript =
    transcriptList.find((t) => attrOf(t, "type") === "text/plain") ??
    transcriptList.find((t) => attrOf(t, "type") === "application/json") ??
    transcriptList[0] ??
    null;
  const transcriptUrl = preferredTranscript ? attrOf(preferredTranscript, "url") : null;

  // Second, independent pick for segmentation. `transcriptUrl` above prefers
  // text/plain because Tier-1 enrichment only asks "what is this episode
  // about"; a segment boundary needs a timeline, so it cannot reuse that
  // choice. Shows publish ~2.9 transcript tags each, so the two consumers
  // genuinely disagree often — hence a second field rather than a reorder.
  let timedTranscript: unknown = null;
  for (const type of TIMED_TRANSCRIPT_TYPES) {
    timedTranscript = transcriptList.find((t) => normalizeMimeType(attrOf(t, "type")) === type) ?? null;
    if (timedTranscript) break;
  }
  // A tag with no usable url is no better than no tag at all — report the pair
  // as absent rather than handing downstream a type it cannot fetch.
  const timedTranscriptUrl = timedTranscript ? attrOf(timedTranscript, "url") : null;
  const timedTranscriptType = timedTranscriptUrl ? normalizeMimeType(attrOf(timedTranscript, "type")) : null;

  const chaptersUrl = attrOf(item["podcast:chapters"], "url");

  return {
    guid,
    guidIsPermalink,
    title,
    descriptionHtml: descriptionRaw || null,
    descriptionText,
    enclosureUrl,
    enclosureLengthBytes,
    enclosureType,
    isVideo,
    duration,
    publishedAt,
    publishedAtRaw: pubDateRaw,
    explicit,
    seasonNumber,
    episodeNumber,
    transcriptUrl,
    timedTranscriptUrl,
    timedTranscriptType,
    chaptersUrl,
    warnings
  };
}
