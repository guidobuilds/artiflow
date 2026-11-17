#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = path.resolve(webRoot, "..", "..");
const CONFIG_SOURCE = "apps/api/src/config.ts";
const CONFIG_REFERENCE = "apps/web/src/content/docs/docs/reference/configuration.md";
const USAGE = "Usage: node apps/web/scripts/check-reference.mjs [--root <dir>]";
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
const HELP = `check-reference: verify the published configuration reference.

${USAGE}

Options:
  --root <dir>  Directory holding ${CONFIG_SOURCE} and
                ${CONFIG_REFERENCE}. Default: the repository root.
  -h, --help    Print this help.

Checks:
  Every environment variable read in ${CONFIG_SOURCE} appears in the
  "API process variables" section of the reference, and every variable that section
  documents is read by that source.

Output:
  stdout: one summary line when they match.
  stderr: one line per problem, then a count. No file is written.

Exit codes:
  0  matched
  1  problems found
  2  usage error or unreadable input
`;

class InputError extends Error {}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new InputError(`cannot read ${file}`);
  }
}

function parseArgs(argv) {
  let root = defaultRoot;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined) return { error: "--root needs a directory" };
      root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("-")) {
      return { error: `unknown option: ${arg}` };
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }

  return { root };
}

function configNames(root) {
  const text = readText(path.join(root, CONFIG_SOURCE));
  const names = new Set();
  for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  for (const match of text.matchAll(new RegExp(`"(${NAME})"`, "g"))) names.add(match[1]);
  return names;
}

function documentedNames(root) {
  const text = readText(path.join(root, CONFIG_REFERENCE));
  const start = text.indexOf("## API process variables");
  if (start === -1) {
    throw new InputError(`cannot find the "## API process variables" section in ${CONFIG_REFERENCE}`);
  }
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  const names = new Set();
  for (const match of section.matchAll(new RegExp(`\`(${NAME})\``, "g"))) names.add(match[1]);
  return names;
}

function usageError(message) {
  process.stderr.write(`check-reference: ${message}\n${USAGE}\n`);
  return 2;
}

function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.error) return usageError(options.error);

  const source = configNames(options.root);
  const documented = documentedNames(options.root);

  const problems = [];
  for (const name of [...source].filter((entry) => !documented.has(entry)).sort()) {
    problems.push(`missing configuration variable: ${name} (read in ${CONFIG_SOURCE})`);
  }
  for (const name of [...documented].filter((entry) => !source.has(entry)).sort()) {
    problems.push(
      `stale configuration variable: ${name} (documented in configuration.md, not read in ${CONFIG_SOURCE})`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`check-reference: ${problems.length} problem${problems.length === 1 ? "" : "s"} found\n`);
    return 1;
  }

  process.stdout.write(`check-reference: ${documented.size} configuration variables match ${CONFIG_REFERENCE}\n`);
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof InputError) process.exitCode = usageError(error.message);
  else throw error;
}
