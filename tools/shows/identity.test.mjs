import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFeedUrl } from "./identity.mjs";

test("normalizeFeedUrl: scheme, case and trailing slash all collapse", () => {
  const variants = [
    "https://Feeds.Example.com/show/",
    "http://feeds.example.com/show",
    "HTTPS://feeds.example.com/show/",
  ];
  const normed = new Set(variants.map(normalizeFeedUrl));
  assert.equal(normed.size, 1);
});

test("normalizeFeedUrl: empty/missing input yields empty string, not a throw", () => {
  assert.equal(normalizeFeedUrl(""), "");
  assert.equal(normalizeFeedUrl(null), "");
  assert.equal(normalizeFeedUrl(undefined), "");
});
