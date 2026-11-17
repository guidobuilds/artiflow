import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = path.join(repoRoot, "apps/web/scripts/check-built.mjs");
const usage = "Usage: node apps/web/scripts/check-built.mjs [distDir]";

function siteFiles(): Record<string, string> {
  return {
    "dist/index.html": [
      "<!doctype html><title>Redirecting to: /docs/</title>",
      '<meta http-equiv="refresh" content="2;url=/docs/">',
      '<link rel="canonical" href="https://artiflow.dev/docs/">',
      '<a href="/docs/">Redirecting to /docs/</a>',
    ].join(""),
    "dist/404.html": [
      "<!doctype html><html><head>",
      '<link rel="shortcut icon" href="/favicon.svg" type="image/svg+xml">',
      "</head><body>",
      '<a href="/">Home</a>',
      '<span id="_top"></span><a href="#_top">Skip to content</a>',
      "</body></html>",
    ].join(""),
    "dist/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    "dist/_astro/app.css": "body{color:black}\n",
    "dist/docs/index.html": [
      "<!doctype html><html><head>",
      '<link rel="stylesheet" href="/_astro/app.css">',
      "</head><body>",
      '<h2 id="intro">Artiflow</h2>',
      '<a href="start/">Quickstart</a>',
      '<a href="#intro">What this is</a>',
      '<a href="/docs/start/#install">Install</a>',
      '<a href="https://example.com/docs">External</a>',
      '<a href="mailto:team@example.com">Email</a>',
      '<a href="data:text/plain,hi">Data</a>',
      "</body></html>",
    ].join(""),
    "dist/docs/start/index.html": [
      "<!doctype html><html><body>",
      '<a href="../">Documentation</a>',
      '<h2 id="install">Install</h2>',
      "</body></html>",
    ].join(""),
  };
}

type Fixture = { root: string; dist: string };

function makeFixture(t: TestContext, overrides: Record<string, string> = {}, site = true): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "artiflow-web-built-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries({ ...(site ? siteFiles() : {}), ...overrides })) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { root, dist: path.join(root, "dist") };
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(args: string[]): Run {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.signal, null, "check-built finishes inside the 20s budget");
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

const validStdout = "check-built: 4 HTML files and 10 local URLs are valid\n";

test("--help documents the argument, checks and exit codes", () => {
  const result = run(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  for (const line of ["Usage:", "distDir", "--help", "Exit codes:", "0  verified", "1  problems found", "2  usage"]) {
    assert.ok(result.stdout.includes(line), `help mentions ${line}`);
  }
  assert.ok(!result.stdout.includes("--root"), "configuration parity is a separate command");
});

test("a built site whose links, assets and fragments all resolve passes", (t) => {
  const fixture = makeFixture(t);
  const before = snapshot(fixture.root);

  const result = run([fixture.dist]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, validStdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(snapshot(fixture.root), before);
});

test("values that are not references are ignored instead of resolved", (t) => {
  const fixture = makeFixture(t, {
    "dist/docs/remote.html": [
      "<!doctype html><html><body>",
      '<a href="https://example.com/">https</a>',
      '<a href="http://example.com/">http</a>',
      '<a src="//cdn.example.com/app.js"></a>',
      '<a href="mailto:team@example.com">mail</a>',
      '<a href="tel:+10000000">tel</a>',
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
      '<pre><code>&lt;a href="/docs/missing/"&gt;example&lt;/a&gt;</code></pre>',
      "</body></html>",
    ].join(""),
  });

  const result = run([fixture.dist]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "check-built: 5 HTML files and 10 local URLs are valid\n");
  assert.equal(result.stderr, "");
});

test("a query-only URL with a fragment validates the same-page anchor", (t) => {
  const present = siteFiles();
  present["dist/docs/index.html"] = (present["dist/docs/index.html"] as string).replace(
    '<a href="#intro">What this is</a>',
    '<a href="#intro">What this is</a><a href="?theme=dark#intro">Themed</a>',
  );
  const passing = makeFixture(t, present);

  const passed = run([passing.dist]);

  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "check-built: 4 HTML files and 11 local URLs are valid\n");
  assert.equal(passed.stderr, "");

  const absent = siteFiles();
  absent["dist/docs/index.html"] = (absent["dist/docs/index.html"] as string).replace(
    '<a href="#intro">What this is</a>',
    '<a href="#intro">What this is</a><a href="?theme=dark#summary">Themed</a>',
  );
  const failing = makeFixture(t, absent);
  const before = snapshot(failing.root);

  const rejected = run([failing.dist]);

  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(
    rejected.stderr,
    ["missing anchor: docs/index.html -> ?theme=dark#summary", "check-built: 1 problem found", ""].join("\n"),
  );
  assert.deepEqual(snapshot(failing.root), before);
});

test("same-origin absolute URLs are internal while other origins are not", (t) => {
  const internal = siteFiles();
  internal["dist/docs/index.html"] = (internal["dist/docs/index.html"] as string)
    .replace('<a href="start/">Quickstart</a>', '<a href="https://artiflow.dev/docs/start/">Quickstart</a>')
    .replace(
      '<a href="https://example.com/docs">External</a>',
      '<a href="https://example.org/docs/missing/">External</a>',
    );
  const passing = makeFixture(t, internal);

  const passed = run([passing.dist]);

  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, validStdout);
  assert.equal(passed.stderr, "");

  const broken = siteFiles();
  broken["dist/docs/index.html"] = (broken["dist/docs/index.html"] as string).replace(
    '<a href="start/">Quickstart</a>',
    '<a href="https://artiflow.dev/docs/missing/">Quickstart</a>',
  );
  const failing = makeFixture(t, broken);
  const before = snapshot(failing.root);

  const rejected = run([failing.dist]);

  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(
    rejected.stderr,
    ["missing route: docs/index.html -> https://artiflow.dev/docs/missing/", "check-built: 1 problem found", ""].join(
      "\n",
    ),
  );
  assert.deepEqual(snapshot(failing.root), before);
});

