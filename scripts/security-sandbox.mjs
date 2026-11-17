#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUIRE = createRequire(path.join(ROOT, "package.json"));
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const PREFIX = `gui598-sandbox-${RUN_ID}`;
const MAX_CAPTURE = 512 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const TARGET_CAPTURE_SUITE = 8 * 1024 * 1024;
const IMAGES = {
  node: "node:24-bookworm-slim",
  postgres: "postgres:16-alpine",
  garage: "dxflrs/garage:v2.4.1",
};
const BASE_PAYLOAD = [
  { host: "package.json", mount: "/work/package.json" },
  { host: "apps/api", mount: "/work/apps/api" },
  { host: "packages", mount: "/work/packages" },
  { host: "drizzle", mount: "/work/drizzle" },
  { host: "test/helpers", mount: "/work/test/helpers" },
  { host: "node_modules", mount: "/work/node_modules" },
];
const fileMount = (host) => ({ host, mount: `/work/${host}` });
const INTEGRATION_SUITES = [
  "test/i5b4-delete.test.ts",
  "test/library-http.integration.ts",
  "test/comments-http.integration.ts",
  "test/artifact-tools.integration.ts",
  "test/docs-quickstart.integration.ts",
  "test/editing-http.integration.ts",
  "test/i5c2-shared.test.ts",
  "test/i5b3-share.test.ts",
  "test/artifact-viewer-bearer.integration.ts",
  "test/v1-bearer.integration.ts",
];
const INTEGRATION_EXTRA_FILES = [
  "apps/dashboard/src/auth-client.ts",
  "apps/web/src/content/docs/docs/start/quickstart.md",
];
const TOOLING = [
  { host: "docker/security-sandbox/bootstrap.mjs", mount: "/sandbox/bootstrap.mjs" },
  { host: "docker/security-sandbox/netns.mjs", mount: "/sandbox/netns.mjs" },
  { host: "docker/security-sandbox/garage.toml", mount: "/etc/garage.toml" },
];
const REQUIRED_SPECIFIERS = [
  "@artiflow/contracts/artifacts",
  "@artiflow/domain/markdown",
  "@aws-sdk/client-s3",
  "@hono/node-server",
  "better-auth",
  "better-auth/crypto",
  "drizzle-orm/node-postgres",
  "drizzle-orm/node-postgres/migrator",
  "hono",
  "pg",
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
];
const DUMMY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TARGET_ENV = {
  NODE_ENV: "development",
  ARTIFLOW_DEMO_AUTH: "1",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/scratch",
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/scratch/cache",
  npm_config_cache: "/scratch/npm",
  ARTIFLOW_SANDBOX: "1",
  DATABASE_URL: "postgres://artiflow_sandbox:artiflow_sandbox_local_only@127.0.0.1:5432/artiflow",
  ARTIFLOW_S3_ENDPOINT: "http://127.0.0.1:9000",
  ARTIFLOW_S3_REGION: "us-east-1",
  ARTIFLOW_S3_BUCKET: "artiflow-sandbox",
  ARTIFLOW_S3_ACCESS_KEY_ID: "GK0123456789abcdef0123456789",
  ARTIFLOW_S3_SECRET_ACCESS_KEY: DUMMY_SECRET,
  ARTIFLOW_S3_FORCE_PATH_STYLE: "1",
  ARTIFLOW_AUTH_SECRET: "artiflow-sandbox-only-not-a-production-secret",
  ARTIFLOW_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
};
const POSTGRES_ENV = {
  POSTGRES_DB: "artiflow",
  POSTGRES_USER: "artiflow_sandbox",
  POSTGRES_PASSWORD: "artiflow_sandbox_local_only",
};
const GARAGE_ENV = {
  GARAGE_CONFIG_FILE: "/etc/garage.toml",
  GARAGE_DEFAULT_ACCESS_KEY: TARGET_ENV.ARTIFLOW_S3_ACCESS_KEY_ID,
  GARAGE_DEFAULT_SECRET_KEY: DUMMY_SECRET,
  GARAGE_DEFAULT_BUCKET: TARGET_ENV.ARTIFLOW_S3_BUCKET,
  HOME: "/var/lib/garage",
};
const EXIT = {
  passed: 2,
  unexpected: 3,
  setup: 4,
  usage: 5,
  timedOut: 6,
  cleanup: 7,
  incomplete: 8,
};
const MODES = {
  reproducer: {
    name: "reproducer",
    extraPayload: [fileMount("docker/security-sandbox/reproducer.integration.ts")],
    env: {},
    timeoutSeconds: 600,
  },
  integration: {
    name: "integration",
    extraPayload: [...INTEGRATION_SUITES.map(fileMount), ...INTEGRATION_EXTRA_FILES.map(fileMount)],
    env: { ARTIFLOW_SANDBOX_MODE: "integration", ARTIFLOW_SANDBOX_SUITES: INTEGRATION_SUITES.join(",") },
    timeoutSeconds: 2400,
  },
};
let activeMode = MODES.reproducer;
let payload = [...BASE_PAYLOAD, ...activeMode.extraPayload];
let targetEnv = { ...TARGET_ENV };

function selectMode(name) {
  activeMode = MODES[name];
  payload = [...BASE_PAYLOAD, ...activeMode.extraPayload];
  targetEnv = { ...TARGET_ENV, ...activeMode.env };
}
const MARKERS = {
  control: "control: sequential identical content",
  race: "race: DELETE paused between the ownership decision and the byte delete",
  regressed: "GUI598_INVARIANT_REGRESSED",
};

