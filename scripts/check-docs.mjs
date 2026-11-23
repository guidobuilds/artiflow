#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KINDS_FILE = "packages/domain/src/kinds.ts";
const TOOLS_FILE = "packages/mcp-server/src/server.ts";
const DOC_ROOTS = [
  "README.md",
  "docs",
  "skills",
  "apps/web/src/content/docs",
  "packages/plugin-core/skills",
  "plugins/opencode",
];

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
  "twenty-five": 25,
  "twenty-six": 26,
  "twenty-seven": 27,
  "twenty-eight": 28,
  "twenty-nine": 29,
  thirty: 30,
};
const NUMBER_PATTERN = Object.keys(NUMBER_WORDS)
  .sort((left, right) => right.length - left.length)
  .join("|");

function fail(message) {
  console.error(`check-docs: ${message}`);
  process.exit(2);
}

function resolveRoot(argv) {
  const flag = argv.indexOf("--root");
  if (flag === -1) return SCRIPT_ROOT;
  const directory = argv[flag + 1];
  if (!directory) fail("--root requires a directory");
  return path.resolve(directory);
}

function readSource(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) fail(`missing source of truth ${relative}`);
  return fs.readFileSync(absolute, "utf8");
}

function readKinds(source) {
  const match = source.match(/export const ARTIFACT_KINDS = \[([^\]]+)\] as const/);
  const kinds = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]) : [];
  if (kinds.length === 0) {
    fail(`could not read ARTIFACT_KINDS from ${KINDS_FILE}; fix the checker against that file`);
  }
  return kinds;
}

function readTools(source) {
  const tools = [...source.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((item) => item[1]);
  const loops = /for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]+)\][\s\S]{0,500}?registerTool\(\s*`([^`]+)`/g;
  for (const match of source.matchAll(loops)) {
    const variable = match[1];
    const names = [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
    for (const name of names) tools.push(match[3].replaceAll(`\${${variable}}`, name));
  }
  const unique = [...new Set(tools)].sort();
  if (unique.length === 0) {
    fail(`could not read registerTool names from ${TOOLS_FILE}; fix the checker against that file`);
  }
  return unique;
}

function markdownFiles(root) {
  const files = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) walk(path.posix.join(relative, entry));
      return;
    }
    if (entryName(relative).endsWith(".md")) files.push(relative);
  };
  for (const entry of DOC_ROOTS) walk(entry);
  return files.sort();
}

function entryName(relative) {
  return relative.slice(relative.lastIndexOf("/") + 1);
}

function maskFences(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function parseNumber(raw) {
  const token = raw.toLowerCase();
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token];
}

function mentionedKinds(text, kinds) {
  const found = [];
  for (const kind of kinds) {
    const pattern = new RegExp(`(?:\`|"|')${kind}(?:\`|"|')|(?<![A-Za-z0-9_])${kind}(?![A-Za-z0-9_])`);
    if (pattern.test(text)) found.push(kind);
  }
  return found;
}

