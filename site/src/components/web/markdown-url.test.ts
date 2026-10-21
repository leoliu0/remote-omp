import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownUrlTransform } from "./markdown-url.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const img = { tagName: "img" };
const a = { tagName: "a" };

test("markdownUrlTransform: base64 png/jpeg/gif/webp allowed as an image source", () => {
  assert.equal(markdownUrlTransform(PNG, "src", img), PNG);
  for (const mime of ["jpeg", "gif", "webp", "PNG"]) {
    const url = `data:image/${mime};base64,AAAA`;
    assert.equal(markdownUrlTransform(url, "src", img), url);
  }
});

test("markdownUrlTransform: svg, non-base64 and non-image data URIs rejected", () => {
  assert.equal(markdownUrlTransform("data:image/svg+xml;base64,PHN2Zz4=", "src", img), "");
  assert.equal(markdownUrlTransform("data:image/svg+xml,<svg onload=alert(1)>", "src", img), "");
  assert.equal(markdownUrlTransform("data:text/html;base64,PHNjcmlwdD4=", "src", img), "");
  assert.equal(markdownUrlTransform("data:image/png,raw", "src", img), "");
});

test("markdownUrlTransform: data: is never allowed in a link", () => {
  assert.equal(markdownUrlTransform(PNG, "href", a), "");
  assert.equal(markdownUrlTransform("data:text/html;base64,PHNjcmlwdD4=", "href", a), "");
  assert.equal(markdownUrlTransform("javascript:alert(1)", "href", a), "");
});

test("markdownUrlTransform: ordinary URLs keep react-markdown's default handling", () => {
  assert.equal(markdownUrlTransform("https://example.com/x.png", "src", img), "https://example.com/x.png");
  assert.equal(markdownUrlTransform("https://example.com", "href", a), "https://example.com");
  assert.equal(markdownUrlTransform("/relative", "href", a), "/relative");
});
