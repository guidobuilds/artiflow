#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultAllowlistPath = path.join(repoRoot, "scripts/audit-allowlist.json");
const blockingSeverities = new Set(["high", "critical"]);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const ghsaId = /^GHSA-[A-Za-z0-9-]+$/;

const usage = `usage: node scripts/audit.mjs [options]

  --report <file>      read a captured \`bun audit --json\` report instead of running bun
  --allowlist <file>   allowlist to apply (default: scripts/audit-allowlist.json)
  --now <YYYY-MM-DD>   treat this date as today when checking reviewBy
  --help               print this help and exit 0

exit codes: 0 no unlisted high or critical advisory, 1 unlisted advisory or audit
failure, 2 usage or allowlist error`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    report: null,
    allowlist: defaultAllowlistPath,
    now: new Date().toISOString().slice(0, 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") return { help: true };
    if (arg !== "--report" && arg !== "--allowlist" && arg !== "--now") {
      throw new UsageError(`audit: unknown option ${arg}`);
    }

    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`audit: ${arg} needs a value`);

    if (arg === "--report") options.report = path.resolve(value);
    else if (arg === "--allowlist") options.allowlist = path.resolve(value);
    else if (!isoDate.test(value)) throw new UsageError(`audit: --now expects YYYY-MM-DD, got ${value}`);
    else options.now = value;

    index += 1;
  }

  return options;
}

function readAllowlist(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));

  if (!Array.isArray(parsed)) throw new UsageError(`audit: ${file} must contain a JSON array`);
  if (parsed.length === 0) throw new UsageError(`audit: ${file} is empty`);

  return parsed.map((entry, index) => {
    const where = `audit: ${file} entry ${index + 1}`;

    if (typeof entry?.package !== "string" || entry.package.trim() === "")
      throw new UsageError(`${where} needs a package`);
    if (typeof entry?.advisory !== "string" || !ghsaId.test(entry.advisory)) {
      throw new UsageError(`${where} needs an advisory in the form GHSA-xxxx-xxxx-xxxx`);
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim().length < 20) {
      throw new UsageError(`${where} needs a reason of at least 20 characters`);
    }
    if (typeof entry?.reviewBy !== "string" || !isoDate.test(entry.reviewBy)) {
      throw new UsageError(`${where} needs reviewBy in the form YYYY-MM-DD`);
    }

    return { package: entry.package, advisory: entry.advisory, reason: entry.reason, reviewBy: entry.reviewBy };
  });
}

function readBunAudit() {
  const result = spawnSync("bun", ["audit", "--json"], { cwd: repoRoot, encoding: "utf8" });

  if (result.error) throw new Error(`audit: bun audit could not run: ${result.error.message}`);

  const stdout = result.stdout.trim();
  if (stdout === "") {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`audit: bun audit returned no JSON: ${detail}`);
  }

  return JSON.parse(stdout);
}

function advisoryId(advisory) {
  const match = /\/(GHSA-[A-Za-z0-9-]+)$/.exec(advisory.url ?? "");
  return match ? match[1] : String(advisory.id ?? "unknown");
}

function evaluate(report, allowlist, today) {
  const advisories = [];

  for (const [name, list] of Object.entries(report)) {
    if (!Array.isArray(list)) continue;
    for (const advisory of list) advisories.push({ package: name, id: advisoryId(advisory), advisory });
  }

  const blocking = advisories.filter((finding) =>
    blockingSeverities.has(String(finding.advisory.severity).toLowerCase()),
  );
  const allowed = [];
  const violations = [];

  for (const finding of blocking) {
    const entry = allowlist.find(
      (candidate) => candidate.package === finding.package && candidate.advisory === finding.id,
    );
    if (entry) allowed.push({ finding, entry });
    else violations.push(finding);
  }

  const warnings = [];

  for (const entry of allowlist) {
    const reported = advisories.some((finding) => finding.package === entry.package && finding.id === entry.advisory);

    if (!reported) {
      warnings.push(`allowlist entry ${entry.package} ${entry.advisory} matches no advisory on this tree; remove it`);
      continue;
    }

    if (entry.reviewBy < today) {
      warnings.push(
        `${entry.package} ${entry.advisory} was due for review on ${entry.reviewBy}; look for a patched release`,
      );
    }
  }

  return { advisories, blocking, allowed, violations, warnings };
}

function print(result, options) {
  const noun = result.blocking.length === 1 ? "advisory" : "advisories";
  console.log(`audit: ${result.blocking.length} high or critical ${noun} on the resolved tree`);

  for (const { finding, entry } of result.allowed) {
    console.log(`audit: allowed ${finding.package} ${finding.id} (review by ${entry.reviewBy})`);
  }

  for (const warning of result.warnings) console.log(`audit: warning: ${warning}`);

  for (const finding of result.violations) {
    const { advisory } = finding;
    console.log(
      `audit: ${finding.package} ${advisory.severity} ${finding.id} ${advisory.vulnerable_versions} ${advisory.url}`,
    );
  }

  if (result.violations.length > 0) {
    const noun = result.violations.length === 1 ? "advisory" : "advisories";
    console.error(`audit: ${result.violations.length} high or critical ${noun} not covered by the allowlist`);
    console.error("audit: upgrade the package, or document the exception in scripts/audit-allowlist.json");
    return 1;
  }

  console.log(`audit: ok, every high or critical advisory is allowlisted (today: ${options.now})`);
  return 0;
}

function main(argv) {
  let options;

  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage);
      return 0;
    }

    const allowlist = readAllowlist(options.allowlist);
    const report = options.report ? JSON.parse(readFileSync(options.report, "utf8")) : readBunAudit();
    return print(evaluate(report, allowlist, options.now), options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
