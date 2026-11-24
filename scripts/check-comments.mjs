#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-legacy";

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".html"]);
const JS_SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/jscript"]);

const LINE_DIRECTIVES = [
  new RegExp("^/\\s*<(reference|amd-module|amd-dependency)\\b"),
  new RegExp("^@ts-expect-error\\s+\\S"),
  new RegExp("^@(ts-ignore|ts-nocheck|ts-check)\\b"),
  new RegExp("^eslint-(disable|enable|env)(-next-line|-line)?\\b"),
  new RegExp("^oxlint-(disable|enable)(-next-line|-line)?\\b"),
  new RegExp("^biome-ignore\\b"),
  new RegExp("^prettier-ignore\\b"),
  new RegExp("^@(vitest-environment|jest-environment)\\b"),
  new RegExp("^@(jsx|jsxImportSource|jsxFrag|jsxRuntime)\\b"),
  new RegExp("^(c8|istanbul|v8)\\s+ignore\\b"),
  new RegExp("^node:coverage\\b"),
  new RegExp("^webpack(ChunkName|Ignore|Mode|Prefetch|Preload|Exports)\\b"),
  new RegExp("^@vite-ignore\\b"),
  new RegExp("^@(?:__PURE__|preserve|license)\\b"),
  new RegExp("^#__PURE__$"),
  new RegExp("^#\\s*sourceMappingURL\\b"),
  new RegExp("^#\\s*sourceURL\\b"),
  new RegExp("^SPDX-License-Identifier\\s*:"),
  new RegExp("^Copyright\\b"),
];

const COMMENT_TRIVIA = new Set([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia]);

function scriptKindOf(filename) {
  const extension = path.extname(filename);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function commentBodyLines(raw) {
  if (raw.startsWith("//")) return [raw.slice(2)];
  const inner = raw.slice(2, Math.max(2, raw.length - 2));
  return inner.split("\n").map((line) => line.replace(/^\s*\* ?/, ""));
}

function allowedComment(raw) {
  const lines = commentBodyLines(raw)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => LINE_DIRECTIVES.some((pattern) => pattern.test(line)));
}

function lineOf(text, pos) {
  let line = 1;
  const end = Math.min(pos, text.length);
  for (let index = 0; index < end; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function displayText(raw) {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function triviaComments(text, sourceFile) {
  const found = [];
  const visit = (node) => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      const from = node.getFullStart();
      const to = node.getStart(sourceFile, false);
      if (to > from) {
        const trivia = text.slice(from, to);
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, trivia);
        while (true) {
          const token = scanner.scan();
          if (token === ts.SyntaxKind.EndOfFileToken) break;
          if (token === ts.SyntaxKind.ShebangTrivia) continue;
          if (!COMMENT_TRIVIA.has(token)) continue;
          const start = from + scanner.getTokenStart();
          const raw = text.slice(start, from + scanner.getTextPos());
          found.push({ pos: start, raw });
        }
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  return found;
}

function parsedComments(fragment, ignoreProtocolComments) {
  const sourceFile = ts.createSourceFile("fragment.js", fragment, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  for (const comment of triviaComments(fragment, sourceFile)) {
    if (ignoreProtocolComments && comment.raw.startsWith("//") && fragment[comment.pos - 1] === ":") continue;
    if (!allowedComment(comment.raw)) found.push(comment);
  }
  return found;
}

function templateParts(node, text) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart() + 1;
    const end = node.getEnd() - 1;
    return [{ text: text.slice(start, Math.max(start, end)), start }];
  }
  const parts = [];
  const headStart = node.head.getStart() + 1;
  const headEnd = node.head.getEnd() - 2;
  parts.push({ text: text.slice(headStart, Math.max(headStart, headEnd)), start: headStart });
  for (const span of node.templateSpans) {
    const literal = span.literal;
    const tail = ts.isTemplateTail(literal);
    const start = literal.getStart() + 1;
    const end = literal.getEnd() - (tail ? 1 : 2);
    parts.push({ text: text.slice(start, Math.max(start, end)), start });
  }
  return parts;
}

function reconstruct(parts) {
  let out = "";
  const segments = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    segments.push({ out: out.length, src: part.start, len: part.text.length });
    out += part.text;
    if (index < parts.length - 1) out += "0";
  }
  return { out, segments };
}

function mapPosition(segments, outPos) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (outPos >= segment.out && outPos < segment.out + segment.len) {
      return segment.src + (outPos - segment.out);
    }
  }
  return null;
}

function scriptAttributeType(attributes) {
  const match = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes);
  if (!match) return "";
  return (match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase();
}