test("a route the build never produced is rejected with the exact output", (t) => {
  const files = siteFiles();
  files["dist/docs/index.html"] = (files["dist/docs/index.html"] as string).replace('href="start/"', 'href="missing/"');
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    ["missing route: docs/index.html -> missing/", "check-built: 1 problem found", ""].join("\n"),
  );
});

test("an asset referenced by href but not copied into the build is rejected", (t) => {
  const files = siteFiles();
  files["dist/docs/index.html"] = (files["dist/docs/index.html"] as string).replace(
    'href="/_astro/app.css"',
    'href="/_astro/missing.css"',
  );
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    ["missing asset: docs/index.html -> /_astro/missing.css", "check-built: 1 problem found", ""].join("\n"),
  );
});

test("an asset referenced by src but not copied into the build is rejected", (t) => {
  const files = siteFiles();
  files["dist/404.html"] = (files["dist/404.html"] as string).replace(
    '<a href="/">Home</a>',
    '<a href="/">Home</a><img src="/logo.png" alt="">',
  );
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, ["missing asset: 404.html -> /logo.png", "check-built: 1 problem found", ""].join("\n"));
});

test("a same-page fragment with no matching id is rejected", (t) => {
  const files = siteFiles();
  files["dist/docs/index.html"] = (files["dist/docs/index.html"] as string).replace('href="#intro"', 'href="#summary"');
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    ["missing anchor: docs/index.html -> #summary", "check-built: 1 problem found", ""].join("\n"),
  );
});

test("a cross-page fragment with no matching id is rejected", (t) => {
  const files = siteFiles();
  files["dist/docs/index.html"] = (files["dist/docs/index.html"] as string).replace(
    'href="/docs/start/#install"',
    'href="/docs/start/#missing"',
  );
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    ["missing anchor: docs/index.html -> /docs/start/#missing", "check-built: 1 problem found", ""].join("\n"),
  );
});

test("the root / redirect and the generated 404 in the output root resolve", (t) => {
  const files = siteFiles();
  files["dist/docs/start/index.html"] = (files["dist/docs/start/index.html"] as string).replace(
    '<a href="../">Documentation</a>',
    '<a href="../">Documentation</a><a href="/404/">Not found</a>',
  );
  const fixture = makeFixture(t, files);

  const result = run([fixture.dist]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "check-built: 4 HTML files and 11 local URLs are valid\n");
  assert.equal(result.stderr, "");
});

test("a dist directory without built HTML is rejected, never trusted from the sources", (t) => {
  const fixture = makeFixture(t, { "dist/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' }, false);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [`missing output: ${fixture.dist} has no HTML files`, "check-built: 1 problem found", ""].join("\n"),
  );
});

test("rejected input leaves every fixture file unchanged", (t) => {
  const files = siteFiles();
  files["dist/docs/index.html"] = (files["dist/docs/index.html"] as string)
    .replace('href="start/"', 'href="missing/"')
    .replace('href="#intro"', 'href="?theme=dark#summary"');
  const fixture = makeFixture(t, files);
  const before = snapshot(fixture.root);

  const result = run([fixture.dist]);

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    [
      "missing route: docs/index.html -> missing/",
      "missing anchor: docs/index.html -> ?theme=dark#summary",
      "check-built: 2 problems found",
      "",
    ].join("\n"),
  );
  assert.deepEqual(snapshot(fixture.root), before);
});

test("a missing dist directory and an unknown option are usage errors", (t) => {
  const fixture = makeFixture(t);

  const missing = run([path.join(fixture.root, "dist-missing")]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.equal(
    missing.stderr,
    [`check-built: dist directory not found: ${path.join(fixture.root, "dist-missing")}`, usage, ""].join("\n"),
  );

  const unknown = run(["--root", fixture.root]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, ["check-built: unknown option: --root", usage, ""].join("\n"));
});