const HELP = `Disposable sandbox (no product change, no host network, no published ports)

Usage:
  node scripts/security-sandbox.mjs --help
  node scripts/security-sandbox.mjs --preflight [--suite reproducer|integration]
  node scripts/security-sandbox.mjs --dry-run [--suite reproducer|integration]
  node scripts/security-sandbox.mjs [--suite reproducer|integration] [--timeout-seconds=600]
                                    [--min-free-gb=5] [--evidence-dir=<absolute path>]

Suites
  reproducer (default): runs docker/security-sandbox/reproducer.integration.ts, the
    acceptance proof. Exit 2 means control and race both passed, with no skip: a skipped
    reproducer test is never a pass either, so it exits 8 as incomplete evidence.
  integration: runs the ten suites that read the per-revision key contract, one file at a
    time, against the same throwaway PostgreSQL and Garage:
${INTEGRATION_SUITES.map((suite) => `      ${suite}`).join("\n")}
    Each suite file is mounted on its own; the whole test/ directory is never mounted. Exit 2
    means every selected suite ran and passed with zero skips. A suite that skipped (missing
    environment inside the sandbox) is reported as skipped and never as a pass: the run exits 8
    with the count and the reason, because that evidence proves nothing about the skipped suite.
    Default wall clock in this mode is 2400s (reproducer: 600s); --timeout-seconds overrides both.

What it does
  1. Preflight (no container): local images, architecture, Node major, payload allowlist,
     node_modules symlinks, required module resolution, target environment against
     test/integration-config.example, disk headroom.
  2. Create a fresh --network none container as the namespace anchor (loopback only).
  3. Start throwaway PostgreSQL and Garage inside that namespace (tmpfs state, dummy
     credentials, no volumes, no published ports, no external route).
  4. Run the selected target (the reproducer, or the integration suites one at a time) in a
     read-only container with only an explicit environment allowlist, a scratch HOME/TMPDIR,
     dropped capabilities, no-new-privileges, non-root user and CPU/memory/pids/file-size/disk/
     wall limits.
  5. Remove exactly the containers this run created, by id, on success, failure, timeout or
     signal. No prune, no global cleanup, no deletion of unrelated containers.

Both modes mount the same isolation controls; only the payload files, the two
ARTIFLOW_SANDBOX_* selection values and the target command differ. Nothing the sandbox mounts
is writable, and no mount is ever .env, .git, $HOME, a socket or the whole repository.

Retained evidence (S5)
  The sandbox is destroyed either way, so the runner writes its own record first, outside the
  sandbox and outside the repository worktree:
    <dir>/gui598-<run-id>.log   combined runner log and target output, capped at 512 KiB
    <dir>/gui598-<run-id>.json  verdict: run id, mode, exit code, wall time, control/race outcome
                                (reproducer) or per-suite results (integration), isolation verdict,
                                effective limits and per-container result
  Default directory: a fresh mkdtemp under the OS temp dir, reported on stdout. --evidence-dir
  must be an absolute path that does not exist yet and must not resolve inside the repository.
  Both files are created exclusively (O_EXCL, mode 0600) and never overwritten.
  Only values the target already receives are recorded: no host credential, no ambient host
  environment, no .env content. Cleanup deletes container bytes only; the evidence files stay.
  A verbose integration run can hit the log cap (the verdict records truncated: true); the JSON
  verdict keeps the per-suite summary either way, because that is what classifies the run.

Prerequisites (never installed or pulled by this script)
  - Docker server 24+ reachable through the local Docker CLI (a Docker Desktop daemon is fine).
  - Local images, exact tags: ${Object.values(IMAGES).join(", ")}.
  - Host Node 24+ for orchestration; the target runs the container's own Node.
  - Free host disk for the bounded writable footprint (services 256m + 192m + 16m tmpfs,
    target 64m + 256m tmpfs; roughly 1 GiB worst case) plus the >= --min-free-gb check.

Expected outcome (--suite reproducer, the default)
  Both tests assert the fixed invariant. Content is stored under one key per revision, so the race
  test pauses A's DELETE after the ownership decision and the soft-delete commit, has B write
  byte-identical content during the pause, and then asserts that B still answers 200 with the exact
  original bytes once A's delete resumes, while a bounded storage listing shows only A's own key
  removed. Control and race must both pass: exit 2 means the invariant held on this build.
  A race failure is a regression of the fix, never a reproduced bug: exit 3, with
  ${MARKERS.regressed} naming the failed assertion when it is present.

Expected outcome (--suite integration)
  bootstrap refuses to start anything until the isolation gate passes, then runs each selected
  suite in its own node --test process and prints one [bootstrap] suite result line per file
  plus a [bootstrap] suite summary suites= passed= skipped= failed= notests= line. The runner
  reads that summary and nothing else: exit 2 only when every suite ran and passed, 3 when any
  suite failed or reported no tests, 8 when a suite skipped (counted, never a pass).
  Neither mode accepts a skip: the reproducer's control and race tests must run, because a
  skipped invariant proves nothing about the fix.

Exit codes
  2 accepted verdict: the reproducer held its invariant (control and race both passed), or every
    selected integration suite ran and passed with zero skips
  3 unexpected target failure: race regression, race failure without ${MARKERS.regressed},
    red control, missing test, a failed integration suite or one that produced no tests
  4 preflight or setup failure, including bootstrap isolation exits 10/11 and a selection that
    executed zero suites: zero target tests, attempt preserved, no auto-retry
  5 usage error
  6 wall-clock limit reached: target killed, run-owned containers removed
  7 cleanup incomplete: containers may remain, listed by exact id/name
  8 evidence incomplete: at least one selected integration suite, or one reproducer test, was
    skipped (directive in the TAP line), so the verdict states how many and why; a skip is never
    reported as a pass

Cleanup guarantees and limitations
  - Tracked containers are removed by exact id in reverse creation order, in a finally block,
    on SIGINT/SIGTERM/SIGHUP and on the wall-clock timeout.
  - Cleanup removes container bytes only. The evidence files written under the evidence
    directory are host files and survive the run: they are the retained result (S5).
  - SIGKILL of this process cannot be trapped; then containers named ${PREFIX}-* may remain.
    Recover with: docker ps -a --filter "name=${PREFIX}-" (inspect by exact id), then
    docker rm -f <exact-id> per container. This script never runs prune or a broad rm.
  - Garage and PostgreSQL state lives on tmpfs inside the containers, so no named volume and
    no host directory is created or left behind.

Nothing here changes the product; the sandbox only observes the current source.
`;

