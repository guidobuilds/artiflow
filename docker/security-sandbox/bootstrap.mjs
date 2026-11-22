#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

import { isLoopbackOnly } from "./netns.mjs";

const TARGET_TEST = "docker/security-sandbox/reproducer.integration.ts";
const EXIT_ISOLATION = 10;
const EXIT_SPAWN = 11;
const EXIT_INCOMPLETE = 12;
const INTEGRATION_FIXTURES = [
  "apps/dashboard/src/auth-client.ts",
  "apps/web/src/content/docs/docs/start/quickstart.md",
];
const SUITE_PATH = /^test\/[A-Za-z0-9._-]+\.(test|integration)\.ts$/;
const MAX_SUITES = 32;
const SUITE_CAPTURE_LIMIT = 64 * 1024;
const BASE_PATHS = [
  "/work/package.json",
  "/work/apps/api/src/routes/library.ts",
  "/work/packages/domain/package.json",
  "/work/drizzle/meta/_journal.json",
  "/work/test/helpers/trusted-accounts.ts",
  "/work/node_modules/pg/package.json",
];
const FORBIDDEN_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NODE_OPTIONS",
  "SSH_AUTH_SOCK",
];
const MODE = (process.env.ARTIFLOW_SANDBOX_MODE ?? "reproducer").trim();

function readSelection() {
  if (MODE === "reproducer") {
    if (process.env.ARTIFLOW_SANDBOX_SUITES !== undefined) {
      throw new Error("ARTIFLOW_SANDBOX_SUITES is set in reproducer mode");
    }
    return [TARGET_TEST];
  }
  if (MODE !== "integration") throw new Error(`unknown ARTIFLOW_SANDBOX_MODE: ${MODE}`);
  const raw = (process.env.ARTIFLOW_SANDBOX_SUITES ?? "").trim();
  if (raw === "") throw new Error("integration mode needs ARTIFLOW_SANDBOX_SUITES");
  const files = raw.split(",").map((entry) => entry.trim());
  if (files.length > MAX_SUITES) throw new Error(`${files.length} suites selected, the limit is ${MAX_SUITES}`);
  if (new Set(files).size !== files.length) throw new Error("the suite selection repeats a file");
  for (const file of files) assert(SUITE_PATH.test(file), `refusing ${file}: not a test file under test/`);
  return files;
}

