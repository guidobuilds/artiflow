#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDist = path.join(webRoot, "dist");
const SITE_ORIGIN = "https://artiflow.dev";
const USAGE = "Usage: node apps/web/scripts/check-built.mjs [distDir]";
const HELP = `check-built: verify the links of the built @artiflow/web site.

${USAGE}

Arguments and options:
  distDir       Built site to verify. Default: apps/web/dist.
  -h, --help    Print this help.

Checks:
  Every local href and src in the built HTML resolves to a file or route in distDir,
  and every fragment resolves to an element id on its page. Paths under
  ${SITE_ORIGIN} are internal and verified like any other path. Any other
  remote URL or special scheme (http, https, mailto, tel, data, javascript,
  protocol-relative) is skipped, and text inside a code sample is not a reference.

Output:
  stdout: one summary line when everything resolves.
  stderr: one line per problem, then a count. Nothing in distDir is written or moved.

Exit codes:
  0  verified
  1  problems found in the build
  2  usage error or unreadable input
`;

function parseArgs(argv) {
  let dist = defaultDist;
  const positional = [];

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    positional.push(arg);
  }

  if (positional.length > 1) return { error: `unexpected argument: ${positional[1]}` };
  if (positional.length === 1) dist = path.resolve(positional[0]);
  return { dist };
}

function htmlFiles(dist) {
  const files = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) files.push(path.relative(dist, full).split(path.sep).join("/"));
    }
  };
  walk(dist);
  return files;
}

function pageUrlPath(relative) {
  const dir = path.posix.dirname(relative);
  if (path.posix.basename(relative) !== "index.html") return `/${relative}`;
  return dir === "." ? "/" : `/${dir}/`;
}

function targetFile(dist, urlPath) {
  const base = path.resolve(dist);
  const clean = urlPath.replace(/\/{2,}/g, "/");
  const relative = clean.replace(/^\/+/, "");
  const candidates =
    relative === ""
      ? ["index.html"]
      : clean.endsWith("/")
        ? [`${relative}index.html`, `${relative.slice(0, -1)}.html`]
        : [relative, `${relative}/index.html`, `${relative}.html`];

  for (const candidate of candidates) {
    const file = path.resolve(base, candidate);
    if (!file.startsWith(base + path.sep)) continue;
    if (existsSync(file) && statSync(file).isFile()) return { file, relative: candidate };
  }
  return null;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withoutCodeSamples(html) {
  return html.replace(/<pre\b[\s\S]*?<\/pre>/g, "");
}

function idsIn(file, cache) {
  const cached = cache.get(file);
  if (cached) return cached;
  const found = new Set();
  for (const match of withoutCodeSamples(readFileSync(file, "utf8")).matchAll(
    /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    found.add(match[1] ?? match[2] ?? "");
  }
  cache.set(file, found);
  return found;
}

function localReference(value) {
  if (value === SITE_ORIGIN) return "/";
  if (
    value.startsWith(`${SITE_ORIGIN}/`) ||
    value.startsWith(`${SITE_ORIGIN}?`) ||
    value.startsWith(`${SITE_ORIGIN}#`)
  ) {
    return value.slice(SITE_ORIGIN.length);
  }
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) ? null : value;
}

function checkHtml(dist, relative, problems, cache) {
  const file = path.join(dist, relative);
  const pagePath = pageUrlPath(relative);
  let checked = 0;

  const html = withoutCodeSamples(readFileSync(file, "utf8"));
  for (const match of html.matchAll(/(?:^|\s)(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const attribute = match[1];
    const value = (match[2] ?? match[3] ?? "").replace(/&amp;/g, "&");
    const local = localReference(value);
    if (local === null || local === "") continue;
    checked += 1;

    const hashIndex = local.indexOf("#");
    const fragment = hashIndex === -1 ? "" : decode(local.slice(hashIndex + 1));
    const withoutFragment = hashIndex === -1 ? local : local.slice(0, hashIndex);
    const queryIndex = withoutFragment.indexOf("?");
    const pathPart = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);

    let urlPath = pagePath;
    let target = { file, relative };
    if (pathPart !== "") {
      urlPath = pathPart.startsWith("/") ? pathPart : new URL(pathPart, `${SITE_ORIGIN}${pagePath}`).pathname;
      target = targetFile(dist, urlPath);
    }

    if (target === null) {
      const lastSegment = urlPath.slice(urlPath.lastIndexOf("/") + 1);
      const kind = attribute === "src" || lastSegment.includes(".") ? "missing asset" : "missing route";
      problems.push(`${kind}: ${relative} -> ${value}`);
      continue;
    }

    if (fragment !== "" && target.file.endsWith(".html") && !idsIn(target.file, cache).has(fragment)) {
      problems.push(`missing anchor: ${relative} -> ${value}`);
    }
  }

  return checked;
}

function usageError(message) {
  process.stderr.write(`check-built: ${message}\n${USAGE}\n`);
  return 2;
}

function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.error) return usageError(options.error);
  if (!existsSync(options.dist) || !statSync(options.dist).isDirectory()) {
    return usageError(`dist directory not found: ${options.dist}`);
  }

  const problems = [];
  const files = htmlFiles(options.dist);
  let checked = 0;
  if (files.length === 0) {
    problems.push(`missing output: ${options.dist} has no HTML files`);
  } else {
    const cache = new Map();
    for (const relative of files) checked += checkHtml(options.dist, relative, problems, cache);
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`check-built: ${problems.length} problem${problems.length === 1 ? "" : "s"} found\n`);
    return 1;
  }

  const html = `${files.length} HTML file${files.length === 1 ? "" : "s"}`;
  const urls = `${checked} local URL${checked === 1 ? "" : "s"}`;
  process.stdout.write(`check-built: ${html} and ${urls} are valid\n`);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
