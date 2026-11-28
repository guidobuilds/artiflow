import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = path.join(repoRoot, "scripts/check-docs.mjs");

function runChecker(root: string, extra: string[] = []) {
  return spawnSync(process.execPath, [checker, ...extra], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const KINDS = `export const ARTIFACT_KINDS = ["html", "markdown", "canvas", "deck"] as const;\n`;
const TOOLS = `server.registerTool("artifact_get", { title: "Read" }, async () => {});\nserver.registerTool("artifact_write", { title: "Write" }, async () => {});\nfor (const operation of ["resolve", "unresolve"] as const) {\n  server.registerTool(\`artifact_\${operation}_comment\`, { title: operation }, async () => {});\n}\n`;

async function writeFixture(root: string, files: Record<string, string>) {
  const all = {
    "packages/domain/src/kinds.ts": KINDS,
    "packages/mcp-server/src/server.ts": TOOLS,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

test("check-docs reports kind and tool contradictions and exits 1", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "artiflow-docs-"));
  try {
    await writeFixture(fixture, {
      "README.md": [
        "Thirteen tools for publishing.",
        "Artifacts of two kinds.",
        "Not available today: Canvas and other artifact kinds.",
        'Optional kind (`"html"` default or `"markdown"`).',
        "",
      ].join("\n"),
      "skills/using-artiflow/SKILL.md": "Eleven tools exist.\n",
    });
    const result = runChecker(fixture, ["--root", fixture]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    for (const snippet of [
      "README.md:1:",
      "states 13 MCP tools",
      "packages/mcp-server/src/server.ts",
      "README.md:2:",
      "states 2 artifact kinds",
      "packages/domain/src/kinds.ts",
      "README.md:3:",
      "not available",
      "README.md:4:",
      "omits canvas, deck",
      "skills/using-artiflow/SKILL.md:1:",
      "states 11 MCP tools",
      "Fix the doc from the source of truth",
      "Do not hardcode a count.",
    ]) {
      assert.ok(output.includes(snippet), `missing ${snippet} in:\n${output}`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("check-docs accepts docs that match the source of truth", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "artiflow-docs-"));
  try {
    await writeFixture(fixture, {
      "README.md": [
        "Kind is `html` (the default), `markdown`, `canvas` or `deck`.",
        "See [the runbook](docs/runbook.md).",
        "",
      ].join("\n"),
      "docs/runbook.md": "The tools are registered in the server.\n",
    });
    const result = runChecker(fixture, ["--root", fixture]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /check-docs: \d+ relative links/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("check-docs rejects a missing --root directory and exits 2", () => {
  const result = runChecker(repoRoot, ["--root"]);
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /--root requires a directory/);
});

test("check-docs passes on the current workspace", () => {
  const result = runChecker(repoRoot);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /4 kinds and 25 tools/);
});
