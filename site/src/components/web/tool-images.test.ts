import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResultImages, toolResultText, toolRowView, type ToolDisplay } from "./tool-images.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const SVG = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";

test("toolResultImages: every image the tool returned, in order", () => {
  const output = `Read image file [image/png]\n![image](${PNG})\nand\n![image](${JPEG})`;
  assert.deepEqual(toolResultImages({ output, status: "done" }), [PNG, JPEG]);
});

test("toolResultImages: plain text, running and failed tools have none", () => {
  assert.deepEqual(toolResultImages({ output: "just text", status: "done" }), []);
  assert.deepEqual(toolResultImages({ output: undefined, status: "pending" }), []);
  // A failed tool shows its error, never pictures (the phone app's rule).
  assert.deepEqual(toolResultImages({ output: `![image](${PNG})`, status: "error" }), []);
});

test("toolResultImages: non-image data URIs and svg are ignored", () => {
  const output = `![file](data:text/plain;base64,aGk=)\n![x](${SVG})\n[link](${PNG})`;
  assert.deepEqual(toolResultImages({ output, status: "done" }), []);
});

test("toolResultText: the data-URI markdown is stripped, the rest kept", () => {
  const output = `Read image file [image/png]\n![image](${PNG})\n`;
  assert.equal(toolResultText({ output, status: "done" }), "Read image file [image/png]");
  assert.equal(toolResultText({ output: `![image](${PNG})`, status: "done" }), "");
  assert.equal(
    toolResultText({ output: `a\n![image](${PNG})\nb\n![image](${JPEG})`, status: "done" }),
    "a\n\nb",
  );
  // Text the card cannot show as a picture stays readable text.
  assert.equal(toolResultText({ output: `![x](${SVG})`, status: "done" }), `![x](${SVG})`);
  // A failed tool shows no pictures, and its error text drops the image markdown too (phone parity).
  assert.equal(toolResultText({ output: `boom ![image](${PNG})`, status: "error" }), "boom");
  assert.equal(toolResultText({ output: undefined, status: "pending" }), undefined);
});

const withImage = { tool: "read", output: `![image](${PNG})`, status: "done" as const };
const plainRead = { tool: "read", output: "file text", status: "done" as const };
const plainBash = { tool: "bash", output: "ok", status: "done" as const };

test("toolRowView: hidden mode shows only the pictures of a tool that returned some", () => {
  assert.equal(toolRowView(withImage, "hidden"), "images");
  assert.equal(toolRowView(plainBash, "hidden"), null);
  assert.equal(toolRowView({ ...withImage, status: "error" }, "hidden"), null);
});

test("toolRowView: brief mode hides read-only tools unless they returned a picture", () => {
  assert.equal(toolRowView(plainRead, "brief"), null);
  assert.equal(toolRowView(withImage, "brief"), "card");
  assert.equal(toolRowView(plainBash, "brief"), "card");
});

test("toolRowView: full mode shows every tool as a card", () => {
  const modes: ToolDisplay[] = ["full"];
  for (const mode of modes) {
    assert.equal(toolRowView(plainRead, mode), "card");
    assert.equal(toolRowView(withImage, mode), "card");
  }
});
