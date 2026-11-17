import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = path.join(repoRoot, "apps/web/scripts/check-reference.mjs");
const reference = "apps/web/src/content/docs/docs/reference/configuration.md";
const usage = "Usage: node apps/web/scripts/check-reference.mjs [--root <dir>]";

const configSource = [
  "export function loadConfig(env: Record<string, string | undefined>) {",
  '  const nodeEnv = (env.NODE_ENV ?? "development").trim();',
  '  const authSecret = read(env, "ARTIFLOW_AUTH_SECRET");',
  "  return { nodeEnv, authSecret };",
  "}",
  "",
].join("\n");

const configReference = [
  "# Configuration",
  "",
  "## API process variables",
  "",
  "| Variable                | Required |",
  "| ----------------------- | -------- |",
  "| `NODE_ENV`              | no       |",
  "| `ARTIFLOW_AUTH_SECRET`  | **yes**  |",
  "",
  "## What the public origin decides",
  "",
  "`ARTIFLOW_NOT_A_VARIABLE` is not in this section.",
  "",
].join("\n");

type Fixture = { root: string };

function makeFixture(t: TestContext, overrides: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "artiflow-web-reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "apps/api/src/config.ts": configSource,
    [reference]: configReference,
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === "") continue;
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { root };
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.signal, null, "check-reference finishes inside the 20s budget");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return files;
}

const validStdout = `check-reference: 2 configuration variables match ${reference}\n`;

test("--help documents the option, checks and exit codes", () => {
  const result = run(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  for (const line of [
    "Usage:",
    "--root <dir>",
    "--help",
    "Exit codes:",
    "0  matched",
    "1  problems found",
    "2  usage",
  ]) {
    assert.ok(result.stdout.includes(line), `help mentions ${line}`);
  }
  assert.ok(!result.stdout.includes("distDir"), "built-output checks are a separate command");
});

test("a source and reference that agree pass, including the section boundary", (t) => {
  const fixture = makeFixture(t);
  const before = snapshot(fixture.root);

  const result = run(["--root", fixture.root]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, validStdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(snapshot(fixture.root), before);
});

test("a configuration variable the reference never documents is rejected", (t) => {
  const fixture = makeFixture(t, {
    "apps/api/src/config.ts": configSource.replace(
      "  return { nodeEnv, authSecret };",
      '  const extra = read(env, "ARTIFLOW_EXTRA_VALUE");\n  return { nodeEnv, authSecret, extra };',
    ),
  });
  const before = snapshot(fixture.root);

  const result = run(["--root", fixture.root]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      "missing configuration variable: ARTIFLOW_EXTRA_VALUE (read in apps/api/src/config.ts)",
      "check-reference: 1 problem found",
      "",
    ].join("\n"),
  );
  assert.deepEqual(snapshot(fixture.root), before);
});

test("a documented configuration variable the source never reads is rejected", (t) => {
  const fixture = makeFixture(t, {
    [reference]: configReference.replace(
      "| `ARTIFLOW_AUTH_SECRET`  | **yes**  |",
      "| `ARTIFLOW_AUTH_SECRET`  | **yes**  |\n| `ARTIFLOW_REMOVED_VALUE` | no |",
    ),
  });

  const result = run(["--root", fixture.root]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      "stale configuration variable: ARTIFLOW_REMOVED_VALUE " +
        "(documented in configuration.md, not read in apps/api/src/config.ts)",
      "check-reference: 1 problem found",
      "",
    ].join("\n"),
  );
});

test("an unreadable input and an unknown option are usage errors", (t) => {
  const fixture = makeFixture(t, { "apps/api/src/config.ts": "" });

  const unreadable = run(["--root", fixture.root]);
  assert.equal(unreadable.status, 2);
  assert.equal(unreadable.stdout, "");
  assert.equal(
    unreadable.stderr,
    [`check-reference: cannot read ${path.join(fixture.root, "apps/api/src/config.ts")}`, usage, ""].join("\n"),
  );

  const unknown = run(["--dist", fixture.root]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, ["check-reference: unknown option: --dist", usage, ""].join("\n"));
});

test("the real configuration source matches the published configuration reference", () => {
  const result = run(["--root", repoRoot]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `check-reference: 19 configuration variables match ${reference}\n`);
  assert.equal(result.stderr, "");
});
