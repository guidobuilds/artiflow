#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)\)/g;

function markdownFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function withoutCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

const files = [path.join(root, "README.md"), ...markdownFiles(path.join(root, "docs"))];
const broken = [];
let links = 0;

for (const file of files) {
  const text = withoutCode(fs.readFileSync(file, "utf8"));
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (!target || target.startsWith("#") || target.startsWith("/")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const rel = target.split("#")[0].split("?")[0];
    if (!rel) continue;
    links += 1;
    const resolved = path.resolve(path.dirname(file), rel);
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(root, file)}: ${target}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`check-docs: ${broken.length} broken relative link(s)`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`check-docs: ${links} relative links in ${files.length} files are valid`);