const created = [];
const state = { anchor: null, postgres: null, garage: null, target: null, wallTimer: null, isolation: null, targetSummary: null };
let cleanupPromise = null;
const evidence = { dir: null, logPath: null, verdictPath: null, fd: null, bytes: 0, truncated: false, finished: false };

function evidenceAppend(text) {
  if (evidence.fd === null || evidence.finished) return;
  const buffer = Buffer.from(String(text), "utf8");
  const remaining = MAX_EVIDENCE_BYTES - evidence.bytes;
  if (remaining <= 0) {
    evidence.truncated = true;
    return;
  }
  if (buffer.length > remaining) evidence.truncated = true;
  const piece = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  fs.writeSync(evidence.fd, piece);
  evidence.bytes += piece.length;
}

const log = (message) => {
  const line = `[sandbox] ${message}`;
  console.log(line);
  evidenceAppend(`${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SetupError extends Error {}
class TimeoutError extends SetupError {}
class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    help: false,
    preflight: false,
    dryRun: false,
    suite: "reproducer",
    timeoutSeconds: null,
    minFreeGb: 5,
    evidenceDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--preflight") options.preflight = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (/^--timeout-seconds=\d+$/.test(arg)) options.timeoutSeconds = Number(arg.split("=")[1]);
    else if (/^--min-free-gb=\d+$/.test(arg)) options.minFreeGb = Number(arg.split("=")[1]);
    else if (arg === "--suite") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--suite needs one of: ${Object.keys(MODES).join(", ")}`);
      options.suite = value;
      index += 1;
    } else if (arg.startsWith("--suite=")) options.suite = arg.slice("--suite=".length);
    else if (arg === "--evidence-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError("--evidence-dir needs an absolute path");
      options.evidenceDir = value;
      index += 1;
    } else if (arg.startsWith("--evidence-dir=")) options.evidenceDir = arg.slice("--evidence-dir=".length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!Object.hasOwn(MODES, options.suite)) {
    throw new UsageError(`unknown --suite: ${options.suite} (expected one of: ${Object.keys(MODES).join(", ")})`);
  }
  options.timeoutSeconds ??= MODES[options.suite].timeoutSeconds;
  if (options.timeoutSeconds < 30) throw new UsageError("--timeout-seconds must be at least 30");
  if (options.evidenceDir !== null) {
    if (options.evidenceDir.length === 0 || !path.isAbsolute(options.evidenceDir)) {
      throw new UsageError("--evidence-dir must be an absolute path");
    }
    const resolved = path.resolve(options.evidenceDir);
    if (within(ROOT, resolved)) throw new UsageError("--evidence-dir must be outside the repository worktree");
    options.evidenceDir = resolved;
  }
  return options;
}

function openEvidence(options) {
  const directory = options.evidenceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gui598-sandbox-evidence-"));
  if (options.evidenceDir !== null) {
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error?.code === "EEXIST") throw new SetupError(`--evidence-dir already exists (never reused): ${directory}`);
      throw new SetupError(`--evidence-dir could not be created (${String(error?.code ?? error)}): ${directory}`);
    }
  }
  const repository = fs.realpathSync(ROOT);
  if (within(repository, fs.realpathSync(directory))) {
    throw new SetupError(`evidence directory resolves inside the repository worktree: ${fs.realpathSync(directory)}`);
  }
  evidence.dir = directory;
  evidence.logPath = path.join(directory, `gui598-${RUN_ID}.log`);
  evidence.verdictPath = path.join(directory, `gui598-${RUN_ID}.json`);
  evidence.fd = fs.openSync(evidence.logPath, "wx", 0o600);
  log(`evidence directory ${evidence.dir} (retained after cleanup; only container bytes are removed)`);
}

function limitsEvidence(options) {
  const valueOf = (args, flag) => {
    const index = args.findIndex((arg, position) => position > 0 && args[position - 1] === flag);
    return index === -1 ? null : (args[index] ?? null);
  };
  const allOf = (args, flag) => args.filter((arg, position) => position > 0 && args[position - 1] === flag);
  const target = targetCreateArgs();
  return {
    wallClockSeconds: options.timeoutSeconds,
    network: "anchor --network none; services and target use --network container:<anchor>",
    target: {
      user: valueOf(target, "--user"),
      cpus: valueOf(target, "--cpus"),
      memory: valueOf(target, "--memory"),
      pids: valueOf(target, "--pids-limit"),
      ulimits: allOf(target, "--ulimit"),
      tmpfs: allOf(target, "--tmpfs"),
    },
    services: {
      postgres: { memory: valueOf(postgresArgs(), "--memory"), pids: valueOf(postgresArgs(), "--pids-limit") },
      garage: { memory: valueOf(garageArgs(), "--memory"), pids: valueOf(garageArgs(), "--pids-limit") },
    },
  };
}

function finishEvidence(options, summary) {
  if (evidence.finished || evidence.fd === null) return;
  evidence.finished = true;
  const verdict = {
    runId: RUN_ID,
    mode: activeMode.name,
    startedAt: summary.startedAt,
    finishedAt: new Date().toISOString(),
    wallSeconds: Number(((Date.now() - summary.startedMs) / 1000).toFixed(1)),
    exitCode: summary.exitCode,
    verdict: summary.verdict,
    control: summary.control,
    race: summary.race,
    ...(summary.suites === null || summary.suites === undefined ? {} : { suites: summary.suites }),
    isolation: summary.isolation,
    target: summary.target,
    containers: { created: summary.created, leftovers: summary.leftovers },
    limits: limitsEvidence(options),
    evidence: { log: path.basename(evidence.logPath), bytes: evidence.bytes, truncated: evidence.truncated },
  };
  try {
    fs.writeFileSync(evidence.verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    console.error(`[sandbox] WARN could not write ${evidence.verdictPath}: ${String(error?.code ?? error)}`);
  }
  fs.closeSync(evidence.fd);
  evidence.fd = null;
  console.log(`[sandbox] evidence retained: ${evidence.verdictPath}`);
}

function exec(args, { timeoutMs = 120_000, echo = false, maxCapture = MAX_CAPTURE } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const capture = (chunk, current) =>
      current.length >= maxCapture ? current : current + chunk.slice(0, maxCapture - current.length);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = capture(chunk, stdout);
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(chunk, stderr);
      if (echo) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error.message), timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal: signal ?? null, stdout, stderr, timedOut });
    });
  });
}

