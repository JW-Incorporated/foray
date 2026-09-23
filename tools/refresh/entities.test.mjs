/* tools/refresh/entities.mjs — the one place feed entities are decoded.
 *
 * Each test names the mutation that turns it red. The data-side half (no
 * entity survives in data/*.json) is test/data-entities.test.js, which reads
 * ENTITY_RE from the same module so the two cannot disagree about what an
 * entity is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, hasEntity, ENTITY_RE } from "./entities.mjs";

test("the three shapes the catalogue actually carried decode to their characters", () => {
  /* MUTATION: drop the `#(\d{1,7})` branch of ENTITY_RE -> "&#038;" survives. */
  assert.equal(decodeEntities("Vibe Coding &#038; Linux"), "Vibe Coding & Linux");
  assert.equal(decodeEntities("Fedor &#038; Football"), "Fedor & Football");
  assert.equal(decodeEntities("Kola: The World&#39;s Deepest Hole"), "Kola: The World's Deepest Hole");
  assert.equal(decodeEntities("it&rsquo;s here &mdash; now"), "it’s here — now");
  assert.equal(decodeEntities("&#8217;&#8220;&#8221;&#8211;"), "’“”–");
  assert.equal(decodeEntities("&#x26; &#X41;"), "& A");
  assert.equal(decodeEntities("Caf&eacute; &Iacute;"), "Café Í");
});

test("a double-encoded entity decodes all the way down", () => {
  /* MUTATION: run the replace once instead of to a fixed point -> "&#038;". */
  assert.equal(decodeEntities("Grant &amp;#038; Lee"), "Grant & Lee");
  assert.equal(decodeEntities("&amp;amp;"), "&");
});

test("a control-character entity becomes a space, never a raw CR/LF", () => {
  /* MUTATION: return String.fromCodePoint(n) for n < 0x20 -> "\r" in a blurb. */
  assert.equal(decodeEntities("line one&#13;&#10;line two"), "line one  line two");
  assert.doesNotMatch(decodeEntities("a&#13;b"), /[\r\n]/);
});

test("text that is not an entity is left exactly as it was", () => {
  /* MUTATION: decode `&[a-z]+;` generically -> "&fooBar;" is eaten. */
  for (const s of ["AT&T", "R&D and &c.", "a & b", "&unknownname;", "&#;", "&#xZZ;", "100% & rising", ""]) {
    assert.equal(decodeEntities(s), s);
  }
  assert.equal(decodeEntities(null), null);
  assert.equal(decodeEntities(undefined), undefined);
  assert.equal(decodeEntities("&#1114112;"), "&#1114112;", "beyond U+10FFFF is not a code point");
  assert.equal(decodeEntities("&#55296;"), "&#55296;", "a lone surrogate is not a code point");
});

test("hasEntity and ENTITY_RE agree with the decoder on what counts", () => {
  /* MUTATION: make hasEntity a fixed `false` -> the data test can never fail. */
  assert.equal(hasEntity("Vibe Coding &#038; Linux"), true);
  assert.equal(hasEntity("it&rsquo;s"), true);
  assert.equal(hasEntity("AT&T"), false);
  assert.equal(hasEntity(null), false);
  assert.ok(ENTITY_RE.global, "the data test scans whole files with it");
  for (const s of ["&amp;", "&#39;", "&#x27;", "&rsquo;", "&Iacute;"]) {
    assert.notEqual(decodeEntities(s), s, `${s} is decoded`);
    assert.equal(hasEntity(s), true, `${s} is detected`);
  }
});
