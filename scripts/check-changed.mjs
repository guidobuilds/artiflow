#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const FORMAT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".jsonc",
  ".css",
  ".md",
  ".yml",
  ".yaml",
  ".html",
]);
const LINT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx"]);
const CHUNK_SIZE = 100;

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function resolveBase(ref) {
  for (const candidate of [ref, "origin/main", "main"]) {
    const mergeBase = git(["merge-base", candidate, "HEAD"], true);
    if (mergeBase) return mergeBase;
    const revision = git(["rev-parse", candidate], true);
    if (revision) return revision;
  }
  throw new Error(
    `Cannot resolve a base ref (${ref}). Pass one explicitly, or fetch origin/main first: ` +
      `node scripts/check-changed.mjs <base>`,
  );
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function binary(name) {
  return path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function run(label, name, args) {
  const result = spawnSync(binary(name), args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`check-changed: ${label} failed to start: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

const base = resolveBase(process.argv[2] ?? process.env.BASE_REF ?? "origin/main");
const committed = git(["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD"], true) ?? "";
const workingTree = git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], true) ?? "";
const files = [
  ...new Set(
    [...committed.split("\n"), ...workingTree.split("\n")]
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file) => existsSync(path.join(root, file))),
  ),
].sort();

const formatFiles = files.filter((file) => FORMAT_EXTENSIONS.has(path.extname(file)));
const lintFiles = files.filter((file) => LINT_EXTENSIONS.has(path.extname(file)));

console.log(
  `check-changed: base ${base.slice(0, 10)} — ${files.length} changed file(s), ` +
    `${formatFiles.length} to format, ${lintFiles.length} to lint`,
);

let ok = true;
for (const batch of chunk(formatFiles, CHUNK_SIZE)) {
  ok = run("prettier", "prettier", ["--check", ...batch]) && ok;
}
for (const batch of chunk(lintFiles, CHUNK_SIZE)) {
  ok = run("oxlint", "oxlint", ["--deny-warnings", ...batch]) && ok;
}

if (!ok) {
  console.error("check-changed: run `bun run format` and fix the lint findings in the files above.");
  process.exitCode = 1;
}