const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function resolveSpecifier(specifier) {
  try {
    return REQUIRE.resolve(specifier);
  } catch (error) {
    try {
      return fileURLToPath(import.meta.resolve(specifier));
    } catch {
      throw new Error(`${specifier} does not resolve: ${String(error?.message ?? error)}`);
    }
  }
}
const notApplicable = () => (activeMode.name === "integration" ? "not applicable: integration suite mode" : "not observed");
const tail = (text, lines = 12) => text.trim().split("\n").slice(-lines).join(" | ");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function walk(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      visit(full, entry);
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full);
    }
  }
}

function scanPayloadForEnvFiles(entry) {
  const hostPath = path.join(ROOT, entry.host);
  const found = [];
  if (entry.host === "node_modules" || entry.host === "package.json") return found;
  walk(hostPath, (full, dirent) => {
    if (dirent.name === ".git" || dirent.name.startsWith(".env")) found.push(path.relative(ROOT, full));
  });
  return found;
}

async function runPreflight(options) {
  const failures = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      failures.push(name);
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let serverArch = "";
  let serverOs = "";
  await record("docker server", async () => {
    const info = await exec([
      "info",
      "--format",
      "{{.Architecture}}|{{.OSType}}|{{.OperatingSystem}}|{{.DockerRootDir}}",
    ]);
    assert(info.code === 0, `docker info failed: ${tail(info.stderr)}`);
    const [arch, os, operatingSystem, dockerRoot] = info.stdout.trim().split("|");
    assert(arch && os, "docker info returned no architecture");
    serverArch = arch;
    serverOs = os;
    const version = await exec(["version", "--format", "{{.Server.Version}}"]);
    assert(version.code === 0, `docker version failed: ${tail(version.stderr)}`);
    const major = Number((version.stdout.trim().split(".")[0] ?? "0").replace(/\D/g, ""));
    assert(major >= 24, `docker server ${version.stdout.trim()} is older than 24`);
    return `server ${version.stdout.trim()} ${arch}/${os} (${operatingSystem}) root=${dockerRoot}`;
  });

  const archAlias = { aarch64: "arm64", x86_64: "amd64", arm64: "arm64", amd64: "amd64" };
  await record("local images and architecture", async () => {
    assert(serverArch.length > 0, "docker architecture unknown");
    const expectedArch = archAlias[serverArch] ?? serverArch;
    const parts = [];
    for (const image of Object.values(IMAGES)) {
      const inspected = await exec(["image", "inspect", "--format", "{{.Architecture}}|{{.Os}}|{{.Size}}", image]);
      assert(inspected.code === 0, `${image} is not present locally (no pull is attempted)`);
      const [arch, os, size] = inspected.stdout.trim().split("|");
      assert(arch === expectedArch, `${image} is ${arch}, host target is ${expectedArch}`);
      assert(os === serverOs, `${image} is ${os}, host target is ${serverOs}`);
      parts.push(`${image} ${arch}/${os} ${Math.round(Number(size) / 1e6)}MB`);
    }
    return parts.join(", ");
  });

  await record("node major version", async () => {
    const hostMajor = process.versions.node.split(".")[0];
    const env = await exec(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGES.node]);
    assert(env.code === 0, "cannot read the node image environment");
    const nodeVersion = (JSON.parse(env.stdout.trim()) ?? [])
      .map((line) => /^NODE_VERSION=(.+)$/.exec(line)?.[1])
      .find((value) => value !== undefined);
    assert(nodeVersion, "node image declares no NODE_VERSION");
    assert(nodeVersion.split(".")[0] === hostMajor, `image node ${nodeVersion} vs host ${process.versions.node}`);
    return `host ${process.versions.node} / image ${nodeVersion}`;
  });

  await record("payload allowlist", async () => {
    const targets = new Set();
    for (const entry of [...payload, ...TOOLING]) {
      const hostPath = path.join(ROOT, entry.host);
      assert(fs.existsSync(hostPath), `missing ${entry.host}`);
      const real = fs.realpathSync(hostPath);
      assert(within(ROOT, real), `${entry.host} resolves outside the repository: ${real}`);
      assert(path.basename(entry.host) !== ".git" && !path.basename(entry.host).startsWith(".env"), entry.host);
      assert(real !== ROOT, `${entry.host} would mount the whole repository`);
      assert(!targets.has(entry.mount), `two payload entries mount ${entry.mount}`);
      targets.add(entry.mount);
    }
    return `${payload.length} payload mounts + ${TOOLING.length} tooling mounts, no whole-repo mount`;
  });

  await record("suite selection", async () => {
    if (activeMode.name !== "integration") {
      return `reproducer mode: ${activeMode.extraPayload.map((entry) => entry.host).join(", ")}`;
    }
    for (const host of INTEGRATION_SUITES) {
      assert(/^test\/[A-Za-z0-9._-]+\.(test|integration)\.ts$/.test(host), `${host} is not a test file under test/`);
      const hostPath = path.join(ROOT, host);
      assert(fs.existsSync(hostPath) && fs.statSync(hostPath).isFile(), `missing suite file ${host}`);
      assert(
        payload.some((entry) => entry.host === host && entry.mount === `/work/${host}`),
        `${host} is selected but not mounted`,
      );
    }
    assert(new Set(INTEGRATION_SUITES).size === INTEGRATION_SUITES.length, "the suite selection repeats a file");
    return `${INTEGRATION_SUITES.length} suites, one mount each, ${INTEGRATION_EXTRA_FILES.length} extra fixture files`;
  });

  await record("target environment covers test/integration-config.example", async () => {
    const examplePath = path.join(ROOT, "test/integration-config.example");
    assert(fs.existsSync(examplePath), "test/integration-config.example is missing");
    const names = fs
      .readFileSync(examplePath, "utf8")
      .split("\n")
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((name) => name !== undefined);
    assert(names.length > 0, "test/integration-config.example declares no variable");
    const missing = names.filter((name) => (targetEnv[name] ?? "") === "");
    assert(missing.length === 0, `the target environment is missing ${missing.join(", ")}`);
    const leaked = Object.entries(targetEnv).filter(([, value]) => /\/Users\/|\/home\/[A-Za-z]|sock/.test(String(value)));
    assert(leaked.length === 0, `host path or socket in env: ${leaked.map(([name]) => name).join(", ")}`);
    const extras = Object.keys(targetEnv).filter((name) => !names.includes(name));
    return `${names.length} fixture variables present with fictitious values; sandbox-only extras: ${extras.join(", ")}`;
  });

  await record("no env file or git metadata in the payload", async () => {
    const found = payload.flatMap(scanPayloadForEnvFiles);
    assert(found.length === 0, `refusing to mount: ${found.join(", ")}`);
    return "no .env* and no .git under the mounted payload";
  });

  await record("node_modules symlinks stay inside the repository", async () => {
    const links = [];
    walk(path.join(ROOT, "node_modules"), (full, dirent) => {
      if (dirent.isSymbolicLink()) links.push(full);
    });
    let dangling = 0;
    let unmounted = 0;
    for (const link of links) {
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      const relative = path.relative(ROOT, target);
      assert(!relative.startsWith("..") && !path.isAbsolute(relative), `${path.relative(ROOT, link)} escapes: ${target}`);
      if (!fs.existsSync(target)) {
        dangling += 1;
        continue;
      }
      const real = fs.realpathSync(target);
      assert(within(ROOT, real), `${path.relative(ROOT, link)} escapes to ${real}`);
      if (!payload.some((entry) => within(path.join(ROOT, entry.host), real))) unmounted += 1;
    }
    return `${links.length} links inside the repo, ${dangling} dangling, ${unmounted} unmounted workspace link(s)`;
  });

  await record("required modules resolve inside the mounted payload", async () => {
    const resolved = [];
    for (const specifier of REQUIRED_SPECIFIERS) {
      const entry = resolveSpecifier(specifier);
      const real = fs.realpathSync(entry);
      const mount = payload.find((candidate) => within(path.join(ROOT, candidate.host), real));
      assert(mount, `${specifier} resolves outside the mounted payload: ${real}`);
      resolved.push(`${specifier} -> ${mount.mount}${real.slice(path.join(ROOT, mount.host).length)}`);
    }
    return `${resolved.length} specifiers, all under /work`;
  });

  await record("runtime packages carry no host binaries", async () => {
    const packages = new Set(
      REQUIRED_SPECIFIERS.map((specifier) =>
        specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0],
      ),
    );
    const offenders = [];
    for (const name of packages) {
      walk(path.join(ROOT, "node_modules", name), (full) => {
        if (full.endsWith(".node")) offenders.push(path.relative(ROOT, full));
      });
    }
    assert(offenders.length === 0, `native binaries in the runtime package set: ${offenders.join(", ")}`);
    let total = 0;
    walk(path.join(ROOT, "node_modules"), (full) => {
      if (full.endsWith(".node")) total += 1;
    });
    return `runtime set pure JS, whole tree has ${total} darwin-only build binary/binaries (not imported here)`;
  });

  await record("disk headroom", async () => {
    const stats = fs.statfsSync(ROOT);
    const freeGb = (stats.bavail * stats.bsize) / 1e9;
    assert(freeGb >= options.minFreeGb, `free host disk ${freeGb.toFixed(1)}GiB < ${options.minFreeGb}GiB`);
    const df = await exec(["system", "df"]);
    const usage = df.code === 0 ? tail(df.stdout, 4) : "system df unavailable";
    return `${freeGb.toFixed(1)}GiB free host disk; bounded writable footprint ~1GiB; ${usage}`;
  });

  if (failures.length > 0) log(`${failures.length} preflight check(s) failed: ${failures.join(", ")}`);
  return failures.length === 0;
}

