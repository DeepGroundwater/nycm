import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, CATEGORY_KEYWORDS } from "../../../js/tokenize.js";

test("normalize lowercases", () => {
  assert.deepEqual(normalize("Times Square"), ["times", "square"]);
});

test("normalize strips diacritics", () => {
  assert.deepEqual(normalize("Café"), ["cafe"]);
});

test("normalize splits on punctuation", () => {
  assert.deepEqual(normalize("Joe's Pizza"), ["joe", "pizza"]);
});

test("normalize drops single-char tokens", () => {
  // "a" gets dropped; "s" is borderline — we keep len>=2 only.
  assert.deepEqual(normalize("a B cd"), ["cd"]);
});

test("normalize handles empty input", () => {
  assert.deepEqual(normalize(""), []);
  assert.deepEqual(normalize("   "), []);
});

test("normalize is idempotent", () => {
  const once = normalize("Battery Park");
  const twice = once.flatMap(normalize);
  assert.deepEqual(twice, once);
});

test("CATEGORY_KEYWORDS exists and is a Map", () => {
  assert.ok(CATEGORY_KEYWORDS instanceof Map);
});