const failures = [];
const selection = { files: [] };
function check(name, fn) {
  try {
    const detail = fn() ?? "";
    console.log(`[bootstrap] ok ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failures.push(name);
    console.error(`[bootstrap] FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const requiredPaths = () => [
  ...BASE_PATHS,
  ...selection.files.map((file) => `/work/${file}`),
  ...(MODE === "integration" ? INTEGRATION_FIXTURES.map((file) => `/work/${file}`) : []),
];
const loopbackUrl = (value, name) => {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${name} is not an absolute URL`);
  }
  assert(["127.0.0.1", "localhost"].includes(url.hostname), `${name} must point at loopback, got ${url.hostname}`);
  return url;
};

check("environment is the sandbox profile", () => {
  assert(process.env.ARTIFLOW_SANDBOX === "1", "ARTIFLOW_SANDBOX marker missing");
  const forbidden = FORBIDDEN_ENV.filter((name) => process.env[name] !== undefined);
  assert(forbidden.length === 0, `host-only variables present: ${forbidden.join(", ")}`);
  const leaked = Object.entries(process.env).filter(([, value]) => /\/Users\/|\/home\/[A-Za-z]/.test(value ?? ""));
  assert(leaked.length === 0, `host paths in env: ${leaked.map(([name]) => name).join(", ")}`);
  return "no host-only variable, no host path value";
});

check("scratch HOME and TMPDIR", () => {
  const home = process.env.HOME ?? "";
  const tmp = process.env.TMPDIR ?? "";
  assert(home.startsWith("/scratch"), `HOME must be under /scratch, got ${home}`);
  assert(tmp === "/tmp", `TMPDIR must be /tmp, got ${tmp}`);
  fs.mkdirSync("/scratch/cache", { recursive: true });
  const probe = "/scratch/.write-probe";
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe);
  return `${home} + ${tmp}, scratch write ok`;
});

check("target selection", () => {
  selection.files = readSelection();
  return `${MODE} mode, ${selection.files.length} target file(s)`;
});

check("payload and toolchain are read-only", () => {
  const targets = requiredPaths();
  for (const target of targets) assert(fs.existsSync(target), `missing ${target}`);
  let refused = false;
  try {
    fs.writeFileSync("/work/apps/api/.sandbox-write-probe", "nope");
    fs.rmSync("/work/apps/api/.sandbox-write-probe", { force: true });
  } catch {
    refused = true;
  }
  assert(refused, "the payload mount accepted a write");
  return `${targets.length} payload paths present, write refused`;
});

check("no host control surfaces are mounted", () => {
  const forbidden = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/work/.git",
    "/work/odd",
    "/work/reports",
    "/work/.env.local",
    "/work/dist",
  ];
  const present = forbidden.filter((entry) => fs.existsSync(entry));
  assert(present.length === 0, `unexpected host surface: ${present.join(", ")}`);
  return "no docker socket, no .git, no env file, no build output";
});

check("only loopback exists in this namespace", () => {
  const optional = (path) => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "");
  const verdict = isLoopbackOnly(
    fs.readFileSync("/proc/net/dev", "utf8"),
    fs.readFileSync("/proc/net/route", "utf8"),
    optional("/proc/net/if_inet6"),
  );
  assert(verdict.isolated, String(verdict.reason));
  return verdict.detail;
});

check("fixture endpoints are loopback", () => {
  const database = loopbackUrl(process.env.DATABASE_URL, "DATABASE_URL");
  const storage = loopbackUrl(process.env.ARTIFLOW_S3_ENDPOINT, "ARTIFLOW_S3_ENDPOINT");
  return `postgres ${database.host} s3 ${storage.host}`;
});

if (failures.length > 0) {
  console.error(`[bootstrap] ${failures.length} isolation check(s) failed; target test not started`);
  process.exit(EXIT_ISOLATION);
}

const children = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

if (MODE !== "integration") {
  console.log(`[bootstrap] target execution starting: node --test ${TARGET_TEST}`);
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", TARGET_TEST], {
    cwd: "/work",
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`[bootstrap] could not spawn the target test: ${error.message}`);
    process.exit(EXIT_SPAWN);
  });
  child.once("exit", (code, signal) => {
    console.log(`[bootstrap] target test exited code=${code} signal=${signal ?? "none"}`);
    process.exit(code ?? EXIT_SPAWN);
  });
} else {
  process.exit(await runIntegrationSuites(selection.files));
}

async function runIntegrationSuites(files) {
  const results = [];
  for (const file of files) {
    const result = await runSuite(file);
    results.push(result);
    console.log(
      `[bootstrap] suite result ${file} verdict=${result.verdict} tests=${result.counts.tests ?? 0} ` +
        `pass=${result.counts.pass ?? 0} fail=${result.counts.fail ?? 0} skipped=${result.counts.skipped ?? 0} ` +
        `exit=${result.exitCode}${result.signal === null ? "" : ` signal=${result.signal}`}`,
    );
    if (result.verdict === "skipped") {
      console.log(`[bootstrap] skip-reason ${file} ${result.reasons.join("; ").slice(0, 480) || "not reported"}`);
    }
  }
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const skipped = count("skipped");
  console.log(
    `[bootstrap] suite summary suites=${results.length} passed=${count("passed")} skipped=${skipped} ` +
      `failed=${count("failed")} notests=${count("no-tests")}`,
  );
  if (skipped > 0) {
    console.error(
      `[bootstrap] incomplete evidence: ${skipped} of ${results.length} suites skipped, so this run is not a pass`,
    );
  }
  if (count("failed") > 0 || count("no-tests") > 0) return 1;
  return skipped > 0 ? EXIT_INCOMPLETE : 0;
}

function runSuite(file) {
  return new Promise((resolve) => {
    console.log(`[bootstrap] suite start ${file}`);
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=180000", file], {
      cwd: "/work",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let captured = "";
    const record = (chunk) => {
      if (captured.length < SUITE_CAPTURE_LIMIT) captured += chunk.slice(0, SUITE_CAPTURE_LIMIT - captured.length);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      record(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      record(chunk);
      process.stderr.write(chunk);
    });
    const finish = (exitCode, signal) => {
      children.delete(child);
      const counts = tally(captured);
      resolve({
        file,
        counts,
        exitCode,
        signal: signal ?? null,
        verdict: verdictOf(exitCode, counts),
        reasons: skipReasons(captured),
      });
    };
    child.once("error", (error) => {
      console.error(`[bootstrap] could not spawn ${file}: ${error.message}`);
      finish(EXIT_SPAWN, null);
    });
    child.once("exit", (code, signal) => finish(code ?? EXIT_SPAWN, signal));
  });
}

function tally(text) {
  const read = (label) => {
    let value = null;
    for (const match of text.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))) value = Number(match[1]);
    return value;
  };
  return {
    tests: read("tests"),
    pass: read("pass"),
    fail: read("fail"),
    skipped: read("skipped"),
    cancelled: read("cancelled"),
  };
}

function skipReasons(text) {
  const reasons = [];
  for (const match of text.matchAll(/# SKIP (.+)$/gm)) {
    const reason = match[1].trim();
    if (reason !== "" && !reasons.includes(reason) && reasons.length < 3) reasons.push(reason);
  }
  return reasons;
}

function verdictOf(exitCode, counts) {
  if (exitCode !== 0) return "failed";
  if (counts.tests === null || counts.tests === 0) return "no-tests";
  if (counts.fail !== 0 || counts.cancelled !== 0 || counts.skipped === null) return "failed";
  return counts.skipped > 0 ? "skipped" : "passed";
}