function printPlan(options) {
  log(`mode ${activeMode.name}; run id ${RUN_ID}; container names use the prefix ${PREFIX}-*`);
  for (const [role, args] of [
    ["anchor", anchorArgs()],
    ["postgres", postgresArgs()],
    ["garage", garageArgs()],
    ["target", ["create", ...targetCreateArgs().slice(1)]],
  ]) {
    log(`${role}: docker ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
  }
  log(`wall clock limit ${options.timeoutSeconds}s; writable state is tmpfs only; no volume, no network, no pull`);
}

const labels = ["--label", "gui598.sandbox=1", "--label", `gui598.run=${RUN_ID}`];
const nameOf = (role) => `${PREFIX}-${role}`;

function anchorArgs() {
  return [
    "run",
    "-d",
    "--name",
    nameOf("anchor"),
    ...labels,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "32",
    "--memory",
    "64m",
    "--memory-swap",
    "64m",
    "--cpus",
    "0.1",
    "--entrypoint",
    "sleep",
    IMAGES.node,
    "infinity",
  ];
}

function postgresArgs() {
  const args = [
    "run",
    "-d",
    "--name",
    nameOf("postgres"),
    ...labels,
    "--network",
    `container:${nameOf("anchor")}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETUID",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "0.5",
    "--shm-size",
    "128m",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m,mode=0700",
    "--tmpfs",
    "/var/run/postgresql:rw,nosuid,nodev,size=16m,mode=0755",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
  ];
  for (const [key, value] of Object.entries(POSTGRES_ENV)) args.push("--env", `${key}=${value}`);
  args.push(IMAGES.postgres);
  return args;
}

function garageArgs() {
  const args = [
    "run",
    "-d",
    "--name",
    nameOf("garage"),
    ...labels,
    "--network",
    `container:${nameOf("anchor")}`,
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "128",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--cpus",
    "0.5",
    "--tmpfs",
    "/var/lib/garage:rw,nosuid,nodev,size=192m,mode=1777",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
  ];
  for (const [key, value] of Object.entries(GARAGE_ENV)) args.push("--env", `${key}=${value}`);
  args.push("--mount", `type=bind,source=${path.join(ROOT, "docker/security-sandbox/garage.toml")},target=/etc/garage.toml,readonly`);
  args.push(IMAGES.garage, "/garage", "server", "--single-node", "--default-bucket");
  return args;
}

function targetCreateArgs() {
  const args = [
    "create",
    "--name",
    nameOf("target"),
    ...labels,
    "--network",
    `container:${nameOf("anchor")}`,
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "1",
    "--ulimit",
    "fsize=67108864:67108864",
    "--ulimit",
    "nofile=1024:1024",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "--tmpfs",
    "/scratch:rw,noexec,nosuid,nodev,size=256m,mode=1777",
  ];
  for (const [key, value] of Object.entries(targetEnv)) args.push("--env", `${key}=${value}`);
  for (const entry of [...payload, ...TOOLING]) {
    args.push("--mount", `type=bind,source=${path.join(ROOT, entry.host)},target=${entry.mount},readonly`);
  }
  args.push("--entrypoint", "node", IMAGES.node, "/sandbox/bootstrap.mjs");
  return args;
}

async function startDetached(role, args) {
  const result = await exec(args);
  const id = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  created.push({ role, name: nameOf(role), id });
  if (result.code !== 0) throw new SetupError(`${role} did not start: ${tail(result.stderr)}`);
  assert(/^[0-9a-f]{12,64}$/.test(id), `${role} returned no container id`);
  state[role] = id;
  log(`started ${role} id=${id.slice(0, 12)} (run-owned, pending cleanup)`);
  return id;
}

async function waitUntil(role, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new SetupError(`${role} was not ready within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(500);
  }
}

const execOk = async (id, command) => (await exec(["exec", id, ...command], { timeoutMs: 15_000 })).code === 0;

async function startFixtures() {
  await startDetached("anchor", anchorArgs());
  const postgresId = await startDetached("postgres", postgresArgs());
  const garageId = await startDetached("garage", garageArgs());
  await waitUntil("postgres", () => execOk(postgresId, ["pg_isready", "-U", "artiflow_sandbox", "-d", "artiflow"]), 120_000);
  log("postgres ready on the isolated loopback");
  await waitUntil("garage", () => execOk(garageId, ["/garage", "health", "--quiet"]), 120_000);
  log("garage ready on the isolated loopback");
}

const TAP_DIRECTIVE = /(^|[^\\]) # (SKIP|TODO)\b/i;

function parseTap(output) {
  const results = [];
  for (const line of output.split("\n")) {
    const match = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    const directive = TAP_DIRECTIVE.exec(raw);
    const name = raw
      .slice(0, directive === null ? raw.length : directive.index + directive[1].length)
      .replace(/ \(\d+(?:\.\d+)?ms\)$/, "");
    results.push({ ok: match[1] === "ok", name, directive: directive === null ? null : directive[2].toUpperCase() });
  }
  return results;
}

function classifyReproducer(attach, exitCode) {
  if (exitCode === 10 || exitCode === 11) {
    return {
      code: EXIT.setup,
      detail: "bootstrap isolation/environment check failed; zero target tests executed",
      results: [],
    };
  }
  const results = parseTap(attach.stdout);
  const skipped = results.filter((result) => result.directive === "SKIP");
  if (skipped.length > 0) {
    const names = skipped.map((result) => result.name).join("; ");
    return {
      code: EXIT.incomplete,
      detail: `${skipped.length} reproducer test(s) skipped (${names}); a skip is never a pass, so this run proves nothing about the invariant`,
      results,
    };
  }
  const control = results.find((result) => result.name.includes(MARKERS.control));
  const race = results.find((result) => result.name.includes(MARKERS.race));
  const marked = attach.stdout.includes(MARKERS.regressed);
  if (!control || !race) {
    return { code: EXIT.unexpected, detail: "the TAP output does not contain both expected tests", results };
  }
  if (!control.ok) {
    return { code: EXIT.unexpected, detail: "sequential control test failed: harness or product regression", results };
  }
  if (race.ok) {
    return {
      code: EXIT.passed,
      detail:
        "invariant held: A's paused DELETE removed only A's own key, so B still serves its identical bytes",
      results,
    };
  }
  if (marked) {
    return {
      code: EXIT.unexpected,
      detail: `the fix regressed: the race test failed with ${MARKERS.regressed}; this build must not be accepted`,
      results,
    };
  }
  return {
    code: EXIT.unexpected,
    detail: `race test failed without ${MARKERS.regressed}; cannot separate a product regression from a harness fault`,
    results,
  };
}

function parseSuiteResults(output) {
  const suites = [];
  for (const line of output.split("\n")) {
    const result = /^\[bootstrap\] suite result (\S+) verdict=(\S+) tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)/.exec(line);
    if (result === null) continue;
    suites.push({
      file: result[1],
      verdict: result[2],
      tests: Number(result[3]),
      pass: Number(result[4]),
      fail: Number(result[5]),
      skipped: Number(result[6]),
    });
  }
  return suites;
}

function parseSuiteSummary(output) {
  const match = /^\[bootstrap\] suite summary suites=(\d+) passed=(\d+) skipped=(\d+) failed=(\d+) notests=(\d+)$/m.exec(output);
  if (match === null) return null;
  return {
    suites: Number(match[1]),
    passed: Number(match[2]),
    skipped: Number(match[3]),
    failed: Number(match[4]),
    notests: Number(match[5]),
  };
}

function suiteSkipReasons(output) {
  const reasons = [];
  for (const line of output.split("\n")) {
    const match = /^\[bootstrap\] skip-reason (\S+) (.+)$/.exec(line);
    if (match !== null && reasons.length < 3) reasons.push(`${match[1]} (${match[2].slice(0, 160)})`);
  }
  return reasons;
}

function classifyIntegration(output, exitCode) {
  const suites = parseSuiteResults(output);
  if (exitCode === 10 || exitCode === 11) {
    return {
      code: EXIT.setup,
      detail: "bootstrap isolation/environment check failed; zero target tests executed",
      results: [],
      suites,
    };
  }
  const summary = parseSuiteSummary(output);
  if (summary === null) {
    return {
      code: EXIT.unexpected,
      detail: `the target reported no suite summary (target exit ${exitCode}); this run cannot be classified`,
      results: [],
      suites,
    };
  }
  if (summary.suites === 0) {
    return { code: EXIT.setup, detail: "no integration suite was selected or executed: zero target tests", results: [], suites };
  }
  if (summary.failed > 0 || summary.notests > 0) {
    const broken = suites
      .filter((suite) => suite.verdict === "failed" || suite.verdict === "no-tests")
      .map((suite) => suite.file);
    return {
      code: EXIT.unexpected,
      detail:
        `${summary.failed} of ${summary.suites} suites failed` +
        `${summary.notests > 0 ? ` and ${summary.notests} produced no tests` : ""}: ${broken.join(", ")}`,
      results: [],
      suites,
    };
  }
  if (summary.skipped > 0) {
    const reasons = suiteSkipReasons(output);
    return {
      code: EXIT.incomplete,
      detail:
        `${summary.skipped} of ${summary.suites} suites skipped (${reasons.length > 0 ? reasons.join("; ") : "reason not reported"}); ` +
        "a skip is never a pass, so this run proves nothing about the skipped suites",
      results: [],
      suites,
    };
  }
  if (summary.passed !== summary.suites || exitCode !== 0) {
    return {
      code: EXIT.unexpected,
      detail: `suite summary is inconsistent with target exit ${exitCode}: ${summary.passed} of ${summary.suites} suites passed`,
      results: [],
      suites,
    };
  }
  return {
    code: EXIT.passed,
    detail: `all ${summary.suites} selected suites passed against the live PostgreSQL and S3 fixtures, with no skip`,
    results: [],
    suites,
  };
}

const classify = (attach, exitCode) => {
  const output = `${attach.stdout}${attach.stderr}`;
  return activeMode.name === "integration" ? classifyIntegration(output, exitCode) : classifyReproducer(attach, exitCode);
};

function isolationEvidence(output, exitCode) {
  if (output.includes("[bootstrap] ok only loopback exists in this namespace")) {
    return "loopback only: no device, route or address outside loopback";
  }
  const failed = /\[bootstrap\] FAIL only loopback exists in this namespace: (.+)/.exec(output);
  if (failed) return `rejected: ${failed[1].trim().slice(0, 240)}`;
  if (exitCode === 10) return "rejected: a bootstrap isolation check failed (namespace detail not captured)";
  return "not observed: the target did not report the namespace check";
}

const testOutcome = (results, marker) => {
  const found = results.find((result) => result.name.includes(marker));
  if (found === undefined) return "not observed";
  if (found.directive === "SKIP") return "skipped";
  return found.ok ? "passed" : "failed";
};

async function runTargetTest(options) {
  const create = await exec(targetCreateArgs());
  const id = create.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  created.push({ role: "target", name: nameOf("target"), id });
  if (create.code !== 0) throw new SetupError(`target container could not be created: ${tail(create.stderr)}`);
  assert(/^[0-9a-f]{12,64}$/.test(id), "target returned no container id");
  state.target = id;
  log(`target id=${id.slice(0, 12)} created; starting bounded execution`);

  const attach = await exec(["start", "--attach", id], {
    timeoutMs: options.timeoutSeconds * 1000,
    echo: true,
    maxCapture: activeMode.name === "integration" ? TARGET_CAPTURE_SUITE : MAX_CAPTURE,
  });
  evidenceAppend(`\n===== target output (docker start --attach) =====\n${attach.stdout}${attach.stderr}\n`);
  if (attach.timedOut) {
    await exec(["kill", id], { timeoutMs: 30_000 });
    const target = { exitCode: null, oomKilled: null, timedOut: true };
    state.isolation = isolationEvidence(`${attach.stdout}${attach.stderr}`, null);
    state.targetSummary = target;
    return {
      code: EXIT.timedOut,
      detail: `wall clock limit (${options.timeoutSeconds}s) reached; target killed and its containers are removed`,
      results: [],
      suites: parseSuiteResults(`${attach.stdout}${attach.stderr}`),
      isolation: state.isolation,
      target,
    };
  }
  const inspected = await exec(["inspect", "--format", "{{json .State}}", id]);
  assert(inspected.code === 0, `cannot read target state: ${tail(inspected.stderr)}`);
  const targetState = JSON.parse(inspected.stdout.trim());
  assert(
    targetState.Status === "exited",
    `target did not reach a normal exit (status ${String(targetState.Status)}): ${tail(attach.stderr)}`,
  );
  log(
    `target exit code ${targetState.ExitCode}; oom-killed=${String(targetState.OOMKilled)}; ` +
      `pids-limit and 1GiB memory were enforced by the daemon`,
  );
  const target = { exitCode: targetState.ExitCode, oomKilled: targetState.OOMKilled === true, timedOut: false };
  state.isolation = isolationEvidence(`${attach.stdout}${attach.stderr}`, targetState.ExitCode);
  state.targetSummary = target;
  return { ...classify(attach, targetState.ExitCode), isolation: state.isolation, target };
}

async function cleanupAll() {
  const leftovers = [];
  for (const entry of [...created].reverse()) {
    const target = entry.id.length > 0 ? entry.id : entry.name;
    const removed = await exec(["rm", "-f", target], { timeoutMs: 60_000 });
    const stillThere = await exec(["inspect", "--format", "{{.Id}}", target], { timeoutMs: 30_000 });
    if (stillThere.code === 0) {
      leftovers.push(`${entry.role} ${target}`);
      log(`WARN ${entry.role} still present after rm -f (${tail(removed.stderr)})`);
    } else {
      log(`removed ${entry.role} ${target.slice(0, 12)} (exact run-owned id)`);
    }
  }
  created.length = 0;
  return { ok: leftovers.length === 0, leftovers };
}

function cleanupOnce() {
  cleanupPromise ??= cleanupAll().catch((error) => {
    log(`cleanup error: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, leftovers: created.map((entry) => `${entry.role} ${entry.name}`) };
  });
  return cleanupPromise;
}

