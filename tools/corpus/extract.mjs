/* Content extraction: raw fetched bytes → clean markdown.
 *
 * Every source stores BOTH the raw artifact and the extracted markdown
 * (PLAN.md Workstream A). This module owns the second half and the
 * site-specific routing that decides what the primary artifact even is:
 *
 * - arXiv /abs/ pages → the PDF is the primary artifact (paper text beats
 *   abstract-page chrome for retrieval).
 * - GitHub repo root → raw README via raw.githubusercontent.com (rendered
 *   pages are a React shell; the README **is** the document).
 * - GitHub issues → the REST API: title + body + comments are already
 *   markdown, which beats any HTML scrape of the same page.
 * - *.pdf / application/pdf → text extraction via pdfjs.
 * - everything else → Readability article extraction with a whole-body
 *   fallback, then turndown(+gfm) to markdown.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import turndownPluginGfm from "turndown-plugin-gfm";

/* ---------------------------------------------------------------- routing */

/**
 * Decide how a source URL should be fetched/extracted.
 * Returns { kind, fetchUrl, apiUrls? } — fetchUrl may differ from the
 * source URL when a better primary artifact exists.
 */
export function routeUrl(url) {
  const u = new URL(url);

  const arxivAbs = u.hostname === "arxiv.org" && /^\/abs\//.test(u.pathname);
  if (arxivAbs) {
    const id = u.pathname.replace(/^\/abs\//, "").replace(/\/$/, "");
    return { kind: "pdf", fetchUrl: `https://arxiv.org/pdf/${id}`, note: "arXiv abs→pdf" };
  }
  if (u.hostname === "arxiv.org" && /^\/(pdf|html)\//.test(u.pathname)) {
    return u.pathname.startsWith("/pdf/")
      ? { kind: "pdf", fetchUrl: u.href }
      : { kind: "html", fetchUrl: u.href };
  }

  if (u.hostname === "github.com") {
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return {
        kind: "github-readme",
        fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
        note: "github repo→raw README",
      };
    }
    if (parts.length === 4 && parts[2] === "issues" && /^\d+$/.test(parts[3])) {
      const [owner, repo, , num] = parts;
      return {
        kind: "github-issue",
        fetchUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
        commentsUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${num}/comments`,
        note: "github issue→REST API",
      };
    }
  }

  if (/\.pdf($|[?#])/i.test(u.pathname)) return { kind: "pdf", fetchUrl: u.href };
  return { kind: "html", fetchUrl: u.href };
}

/* ------------------------------------------------------------------ html */

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(turndownPluginGfm.gfm);
  td.remove(["script", "style", "noscript"]);
  return td;
}

/**
 * HTML bytes → { title, markdown, notes[] }.
 * Readability first; if it declines or produces something suspiciously thin,
 * fall back to the stripped <body> so we never store an empty document for a
 * page that had real content outside <article> heuristics.
 */
export function htmlToMarkdown(html, url) {
  const notes = [];
  // linkedom returns a document without documentElement for fragment/plain
  // input, which crashes Readability — wrap anything that isn't a full page.
  const looksLikeDoc = /<html[\s>]/i.test(html.slice(0, 2000));
  const { document } = parseHTML(looksLikeDoc ? html : `<html><body>${html}</body></html>`);
  const title =
    document.querySelector("title")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    "";

  let contentHtml = null;
  try {
    const article = new Readability(document.cloneNode(true), { charThreshold: 250 }).parse();
    if (article?.content && (article.textContent ?? "").trim().length >= 500) {
      contentHtml = article.content;
      notes.push("readability");
    }
  } catch {
    /* fall through to body */
  }

  if (!contentHtml) {
    const { document: doc2 } = parseHTML(html);
    for (const sel of ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "iframe", "svg"]) {
      for (const el of [...doc2.querySelectorAll(sel)]) el.remove();
    }
    contentHtml = doc2.body ? doc2.body.innerHTML : html;
    notes.push("body-fallback");
  }

  let markdown = makeTurndown().turndown(contentHtml);
  markdown = markdown.replace(/\n{4,}/g, "\n\n\n").trim();
  if (markdown.length < 200) notes.push(`thin extraction (${markdown.length} chars) — page may be JS-rendered`);
  return { title, markdown, notes };
}

/* ------------------------------------------------------------------- pdf */

/**
 * PDF bytes → { title, markdown, notes[] }.
 * pdfjs text items are positioned fragments, not a text flow; we join items
 * with spaces, break lines on Y-position changes, and separate pages. That
 * loses columns/tables but preserves the retrievable prose, which is what
 * the corpus needs (raw PDF stays on disk for anything finer).
 */
export async function pdfToMarkdown(buffer, { maxPages = 200 } = {}) {
  const notes = [];
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, maxPages);
  if (doc.numPages > maxPages) notes.push(`truncated at ${maxPages}/${doc.numPages} pages`);

  const out = [];
  let title = "";
  try {
    const meta = await doc.getMetadata();
    title = (meta?.info?.Title ?? "").trim();
  } catch { /* metadata is optional */ }

  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    let line = [];
    const lines = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join(" "));
        line = [];
      }
      if (item.str.trim() !== "") line.push(item.str.trim());
      if (y !== null) lastY = y;
    }
    if (line.length) lines.push(line.join(" "));
    out.push(lines.join("\n").replace(/[ \t]{2,}/g, " ").trim());
  }
  await doc.destroy();

  const markdown = out
    .filter((p) => p.length > 0)
    .join("\n\n---\n\n")
    .trim();
  if (!markdown) notes.push("no extractable text (scanned/image-only pdf?)");
  return { title, markdown, notes };
}

/* ---------------------------------------------------------------- github */

/** GitHub issue JSON (+ comments JSON) → markdown document. */
export function issueToMarkdown(issue, comments = []) {
  const parts = [
    `# ${issue.title} (#${issue.number})`,
    ``,
    `- State: ${issue.state} · opened by ${issue.user?.login ?? "unknown"} on ${(issue.created_at ?? "").slice(0, 10)}`,
    `- URL: ${issue.html_url}`,
    ``,
    issue.body ?? "",
  ];
  for (const c of comments) {
    parts.push(
      ``,
      `---`,
      ``,
      `**${c.user?.login ?? "unknown"}** (${(c.created_at ?? "").slice(0, 10)}):`,
      ``,
      c.body ?? ""
    );
  }
  return { title: `${issue.title} (#${issue.number})`, markdown: parts.join("\n").trim(), notes: ["github-issue-api"] };
}

/* Content-type says PDF even when the URL didn't. */
export function looksLikePdf(contentType, body) {
  if (contentType?.includes("application/pdf")) return true;
  return body?.subarray(0, 5).toString("latin1") === "%PDF-";
}
