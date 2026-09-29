import { describe, it, expect } from "vitest";
import { decodeEntities, sanitizeHtmlToText } from "../src/feeds/html";

describe("sanitizeHtmlToText", () => {
  it("returns empty string for null/undefined", () => {
    expect(sanitizeHtmlToText(null)).toBe("");
    expect(sanitizeHtmlToText(undefined)).toBe("");
  });

  it("strips paragraph tags and preserves line breaks", () => {
    const out = sanitizeHtmlToText("<p>First</p><p>Second</p>");
    expect(out).toContain("First");
    expect(out).toContain("Second");
    expect(out).not.toContain("<p>");
  });

  it("strips tracking pixel img tags entirely", () => {
    const out = sanitizeHtmlToText('Hello <img src="https://track.example.com/pixel.gif"/> world');
    expect(out).not.toContain("img");
    expect(out).not.toContain("track.example.com");
    expect(out).toContain("Hello");
    expect(out).toContain("world");
  });

  it("removes script and style blocks entirely, including their content", () => {
    const out = sanitizeHtmlToText("<style>.x{color:red}</style>Visible<script>alert(1)</script>");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("Visible");
  });

  it("decodes common HTML entities", () => {
    const out = sanitizeHtmlToText("Fish &amp; Chips &mdash; &lsquo;great&rsquo;");
    expect(out).toBe("Fish & Chips — ‘great’");
  });

  it("decodes numeric entities", () => {
    expect(sanitizeHtmlToText("&#65;&#66;&#x43;")).toBe("ABC");
  });

  it("collapses excess whitespace", () => {
    const out = sanitizeHtmlToText("Hello    world\n\n\n\nagain");
    expect(out).not.toMatch(/ {2,}/);
  });

  it("handles plain text with no HTML unchanged (aside from trimming)", () => {
    expect(sanitizeHtmlToText("  Just plain text  ")).toBe("Just plain text");
  });
});

/* Round-3 audit, lane L6 (backend-rest-1 / -9 / -11): one never-throwing,
   range-checked, prototype-safe entity decoder. */
describe("decodeEntities hardening (round 3)", () => {
  it("never throws on an out-of-range numeric reference; it becomes U+FFFD (backend-rest-1)", () => {
    expect(() => decodeEntities("Bad &#99999999; title")).not.toThrow();
    expect(decodeEntities("Bad &#99999999; title")).toBe("Bad \uFFFD title");
    expect(decodeEntities("x&#x110000;y")).toBe("x\uFFFDy");
    expect(decodeEntities("lone &#xD800; surrogate")).toBe("lone \uFFFD surrogate");
    expect(() => sanitizeHtmlToText("<p>&#99999999;</p>")).not.toThrow();
  });

  it("still decodes every valid reference, including the top of the range", () => {
    expect(decodeEntities("&#038; &#x26; &#x10FFFF; &#9; &#10;")).toBe("& & \u{10FFFF} \t \n");
  });

  it("drops NUL and C0 controls other than tab/LF/CR (backend-rest-9: Postgres rejects 0x00)", () => {
    expect(decodeEntities("a&#0;b&#x0;c&#1;d&#x1F;e")).toBe("abcde");
    expect(sanitizeHtmlToText("a&#0;b")).toBe("ab");
    expect(sanitizeHtmlToText("raw\u0000nul")).toBe("rawnul");
    expect(sanitizeHtmlToText("a&#0;b")).not.toContain("\u0000");
  });

  it("looks named entities up as own properties only (backend-rest-11)", () => {
    expect(decodeEntities("x &constructor; y")).toBe("x &constructor; y");
    expect(decodeEntities("&toString; &valueOf; &__proto__;")).toBe("&toString; &valueOf; &__proto__;");
    expect(sanitizeHtmlToText("x &constructor; y")).toBe("x &constructor; y");
    expect(decodeEntities("&amp; &mdash;")).toBe("& \u2014");
  });
});