async function logServiceTail(role, id) {
  if (!id) return;
  const logs = await exec(["logs", "--tail", "30", id], { timeoutMs: 30_000 });
  const tailLine = tail(`${logs.stdout}\n${logs.stderr}`, 8);
  if (tailLine.length > 0) log(`${role} last lines: ${tailLine}`);
}

async function runSandbox(options) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  openEvidence(options);
  log(`mode ${activeMode.name}: ${activeMode.extraPayload.length} target files, wall clock ${options.timeoutSeconds}s`);
  const ready = await runPreflight(options);
  if (!ready) {
    log("preflight failed: no container started and zero target tests executed (attempt preserved, no retry)");
    finishEvidence(options, {
      startedAt,
      startedMs,
      exitCode: EXIT.setup,
      verdict: "preflight failed; zero target tests executed",
      control: notApplicable(),
      race: notApplicable(),
      isolation: "not observed",
      target: null,
      created: [],
      leftovers: [],
    });
    return EXIT.setup;
  }

  const wallClock = new Promise((_, reject) => {
    state.wallTimer = setTimeout(
      () => reject(new TimeoutError(`wall clock limit ${options.timeoutSeconds}s reached`)),
      options.timeoutSeconds * 1000,
    );
  });
  const forSignals = (signal) => {
    log(`${signal} received: removing run-owned containers`);
    const createdRoles = created.map((entry) => entry.role);
    void cleanupOnce()
      .then((cleanup) => {
        finishEvidence(options, {
          startedAt,
          startedMs,
          exitCode: 130,
          verdict: `interrupted by ${signal}; the run-owned containers were removed`,
          control: notApplicable(),
          race: notApplicable(),
          isolation: state.isolation ?? "not observed",
          target: state.targetSummary,
          created: createdRoles,
          leftovers: cleanup.leftovers,
        });
      })
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", forSignals);
  process.on("SIGTERM", forSignals);
  process.on("SIGHUP", forSignals);

  let exitCode = EXIT.setup;
  let outcome = null;
  let failure = null;
  const body = (async () => {
    await startFixtures();
    return runTargetTest(options);
  })();
  body.catch(() => {});

  try {
    outcome = await Promise.race([body, wallClock]);
    exitCode = outcome.code;
    log(`verdict: ${outcome.detail}`);
    if (outcome.results.length > 0) {
      for (const result of outcome.results) {
        const label = result.directive === "SKIP" ? "SKIP" : result.ok ? "PASS" : "FAIL";
        log(`test ${label} (must pass): ${result.name}`);
      }
    }
    if (exitCode === EXIT.passed) {
      log(
        activeMode.name === "integration"
          ? "every selected suite passed against the live fixtures; no skip was reported"
          : "both tests passed: the pause left B's bytes untouched, so the fix holds on this build",
      );
    }
    if (outcome.suites !== undefined && outcome.suites.length > 0) {
      for (const suite of outcome.suites) {
        log(
          `suite ${suite.verdict.toUpperCase()}: ${suite.file} (tests=${suite.tests} pass=${suite.pass} fail=${suite.fail} skipped=${suite.skipped})`,
        );
      }
    }
  } catch (error) {
    exitCode = error instanceof TimeoutError ? EXIT.timedOut : EXIT.setup;
    failure = error instanceof Error ? error.message : String(error);
    log(`setup failure: ${failure}`);
    log("no automatic retry of this attempt; the failed setup and any captured evidence are preserved");
    for (const role of ["postgres", "garage", "anchor"]) await logServiceTail(role, state[role]);
    await logServiceTail("target", state.target);
  } finally {
    if (state.wallTimer) clearTimeout(state.wallTimer);
    const createdRoles = created.map((entry) => entry.role);
    const cleanup = await cleanupOnce();
    if (!cleanup.ok) {
      log(`cleanup incomplete; run-owned containers may remain: ${cleanup.leftovers.join(", ")}`);
      log(`recover with: docker ps -a --filter "name=${PREFIX}-" then docker rm -f <exact-id>`);
      if (exitCode === EXIT.passed || exitCode === EXIT.incomplete) exitCode = EXIT.cleanup;
    }
    finishEvidence(options, {
      startedAt,
      startedMs,
      exitCode,
      verdict: outcome === null ? (failure ?? "no verdict") : outcome.detail,
      control: outcome === null ? notApplicable() : testOutcome(outcome.results, MARKERS.control),
      race: outcome === null ? notApplicable() : testOutcome(outcome.results, MARKERS.race),
      suites: outcome === null ? null : (outcome.suites ?? null),
      isolation: outcome === null ? (state.isolation ?? "not observed") : outcome.isolation,
      target: outcome === null ? state.targetSummary : outcome.target,
      created: createdRoles,
      leftovers: cleanup.leftovers,
    });
  }
  return exitCode;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[sandbox] ${error instanceof Error ? error.message : String(error)}`);
    console.error(HELP);
    process.exit(EXIT.usage);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  selectMode(options.suite);
  if (options.preflight || options.dryRun) {
    const ready = await runPreflight(options);
    if (options.dryRun) printPlan(options);
    if (!ready) log("preflight failed; nothing was created and no pull was attempted");
    process.exit(ready ? 0 : EXIT.setup);
  }
  process.exit(await runSandbox(options));
}

main().catch((error) => {
  console.error(`[sandbox] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT.setup);
});
