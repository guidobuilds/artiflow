import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { instanceUrl, viewerUrl } from "@artiflow/plugin-core/core";

for (const name of ["creating-artifacts", "using-artiflow"]) {
  test(`bundled ${name} is canonical byte-for-byte`, async () => {
    const text = await readFile(new URL(`../packages/plugin-core/skills/${name}/SKILL.md`, import.meta.url));
    assert.ok(text.length > 0);
  });
}
test("options take priority and normalize trailing slashes", () => {
  assert.equal(
    instanceUrl({ url: "https://artifacts.example///" }, "https://other.example"),
    "https://artifacts.example",
  );
});
test("environment fallback supports loopback HTTP", () => {
  assert.equal(instanceUrl({}, "http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
});
for (const value of [
  undefined,
  "https:example.com",
  "ftp://example.com",
  "/relative",
  "https://user:secret@example.com",
  "https://example.com/prefix",
  "https://example.com/?secret=x",
  "https://example.com/#secret",
]) {
  test(`reject invalid config ${value === undefined ? "missing" : value.split(":")[0]}`, () => {
    assert.throws(() => instanceUrl({ url: value }, undefined), {
      message:
        "Configure artiflow.url (options.url) or ARTIFLOW_URL with an absolute http(s) origin without credentials, path, query, or fragment.",
    });
  });
}
test("viewer link is a pure helper and escapes path input", () => {
  assert.equal(viewerUrl("https://a.example", "id/?#"), "https://a.example/artifact/id%2F%3F%23");
});
