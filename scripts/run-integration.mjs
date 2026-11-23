#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { missingIntegrationEnv, readIntegrationEnvNames } from "./integration-env.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reporter = path.join(repoRoot, "scripts/integration-reporter.mjs");
const defaultFiles = ["test/*.test.ts", "test/*.integration.ts"];

const usage = `usage: node --env-file=test/integration-config.example scripts/run-integration.mjs [--file <path>...]

Runs test/*.test.ts and test/*.integration.ts serially against the disposable stack.
Exits 1 when any variable declared in test/integration-config.example is missing or
blank, or when any test skips. A skip is not a pass.
--file replaces the default globs; repeat it for more than one file.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true, files };
    if (arg !== "--file") throw new UsageError(`integration: unknown option ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError("integration: --file needs a path");
    files.push(value);
    index += 1;
  }
  return { help: false, files: files.length > 0 ? files : defaultFiles };
}

function displayFile(file) {
  const marker = `${path.sep}test${path.sep}`;
  const index = file.lastIndexOf(marker);
  return index === -1 ? file : file.slice(index + 1);
}

function readSkipReport(reportPath) {
  try {
    const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
    return Array.isArray(parsed?.skipped) ? parsed.skipped : null;
  } catch {
    return null;
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }

  let names;
  try {
    names = readIntegrationEnvNames();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const missing = missingIntegrationEnv(process.env, names);
  if (missing.length > 0) {
    console.error(`integration: missing required environment: ${missing.join(", ")}`);
    console.error(
      "integration: refusing to run. A skipped test does not prove the invariant; set every variable in test/integration-config.example.",
    );
    return 1;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "artiflow-integration-"));
  const reportPath = path.join(dir, "skips.json");
  const reporterOutput = path.join(dir, "reporter.txt");
  let child;
  let skipped = null;
  try {
    child = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter",
        reporter,
        "--test-reporter-destination",
        reporterOutput,
        ...options.files,
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, ARTIFLOW_INTEGRATION_SKIP_REPORT: reportPath },
      },
    );
    skipped = readSkipReport(reportPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (child.error) {
    console.error(`integration: failed to start the test runner: ${child.error.message}`);
    return 1;
  }

  if (skipped === null) {
    const status = child.status ?? "signal";
    console.error(
      child.status
        ? `integration: test run failed with exit ${status} before a skip report was written`
        : "integration: the skip report was not written; refusing to treat the run as complete",
    );
    return child.status && child.status !== 0 ? child.status : 1;
  }

  if (skipped.length > 0) {
    console.error(`integration: ${skipped.length} test(s) skipped; a skip does not prove the invariant`);
    for (const item of skipped.slice(0, 30)) {
      const where = item.file ? `${displayFile(item.file)} ` : "";
      console.error(`  ${where}${item.name} (${item.reason})`);
    }
    if (skipped.length > 30) console.error(`  and ${skipped.length - 30} more`);
  }

  if (child.status !== 0) {
    console.error(`integration: test run failed with exit ${child.status ?? "signal"}`);
    return child.status ?? 1;
  }
  if (skipped.length > 0) return 1;

  console.log("integration: passed with no skipped tests");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
