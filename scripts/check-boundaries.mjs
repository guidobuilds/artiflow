#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SCANNED_DIRS = ["apps", "packages", "plugins/opencode/src", "scripts", "test"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "drizzle", "brand"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);
const DASHBOARD_ALIAS_ROOT = "apps/dashboard/src";

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'\n]+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

const SERVER_ONLY_MODULES = {
  dashboard: ["node:fs", "node:child_process", "node:net", "pg", "@aws-sdk/"],
  "packages/contracts": ["node:http", "hono", "pg", "@aws-sdk/"],
  "packages/sdk": ["node:http", "hono", "pg", "@aws-sdk/"],
  "packages/domain": ["node:http", "hono", "pg", "@aws-sdk/", "node:fs", "node:child_process", "node:net"],
  "packages/mcp-server": ["node:http", "hono", "pg", "@aws-sdk/"],
  "packages/mcp-apps": [
    "node:http",
    "hono",
    "pg",
    "@aws-sdk/",
    "node:fs",
    "node:child_process",
    "node:net",
    "node:crypto",
  ],
};

function fail(message) {
  console.error(`check-boundaries: ${message}`);
  process.exit(2);
}

function resolveRoot(argv) {
  const flag = argv.indexOf("--root");
  if (flag === -1) return process.cwd();
  const directory = argv[flag + 1];
  if (!directory) fail("--root requires a directory");
  return path.resolve(directory);
}

function sourceFiles(root) {
  const files = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child);
      } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(child);
      }
    }
  };
  for (const directory of SCANNED_DIRS) walk(directory);
  return files.sort();
}

function areaOf(file) {
  if (file.startsWith("apps/dashboard/")) return "dashboard";
  if (file.startsWith("apps/api/")) return "api";
  if (file.startsWith("packages/contracts/")) return "packages/contracts";
  if (file.startsWith("packages/sdk/")) return "packages/sdk";
  if (file.startsWith("packages/domain/")) return "packages/domain";
  if (file.startsWith("packages/mcp-server/")) return "packages/mcp-server";
  if (file.startsWith("packages/mcp-apps/")) return "packages/mcp-apps";
  if (file.startsWith("packages/")) return "packages";
  if (file.startsWith("plugins/opencode/src/")) return "plugin";
  return null;
}

function resolveImport(specifier, file, root) {
  if (specifier.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (specifier.startsWith("@/")) return path.posix.join(DASHBOARD_ALIAS_ROOT, specifier.slice(2));
  if (specifier === "src" || specifier.startsWith("src/")) return specifier;
  const scoped = /^@artiflow\/([^/]+)(?:\/.*)?$/.exec(specifier);
  if (scoped) {
    for (const base of ["packages", "apps"]) {
      if (existsSync(path.join(root, base, scoped[1]))) return `${base}/${scoped[1]}`;
    }
    return `packages/${scoped[1]}`;
  }
  return null;
}

function forbiddenModule(specifier, prefixes) {
  return prefixes.find((prefix) =>
    prefix.endsWith("/") ? specifier.startsWith(prefix) : specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

function within(target, base) {
  return target === base || target.startsWith(`${base}/`);
}

function violationOf(area, specifier, file, root) {
  const serverOnly = SERVER_ONLY_MODULES[area] && forbiddenModule(specifier, SERVER_ONLY_MODULES[area]);
  if (serverOnly) return `server-only module ${serverOnly} is not importable from ${area}`;
  const target = resolveImport(specifier, file, root);
  if (target === null) return null;
  if (
    area === "dashboard" &&
    !within(target, "apps/dashboard") &&
    !within(target, "packages/domain") &&
    !within(target, "packages/contracts") &&
    !within(target, "packages/sdk")
  )
    return `dashboard may only import its own sources and @artiflow/domain, contracts or sdk, not ${target}`;
  if (area === "packages/contracts" && !within(target, "packages/contracts"))
    return `contracts is a leaf: it must not import other packages or app code: ${target}`;
  if (area === "packages/sdk" && !within(target, "packages/sdk") && !within(target, "packages/contracts"))
    return `sdk may only depend on contracts, not ${target}`;
  if (area === "packages" && !target.startsWith("packages/")) return `packages must not import app code: ${target}`;
  if (area === "api" && /^(apps\/dashboard\/|plugins\/|src\/)/.test(target))
    return `api must not import dashboard, plugin or legacy web code: ${target}`;
  if (area === "plugin" && target.startsWith("apps/")) return `plugin must not import app internals: ${target}`;
  return null;
}

const root = resolveRoot(process.argv.slice(2));
const files = sourceFiles(root);
const violations = [];

for (const file of files) {
  const area = areaOf(file);
  if (!area) continue;
  const text = readFileSync(path.join(root, file), "utf8");
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const reason = violationOf(area, match[1], file, root);
      if (!reason) continue;
      const line = text.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}: import "${match[1]}" — ${reason}`);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations.sort()) console.error(violation);
  console.error(`check-boundaries: ${violations.length} forbidden import(s) in ${files.length} files`);
  process.exit(1);
}

console.log(`check-boundaries: ${files.length} files, no forbidden imports`);
