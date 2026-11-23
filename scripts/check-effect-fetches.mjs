#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DASHBOARD = "apps/dashboard";
const EXTENSIONS = new Set([".ts", ".tsx"]);
const EFFECT_NAMES = new Set(["useEffect", "useLayoutEffect"]);
const REQUEST_PREFIX =
  /^(?:fetch|get|list|read|preview|save|create|delete|revoke|restore|sign|continue|submit|issue|rotate|post|put|patch)(?:[A-Z]|$)/;

function isClientModule(specifier) {
  const base = specifier.split("/").pop() ?? "";
  return /(?:^|-)(?:client|api)\.tsx?$/.test(base);
}

function scriptKindOf(filename) {
  return path.extname(filename) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineOf(text, pos) {
  let line = 1;
  const end = Math.min(pos, text.length);
  for (let index = 0; index < end; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function clientBindings(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isClientModule(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

function calleeName(expression) {
  return ts.isIdentifier(expression) ? expression.text : null;
}

function isRequestName(name) {
  return name === "fetch" || REQUEST_PREFIX.test(name);
}

function effectCallback(node) {
  if (!ts.isCallExpression(node)) return null;
  const called = node.expression;
  const name = ts.isIdentifier(called) ? called.text : ts.isPropertyAccessExpression(called) ? called.name.text : null;
  if (!name || !EFFECT_NAMES.has(name)) return null;
  const callback = node.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return null;
  return callback;
}

function callsInside(node, names) {
  const found = [];
  const visit = (current) => {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current.expression);
      if (name === "fetch" || (names.has(name) && isRequestName(name))) found.push({ name, pos: current.getStart() });
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function findingsInText(filename, text) {
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, scriptKindOf(filename));
  const names = clientBindings(sourceFile);
  const found = [];
  const visit = (node) => {
    const callback = effectCallback(node);
    if (callback) {
      for (const call of callsInside(callback, names)) {
        found.push({ file: filename, line: lineOf(text, call.pos), name: call.name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function trackedDashboardFiles(root) {
  const result = spawnSync("git", ["ls-files", DASHBOARD], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`check-effect-fetches: git ls-files failed: ${(result.stderr ?? "").trim()}`);
    process.exit(2);
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
  const files = requested.length > 0 ? requested.map((file) => path.resolve(file)) : trackedDashboardFiles(root);
  const findings = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`check-effect-fetches: file not found: ${file}`);
      process.exit(2);
    }
    const text = fs.readFileSync(file, "utf8");
    const display = requested.length > 0 ? path.basename(file) : path.relative(root, file);
    for (const finding of findingsInText(file, text)) {
      findings.push({ ...finding, file: display });
    }
  }
  findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  if (findings.length > 0) {
    console.error(`check-effect-fetches: ${findings.length} fetch call(s) inside useEffect`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.name}()`);
    }
    process.exit(1);
  }
  console.log(`check-effect-fetches: no fetch inside useEffect in ${files.length} file(s)`);
}

main();
