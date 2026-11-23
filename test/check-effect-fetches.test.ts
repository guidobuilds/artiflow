import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repoRoot, "scripts/check-effect-fetches.mjs");

async function check(source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "check-effects-"));
  const file = path.join(dir, "screen.tsx");
  try {
    await writeFile(file, source);
    return spawnSync(process.execPath, [script, file], { cwd: repoRoot, encoding: "utf8" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the dashboard has no fetch inside an effect", () => {
  const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no fetch inside useEffect in \d+ file\(s\)/);
});

test("a client read and a fetch inside an effect fail, including a nested timer", async () => {
  const direct = await check(`import { getSession } from "./auth-client.ts";
import { useEffect } from "react";
export function Screen() {
  useEffect(() => {
    void getSession();
  }, []);
  return null;
}
`);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /getSession\(\)/);

  const fetched = await check(`import { useEffect } from "react";
export function Screen() {
  useEffect(() => {
    void fetch("/api/artifacts");
  }, []);
  return null;
}
`);
  assert.equal(fetched.status, 1);
  assert.match(fetched.stderr, /fetch\(\)/);

  const nested = await check(`import { listShares } from "./auth-client.ts";
import { useEffect } from "react";
export function Screen({ id }: { id: string }) {
  useEffect(() => {
    const timer = setInterval(() => {
      void listShares(id);
    }, 1000);
    return () => clearInterval(timer);
  }, [id]);
  return null;
}
`);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /listShares\(\)/);
});

test("a query and a pure helper inside an effect are allowed", async () => {
  const query = await check(`import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSession } from "./auth-client.ts";
export function Screen() {
  useQuery({ queryKey: ["session"], queryFn: () => getSession() });
  useEffect(() => {
    document.title = "Artiflow";
  }, []);
  return null;
}
`);
  assert.equal(query.status, 0, query.stderr);

  const pure = await check(`import { removeNode } from "./scene-api.ts";
import { useEffect } from "react";
export function Screen() {
  useEffect(() => {
    const onKey = () => removeNode(null, "n");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
`);
  assert.equal(pure.status, 0, pure.stderr);
});
