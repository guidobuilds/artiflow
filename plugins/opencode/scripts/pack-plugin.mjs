#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = ["creating-artifacts", "using-artiflow", "opencode-large-artifacts"];
const FORBIDDEN = [
  { pattern: /\bMCP\b/, label: "MCP" },
  { pattern: /ui:\/\//, label: "MCP Apps resource" },
  { pattern: /staged upload/i, label: "staged upload flow" },
  {
    pattern:
      /\bartifact_(write|commit|get|get_markdown|edit_lines|start_upload|put_chunk|list_comments|add_comment|reply_comment|resolve_comment|unresolve_comment|update_metadata)\b/,
    label: "MCP tool name",
  },
];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function verify() {
  for (const name of SKILLS) {
    const path = join(packageRoot, "skills", name, "SKILL.md");
    if (!existsSync(path)) throw new Error(`Artiflow packaging: plugin skill not found: ${path}`);
    const content = readFileSync(path, "utf8");
    for (const { pattern, label } of FORBIDDEN)
      if (pattern.test(content))
        throw new Error(`Artiflow packaging: plugin skill ${name} is not plugin-scoped (${label}): ${path}`);
  }
}

if (process.argv[2] !== "verify") throw new Error("Usage: pack-plugin.mjs verify");
await verify();
