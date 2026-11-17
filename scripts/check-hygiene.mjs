#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["ls-files", "-i", "-c", "--exclude-standard"], { encoding: "utf8" });

if (result.status !== 0) {
  console.error(`check-hygiene: git ls-files failed: ${result.stderr.trim()}`);
  process.exit(1);
}

const files = result.stdout
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

if (files.length > 0) {
  console.error("check-hygiene: tracked files match .gitignore:");
  for (const file of files) console.error(`  ${file}`);
  console.error("Remove them from the index or stop ignoring them.");
  process.exit(1);
}

console.log("check-hygiene: no tracked files match .gitignore");