function looksLikeJavaScript(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("#!")) return true;
  return /^(?:["']use strict["']|(?:export\s+|async\s+)?(?:function|class)\b|(?:export\s+)?(?:const|let|var|import|return|if|for|while|switch|try|throw)\b)/.test(
    trimmed,
  );
}

function protocolRelative(text, pos) {
  return text[pos - 1] === ":";
}

function looseLineComments(text) {
  const found = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "/" || text[index + 1] !== "/" || protocolRelative(text, index)) continue;
    const end = text.indexOf("\n", index);
    const raw = text.slice(index, end === -1 ? text.length : end);
    if (!allowedComment(raw)) found.push({ pos: index, raw });
    index = end === -1 ? text.length : end;
  }
  return found;
}

function isTagNameChar(char) {
  return char !== undefined && char >= "0" && char <= "9";
}

function findTag(lower, token, from) {
  let cursor = from;
  while (cursor < lower.length) {
    const at = lower.indexOf(token, cursor);
    if (at === -1) return -1;
    const next = lower[at + token.length];
    const continuesName = next !== undefined && ((next >= "a" && next <= "z") || isTagNameChar(next));
    if (!continuesName) return at;
    cursor = at + token.length;
  }
  return -1;
}

function scriptElements(text) {
  const lower = text.toLowerCase();
  const elements = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = findTag(lower, "<script", cursor);
    if (open === -1) break;
    const nameEnd = open + "<script".length;
    const openEnd = text.indexOf(">", nameEnd);
    if (openEnd === -1) break;
    const close = findTag(lower, "</script", openEnd + 1);
    if (close === -1) break;
    let end = close + "</script".length;
    while (end < text.length && " \t\n\r\f".includes(text[end] ?? "")) end += 1;
    if (text[end] !== ">") {
      cursor = close + "</script".length;
      continue;
    }
    elements.push({
      attributes: text.slice(nameEnd, openEnd),
      body: text.slice(openEnd + 1, close),
      bodyAt: openEnd + 1,
    });
    cursor = end + 1;
  }
  return elements;
}

function scriptBodyComments(text) {
  const found = [];
  for (const element of scriptElements(text)) {
    if (!JS_SCRIPT_TYPES.has(scriptAttributeType(element.attributes))) continue;
    for (const comment of parsedComments(element.body, true)) {
      found.push({ pos: element.bodyAt + comment.pos, raw: comment.raw });
    }
  }
  return found;
}

function commentsInEmbedded(reconstructed) {
  if (findTag(reconstructed.toLowerCase(), "<script", 0) !== -1) return scriptBodyComments(reconstructed);
  if (looksLikeJavaScript(reconstructed)) return parsedComments(reconstructed, true);
  return looseLineComments(reconstructed);
}

function commentsInSource(filename, text) {
  const extension = path.extname(filename);
  if (extension === ".html") {
    const { out, segments } = reconstruct([{ text, start: 0 }]);
    return commentsInEmbedded(out).flatMap((comment) => {
      const pos = mapPosition(segments, comment.pos);
      return pos === null ? [] : [{ pos, raw: comment.raw }];
    });
  }
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, scriptKindOf(filename));
  const found = triviaComments(text, sourceFile).filter((comment) => !allowedComment(comment.raw));
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const { out, segments } = reconstruct(templateParts(node, text));
      for (const comment of commentsInEmbedded(out)) {
        const pos = mapPosition(segments, comment.pos);
        if (pos !== null) found.push({ pos, raw: comment.raw });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findingsInFile(filename, root) {
  const text = fs.readFileSync(filename, "utf8");
  const relative = path.relative(root, filename);
  const display = relative.startsWith("..") ? filename : relative;
  return commentsInSource(filename, text).map((comment) => ({
    file: display,
    line: lineOf(text, comment.pos),
    text: displayText(comment.raw),
  }));
}

function trackedSourceFiles(root) {
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`check-comments: git ls-files failed: ${(result.stderr ?? "").trim()}`);
    process.exit(1);
  }
  return result.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file && EXTENSIONS.has(path.extname(file)))
    .map((file) => path.join(root, file));
}

function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const requested = process.argv.slice(2);
  const files = requested.length > 0 ? requested.map((file) => path.resolve(file)) : trackedSourceFiles(root);
  const findings = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`check-comments: file not found: ${file}`);
      process.exit(1);
    }
    findings.push(...findingsInFile(file, requested.length > 0 ? process.cwd() : root));
  }
  findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  if (findings.length > 0) {
    console.error(`check-comments: ${findings.length} disallowed comment(s)`);
    for (const finding of findings) console.error(`  ${finding.file}:${finding.line}: ${finding.text}`);
    process.exit(1);
  }
  console.log(`check-comments: no disallowed comments in ${files.length} file(s)`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) main();
