import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runner = path.join(repoRoot, "scripts/run-integration.mjs");
const wait = path.join(repoRoot, "scripts/wait-integration-services.mjs");
const workflow = path.join(repoRoot, ".github/workflows/verify.yml");

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function exampleEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const text = readFileSync(path.join(repoRoot, "test/integration-config.example"), "utf8");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

function withFixture(source: string): { file: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "integration-ci-"));
  const file = path.join(dir, "fixture.test.mjs");
  writeFileSync(file, source);
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

test("integration runner refuses a missing disposable-stack variable before any test", () => {
  const marker = path.join(tmpdir(), `integration-ran-${process.pid}`);
  rmSync(marker, { force: true });
  const fixture = withFixture(`
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.ARTIFLOW_INTEGRATION_RAN_MARKER, "ran");
    import { test } from "node:test";
    test("must not run", () => {});
  `);
  try {
    const result = run(runner, ["--file", fixture.file], {
      PATH: process.env.PATH ?? "",
      ARTIFLOW_INTEGRATION_RAN_MARKER: marker,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required environment: .*DATABASE_URL/);
    assert.match(result.stderr, /ARTIFLOW_S3_BUCKET/);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(result.stdout, /passed with no skipped tests/);
  } finally {
    fixture.remove();
    rmSync(marker, { force: true });
  }
});

test("integration runner fails when a configured test skips", () => {
  const fixture = withFixture(`
    import { test } from "node:test";
    test("proves nothing", { skip: "DATABASE_URL or S3 missing" }, () => {});
  `);
  try {
    const result = run(runner, ["--file", fixture.file], exampleEnv());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 test\(s\) skipped/);
    assert.match(result.stderr, /proves nothing \(DATABASE_URL or S3 missing\)/);
    assert.doesNotMatch(result.stdout, /passed with no skipped tests/);
  } finally {
    fixture.remove();
  }
});

test("integration runner accepts a run with no skips", () => {
  const fixture = withFixture(`
    import { test } from "node:test";
    test("holds", () => {});
  `);
  try {
    const result = run(runner, ["--file", fixture.file], exampleEnv());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /integration: passed with no skipped tests/);
  } finally {
    fixture.remove();
  }
});

test("integration runner preserves a real test failure", () => {
  const fixture = withFixture(`
    import assert from "node:assert/strict";
    import { test } from "node:test";
    test("breaks", () => { assert.equal(1, 2); });
  `);
  try {
    const result = run(runner, ["--file", fixture.file], exampleEnv());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /test run failed with exit 1/);
    assert.doesNotMatch(result.stderr, /test\(s\) skipped/);
    assert.doesNotMatch(result.stdout, /passed with no skipped tests/);
  } finally {
    fixture.remove();
  }
});

test("integration runner help and usage", () => {
  const help = run(runner, ["--help"], { PATH: process.env.PATH ?? "" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /test\/\*\.integration\.ts/);

  const usage = run(runner, ["--nope"], { PATH: process.env.PATH ?? "" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unknown option --nope/);
});

test("service wait fails closed when required environment is missing", () => {
  const result = run(wait, [], { PATH: process.env.PATH ?? "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required environment: .*DATABASE_URL/);
  assert.match(result.stderr, /ARTIFLOW_S3_SECRET_ACCESS_KEY/);
});

test("service wait rejects configuration the stack would not use", { timeout: 60_000 }, () => {
  const result = run(wait, ["--timeout-ms", "500"], exampleEnv({ DATABASE_URL: "not-a-database" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL must be a postgres:\/\/ connection string/);
  assert.doesNotMatch(result.stderr, /did not become ready/);
});

test("service wait usage", () => {
  const help = run(wait, ["--help"], { PATH: process.env.PATH ?? "" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /HeadBucket/);

  const usage = run(wait, ["--timeout-ms", "soon"], { PATH: process.env.PATH ?? "" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /positive integer/);
});

test("verify workflow runs the integration suite as a required job", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /^ {2}integration:/m);
  assert.doesNotMatch(source, /^ {2}security-sandbox:/m);
  assert.match(source, /bun run test:integration/);
  assert.match(source, /scripts\/wait-integration-services\.mjs/);
  assert.match(source, /adapters\/postgres\/db\/migrate\.ts/);
  assert.match(source, /docker-compose\.ci\.yml/);
  assert.equal(source.match(/!github\.event\.pull_request\.draft/g)?.length, 3);
  assert.doesNotMatch(source, /continue-on-error/);
});