function kindValuePattern(kinds) {
  const token = `[\`'"]?(?:${kinds.join("|")})[\`'"]?`;
  const gap = `(?:[^A-Za-z]|\\b(?:default|or|and|the)\\b)`;
  return new RegExp(`((?:${token}(?:${gap}){1,16})+${token})`, "gi");
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function factViolations(relative, original, kinds, tools) {
  const masked = maskFences(original);
  const violations = [];
  const push = (index, message) => {
    violations.push({ line: lineOf(original, index), message });
  };
  const kindsList = kinds.join(", ");

  const kindCounts = [
    new RegExp(`\\b(${NUMBER_PATTERN}|\\d+)\\s+artifact kinds\\b`, "gi"),
    new RegExp(`\\bof\\s+(${NUMBER_PATTERN}|\\d+)\\s+kinds\\b`, "gi"),
    new RegExp(`\\bone of\\s+(${NUMBER_PATTERN}|\\d+)\\s+kinds\\b`, "gi"),
  ];
  for (const pattern of kindCounts) {
    for (const match of masked.matchAll(pattern)) {
      const count = parseNumber(match[1]);
      if (count === undefined || count === kinds.length) continue;
      push(match.index, `states ${count} artifact kinds, but ${KINDS_FILE} declares ${kindsList}.`);
    }
  }

  for (const match of masked.matchAll(kindValuePattern(kinds))) {
    const listed = mentionedKinds(match[1], kinds);
    if (listed.length < 2 || sameSet(listed, kinds)) continue;
    if (!/\bdefault\b|\|/.test(match[1])) continue;
    const around = masked.slice(Math.max(0, match.index - 160), match.index + match[0].length);
    if (!/\bkind\b/i.test(around)) continue;
    push(
      match.index,
      `lists kind values ${listed.join(", ")} and omits ${kinds.filter((kind) => !listed.includes(kind)).join(", ")}. ${KINDS_FILE} declares ${kindsList}.`,
    );
  }

  const unavailable = new RegExp(
    `\\bother artifact kinds\\b|\\b(?:${kinds.join("|")})\\b(?:[^.\\n]{0,40})\\b(?:is|are)\\s+not available|not available(?: today)?\\s*:\\s*[^\\n.]{0,60}\\b(?:${kinds.join("|")}|other artifact kinds)\\b`,
    "gi",
  );
  for (const match of masked.matchAll(unavailable)) {
    push(match.index, `says a kind is not available, but ${KINDS_FILE} declares ${kindsList}.`);
  }

  const lines = masked.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length;) {
    if (/^\s*[-*]\s+/.test(lines[index] ?? "")) {
      const start = offset;
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push(lines[index]);
        offset += lines[index].length + 1;
        index += 1;
        while (index < lines.length && /^\s+\S/.test(lines[index] ?? "")) {
          items.push(lines[index]);
          offset += lines[index].length + 1;
          index += 1;
        }
      }
      const listed = mentionedKinds(items.join("\n"), kinds);
      const intro = masked.slice(Math.max(0, start - 300), start);
      if (
        listed.length >= 2 &&
        !sameSet(listed, kinds) &&
        /artifact kinds|kinds,\s+chosen|kind is chosen|one of\s+\S+\s+kinds/i.test(intro)
      ) {
        push(
          start,
          `introduces the artifact kinds as ${listed.join(", ")} and omits ${kinds.filter((kind) => !listed.includes(kind)).join(", ")}. ${KINDS_FILE} declares ${kindsList}.`,
        );
      }
      continue;
    }
    offset += (lines[index] ?? "").length + 1;
    index += 1;
  }

  const toolCounts = [
    new RegExp(`\\b(${NUMBER_PATTERN}|\\d+)\\s+tools exist\\b`, "gi"),
    new RegExp(`\\b(${NUMBER_PATTERN}|\\d+)\\s+tools for\\b`, "gi"),
    new RegExp(`\\b(${NUMBER_PATTERN}|\\d+)(?:\\s+[A-Za-z]+){0,3}\\s+mcp tools\\b`, "gi"),
    new RegExp(`\\bregisters?\\s+\\*{0,2}(${NUMBER_PATTERN}|\\d+)\\*{0,2}\\s+(?:mcp\\s+)?tools\\b`, "gi"),
    new RegExp(`^#{1,6}\\s+the\\s+(${NUMBER_PATTERN}|\\d+)\\s+tools\\s*$`, "gim"),
  ];
  for (const pattern of toolCounts) {
    for (const match of masked.matchAll(pattern)) {
      const count = parseNumber(match[1]);
      if (count === undefined || count === tools.length) continue;
      push(match.index, `states ${count} MCP tools, but ${TOOLS_FILE} registers ${tools.length}.`);
    }
  }

  return violations;
}

function linkViolations(root, files) {
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  const violations = [];
  let links = 0;
  for (const relative of files) {
    const text = maskFences(fs.readFileSync(path.join(root, relative), "utf8")).replace(/`[^`\n]*`/g, "");
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1];
      if (!target || target.startsWith("#") || target.startsWith("/")) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const rel = target.split("#")[0].split("?")[0];
      if (!rel) continue;
      links += 1;
      const resolved = path.resolve(path.dirname(path.join(root, relative)), rel);
      if (!fs.existsSync(resolved)) {
        violations.push({
          file: relative,
          line: lineOf(text, match.index),
          message: `broken relative link ${target}.`,
        });
      }
    }
  }
  return { violations, links };
}

const root = resolveRoot(process.argv.slice(2));
const kinds = readKinds(readSource(root, KINDS_FILE));
const tools = readTools(readSource(root, TOOLS_FILE));
const files = markdownFiles(root);
const violations = [];

for (const relative of files) {
  const original = fs.readFileSync(path.join(root, relative), "utf8");
  for (const violation of factViolations(relative, original, kinds, tools)) {
    violations.push({ file: relative, ...violation });
  }
}

const links = linkViolations(root, files);
violations.push(...links.violations);

if (violations.length > 0) {
  const seen = new Set();
  const sorted = violations
    .filter((violation) => {
      const key = `${violation.file}:${violation.line}:${violation.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file)));
  for (const violation of sorted) {
    console.error(
      `${violation.file}:${violation.line}: ${violation.message} Fix the doc from the source of truth (${KINDS_FILE} for kinds, ${TOOLS_FILE} for tools). Do not hardcode a count.`,
    );
  }
  console.error(`check-docs: ${sorted.length} contradiction(s) in ${files.length} files`);
  process.exit(1);
}

console.log(
  `check-docs: ${links.links} relative links in ${files.length} files agree with ${kinds.length} kinds and ${tools.length} tools`,
);
