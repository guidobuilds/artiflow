#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_RUNTIME_ENV, findExecutable, resolveDevApi } from "./dev-runtime.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = fs.realpathSync(ROOT);
const ENV_FILE = path.join(ROOT, ".env.local");
const UI_PORT = 5173;
const API_PORT = 8787;

function log(message) {
  console.log(`[dev] ${message}`);
}

function fail(message) {
  console.error(`[dev] error: ${message}`);
  process.exit(1);
}

if (fs.realpathSync(process.cwd()) !== WORKSPACE) {
  fail(`run this script from ${WORKSPACE}`);
}

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    env[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

if (!fs.existsSync(ENV_FILE)) {
  fail("missing .env.local; run bun run setup:local first.");
}
const fileEnv = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function requireFreePort(port, label) {
  if (!(await portIsFree(port))) {
    fail(`${label} port 127.0.0.1:${port} is already in use; refusing to start.`);
  }
}

await requireFreePort(UI_PORT, "UI");
await requireFreePort(API_PORT, "API");

const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(viteBin)) {
  fail("vite is not installed; run bun install first.");
}

let apiRuntime;
try {
  apiRuntime = resolveDevApi();
} catch (error) {
  fail(error instanceof Error ? error.message : `${DEV_RUNTIME_ENV} could not be resolved`);
}

const webBinary = process.versions.bun ? findExecutable("node") : process.execPath;
if (!webBinary) fail("the web dev server (vite) needs node on PATH.");

const childEnv = { ...process.env, ...fileEnv };
const children = [];
let shuttingDown = false;
let requestedExitCode = 0;

function start(label, binary, args) {
  const child = spawn(binary, args, {
    cwd: ROOT,
    env: childEnv,
    stdio: "inherit",
  });
  child.label = label;
  children.push(child);
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`${label} exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).`);
    requestedExitCode = code ?? 1;
    void shutdown(`${label} exit`);
  });
  return child;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`timed out waiting for ${url}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason}: shutting down owned processes only.`);
  await Promise.all(children.map((child) => stopChild(child)));
  process.exitCode = requestedExitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    requestedExitCode = 0;
    void shutdown(`${signal} received`);
  });
}

log(`api runtime: ${apiRuntime.runtime} (${apiRuntime.binary}); override with ${DEV_RUNTIME_ENV}=bun|node.`);

const api = start("api", apiRuntime.binary, ["--watch", "apps/api/src/server.ts"]);
const web = start("web", webBinary, [
  viteBin,
  "--config",
  "apps/dashboard/vite.config.ts",
  "--host",
  "127.0.0.1",
  "--port",
  String(UI_PORT),
  "--strictPort",
]);

try {
  const apiStatus = await waitForHttp(`http://127.0.0.1:${API_PORT}/api/health`, 30_000);
  log(`API responding on http://127.0.0.1:${API_PORT}/api/health (HTTP ${apiStatus}).`);
  const uiStatus = await waitForHttp(`http://127.0.0.1:${UI_PORT}/`, 30_000);
  log(`UI responding on http://127.0.0.1:${UI_PORT}/ (HTTP ${uiStatus}).`);
} catch (error) {
  requestedExitCode = 1;
  console.error(`[dev] error: ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown("startup failure");
  process.exit(1);
}

log(`library: http://127.0.0.1:${UI_PORT}/`);
log("Ctrl+C stops only the API and UI processes started here.");
log("PostgreSQL and object storage are external; this script never manages them.");

void api;
void web;
