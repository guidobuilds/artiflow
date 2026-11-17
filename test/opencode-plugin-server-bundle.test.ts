import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { before } from "node:test";

const run = promisify(execFile);
const packageJson = new URL("../plugins/opencode/package.json", import.meta.url);
const bundle = fileURLToPath(new URL("../plugins/opencode/dist/server.mjs", import.meta.url));
const buildServer = fileURLToPath(new URL("../plugins/opencode/scripts/build-server.mjs", import.meta.url));

before(async () => {
  if (!existsSync(bundle)) await run(process.execPath, [buildServer]);
});
const manifest = () =>
  JSON.parse(readFileSync(packageJson, "utf8")) as {
    exports: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  };

const hostModule = (specifier: string) =>
  specifier === "@opencode/plugin" || specifier === "effect" || specifier.startsWith("effect/");

const specifiers = (source: string) => [
  ...new Set([
    ...[...source.matchAll(/^import\s.*?\bfrom\s*"([^"]+)";$/gm)].map((match) => match[1] as string),
    ...[...source.matchAll(/^import\s*"([^"]+)";$/gm)].map((match) => match[1] as string),
  ]),
];

test("the server entry hosts load is the standalone bundle and the dev source keeps its own entry", () => {
  const { exports, files, scripts } = manifest();
  assert.equal(exports["./server"], "./dist/server.mjs");
  assert.equal(exports["./server-source"], "./src/index.ts");
  assert.equal(exports["./server-standalone"], "./dist/server.mjs");
  assert.deepEqual(files, ["src", "skills", "dist", "README.md"]);
  assert.ok(scripts["build:server"], "package.json must declare a build:server script");
  assert.ok(existsSync(bundle), "the server bundle build produced no dist/server.mjs");
});

test("the standalone server bundle imports only host modules and node builtins", () => {
  const found = specifiers(readFileSync(bundle, "utf8"));
  assert.ok(found.length > 0, "the bundle declares no external specifiers");
  assert.ok(found.includes("@opencode/plugin"), "the bundle must keep the host plugin external");
  assert.deepEqual(
    found.filter((specifier) => !isBuiltin(specifier) && !hostModule(specifier)),
    [],
    "only host-provided modules may stay external",
  );
  for (const inlined of ["@artiflow/", "zod"])
    assert.deepEqual(
      found.filter((specifier) => specifier.startsWith(inlined)),
      [],
      `${inlined} must be inlined in the bundle`,
    );
});

test("the standalone server bundle loads as a module against the workspace host", async () => {
  const { stdout, stderr } = await run(process.execPath, [bundle]);
  assert.equal(stdout.trim(), "");
  assert.equal(stderr.trim(), "");
});
