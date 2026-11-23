import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repoRoot, "scripts/check-comments.mjs");
const lineComment = "/" + "/";
const blockOpen = "/" + "*";
const blockClose = "*" + "/";

async function check(name: string, source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "check-comments-"));
  const file = path.join(dir, name);
  try {
    await writeFile(file, source);
    return spawnSync(process.execPath, [script, file], { cwd: repoRoot, encoding: "utf8" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the repository has no disallowed comments", () => {
  const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no disallowed comments in \d+ file\(s\)/);
});

test("fails on a narrative line comment", async () => {
  const result = await check("source.ts", `export const value = 1; ${lineComment} narrative\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source\.ts:1: .*narrative/);
});

test("fails on a narrative block comment and on an empty comment", async () => {
  const block = await check("block.ts", `${blockOpen} narrative ${blockClose}\nexport const value = 1;\n`);
  assert.equal(block.status, 1);
  assert.match(block.stderr, /narrative/);

  const empty = await check("empty.ts", `export const value = 1; ${lineComment}\n`);
  assert.equal(empty.status, 1);
});

test("fails on a JSX comment", async () => {
  const result = await check("view.tsx", `export const node = <div>{${blockOpen} story ${blockClose}}</div>;\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /story/);
});

test("fails on a comment inside a JavaScript template and an inline script", async () => {
  const program = await check(
    "program.ts",
    ["export const code = `const value = 1;", `${lineComment} narrative`, "`;", ""].join("\n"),
  );
  assert.equal(program.status, 1);
  assert.match(program.stderr, /program\.ts:2: .*narrative/);

  const page = await check(
    "page.ts",
    ["export const page = `<script>", "const value = 1;", `${lineComment} narrative`, "</script>`;", ""].join("\n"),
  );
  assert.equal(page.status, 1);
  assert.match(page.stderr, /page\.ts:3: .*narrative/);

  const html = await check(
    "index.html",
    `<!doctype html><script>\nconst value = 1;\n${lineComment} narrative\n</script>\n`,
  );
  assert.equal(html.status, 1);
  assert.match(html.stderr, /index\.html:3: .*narrative/);

  const spaced = await check(
    "spaced.html",
    `<!doctype html><script >\nconst value = 1;\n${lineComment} narrative\n</script >\n`,
  );
  assert.equal(spaced.status, 1);
  assert.match(spaced.stderr, /spaced\.html:3: .*narrative/);
});

test("ignores strings, regular expressions, protocol slashes, globs, and non-JS script bodies", async () => {
  const result = await check(
    "safe.ts",
    [
      'export const url = "https://example.com";',
      "export const re = /https?:\\/\\//;",
      'export const link = `<a href="https://example.com/${1}">x</a>`;',
      "export const message = `login at /api/auth/*, public sign-up closed${0}`;",
      'export const data = `<script type="application/json">',
      `{ "note": "${lineComment} not javascript" }`,
      "</script>`;",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
});

test("allows shebangs, license lines, and tool directives", async () => {
  const result = await check(
    "directives.mjs",
    [
      "#!" + "/usr/bin/env node",
      `${blockOpen} SPDX-License-Identifier: MIT ${blockClose}`,
      `${lineComment}/ <reference path="./types" />`,
      `${lineComment} @ts-expect-error the fixture is intentionally untyped`,
      `${lineComment} eslint-disable-next-line no-explicit-any`,
      `${lineComment} @vitest-environment jsdom`,
      "export const value = 1;",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
});

test("requires a reason on @ts-expect-error and rejects a narrative line beside a directive", async () => {
  const bare = await check("bare.ts", `${lineComment} @ts-expect-error\nexport const value = 1;\n`);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /@ts-expect-error/);

  const mixed = await check(
    "mixed.ts",
    [
      `${blockOpen}`,
      " * narrative beside a suppression",
      " * eslint-disable no-console",
      ` ${blockClose}`,
      "export {};",
      "",
    ].join("\n"),
  );
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /narrative beside a suppression/);
});
