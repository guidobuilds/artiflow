import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = path.join(repoRoot, "scripts/check-boundaries.mjs");

function runChecker(root: string) {
  return spawnSync(process.execPath, [checker, "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const FIXTURE_SOURCES: Record<string, string> = {
  "apps/dashboard/src/leaks-api.ts": 'import { createApp } from "../../api/src/app.ts";\n',
  "apps/dashboard/src/leaks-db.ts": 'import { readFile } from "node:fs/promises";\n',
  "apps/dashboard/src/leaks-sdk.ts": 'import { S3Client } from "@aws-sdk/client-s3";\n',
  "apps/dashboard/src/leaks-type.ts": 'import type { Pool } from "pg";\n',
  "packages/domain/src/leaks-hono.ts": 'import { Hono } from "hono";\n',
  "apps/api/src/leaks-dashboard.ts": 'import { cn } from "../../dashboard/src/lib/utils.ts";\n',
  "apps/api/src/leaks-web.ts": 'import { render } from "src/web/render.ts";\n',
  "plugins/opencode/src/leaks-api.ts": 'import { app } from "../../../apps/api/src/app.ts";\n',
  "packages/contracts/src/leaks-domain.ts": 'import { anchors } from "@artiflow/domain/comment-anchors";\n',
  "packages/contracts/src/leaks-sdk.ts": 'import { createSdkClient } from "@artiflow/sdk/client";\n',
  "packages/domain/src/leaks-io.ts": 'import { readFile } from "node:fs";\n',
  "packages/mcp-server/src/leaks-pg.ts": 'import { Pool } from "pg";\n',
  "packages/mcp-server/src/leaks-hono.ts": 'import { Hono } from "hono";\n',
  "packages/mcp-apps/src/leaks-pg.ts": 'import { Pool } from "pg";\n',
  "packages/mcp-apps/src/leaks-io.ts": 'import { readFile } from "node:fs";\n',
  "packages/contracts/src/leaks-domain-rel.ts": 'import { work } from "../../domain/src/work.ts";\n',
};

const EXPECTED_VIOLATIONS = [
  ["apps/dashboard/src/leaks-api.ts:1", "../../api/src/app.ts"],
  ["apps/dashboard/src/leaks-db.ts:1", "node:fs/promises"],
  ["apps/dashboard/src/leaks-sdk.ts:1", "@aws-sdk/client-s3"],
  ["apps/dashboard/src/leaks-type.ts:1", "pg"],
  ["packages/domain/src/leaks-hono.ts:1", "hono"],
  ["apps/api/src/leaks-dashboard.ts:1", "../../dashboard/src/lib/utils.ts"],
  ["apps/api/src/leaks-web.ts:1", "src/web/render.ts"],
  ["plugins/opencode/src/leaks-api.ts:1", "../../../apps/api/src/app.ts"],
  ["packages/contracts/src/leaks-domain.ts:1", "@artiflow/domain"],
  ["packages/contracts/src/leaks-sdk.ts:1", "@artiflow/sdk"],
  ["packages/domain/src/leaks-io.ts:1", "node:fs"],
  ["packages/mcp-server/src/leaks-pg.ts:1", "pg"],
  ["packages/mcp-server/src/leaks-hono.ts:1", "hono"],
  ["packages/mcp-apps/src/leaks-pg.ts:1", "pg"],
  ["packages/mcp-apps/src/leaks-io.ts:1", "node:fs"],
  ["packages/contracts/src/leaks-domain-rel.ts:1", "../../domain/src/work.ts"],
] as const;

test("check-boundaries reports every forbidden workspace edge and exits 1", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "artiflow-boundaries-"));
  try {
    for (const [file, content] of Object.entries(FIXTURE_SOURCES)) {
      const target = path.join(fixture, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const result = runChecker(fixture);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    for (const [location, specifier] of EXPECTED_VIOLATIONS) {
      assert.ok(output.includes(location), `missing ${location} in:\n${output}`);
      assert.ok(output.includes(specifier), `missing ${specifier} in:\n${output}`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("check-boundaries accepts allowed edges and exits 0", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "artiflow-boundaries-"));
  try {
    const allowed: Record<string, string> = {
      "apps/dashboard/src/ok.ts": [
        'import { render } from "@/lib/utils.ts";',
        'import { anchor } from "@artiflow/domain/comment-anchors";',
        'import { clsx } from "clsx";',
        'import type { ReactNode } from "react";',
        'import { only } from "./only.ts";',
        "",
      ].join("\n"),
      "apps/dashboard/src/only.ts": "export const only = 1;\n",
      "packages/domain/src/ok.ts": 'import { work } from "./work.ts";\n',
      "packages/domain/src/work.ts": "export const work = 1;\n",
      "apps/api/src/ok.ts": [
        'import { anchor } from "@artiflow/domain/comment-anchors";',
        'import { Hono } from "hono";',
        'import pg from "pg";',
        "",
      ].join("\n"),
      "plugins/opencode/src/ok.ts": 'import { work } from "../../../packages/domain/src/work.ts";\n',
      "apps/dashboard/src/ok-contracts.ts":
        'import { artifactListResponseSchema } from "@artiflow/contracts/artifacts";\n',
      "apps/dashboard/src/ok-sdk.ts": 'import { createSdkClient } from "@artiflow/sdk/client";\n',
    };
    for (const [file, content] of Object.entries(allowed)) {
      const target = path.join(fixture, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const result = runChecker(fixture);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("check-boundaries passes on the current workspace", () => {
  const result = runChecker(repoRoot);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /check-boundaries: \d+ files?/);
});
