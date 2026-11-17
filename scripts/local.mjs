#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = fs.realpathSync(ROOT);
const ENV_FILE = path.join(ROOT, ".env.local");
const EXAMPLE_FILE = path.join(ROOT, ".env.example");
const AUTH_KEY = "ARTIFLOW_AUTH_SECRET";
const MIN_SECRET_LENGTH = 32;

function log(message) {
  console.log(`[local] ${message}`);
}

function fail(message) {
  console.error(`[local] error: ${message}`);
  process.exit(1);
}

function assertWorkspace() {
  const cwd = fs.realpathSync(process.cwd());
  if (cwd !== WORKSPACE) {
    fail(`run this script from ${WORKSPACE} (current directory: ${cwd})`);
  }
}

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function assertOwnedEnvFile() {
  const stat = fs.lstatSync(ENV_FILE);
  const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
  if (!stat.isFile() || !owned) {
    fail(".env.local is not an owned regular file; refusing to read or modify it.");
  }
}

function ensureSecret(text) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${AUTH_KEY}=`));
  const secret = crypto.randomBytes(32).toString("base64url");

  if (index === -1) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return { text: `${text}${separator}${AUTH_KEY}=${secret}\n`, generated: true };
  }

  const line = lines[index];
  const value = line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (value.length >= MIN_SECRET_LENGTH) {
    return { text, generated: false };
  }
  if (value.length > 0) {
    fail(
      `${AUTH_KEY} exists but is shorter than ${MIN_SECRET_LENGTH} characters; refusing to overwrite it. Replace it yourself, then rerun.`,
    );
  }
  lines[index] = `${AUTH_KEY}=${secret}`;
  return { text: lines.join("\n"), generated: true };
}

function setup() {
  assertWorkspace();

  if (fs.existsSync(ENV_FILE)) {
    assertOwnedEnvFile();
    fs.chmodSync(ENV_FILE, 0o600);
    const current = fs.readFileSync(ENV_FILE, "utf8");
    const { text, generated } = ensureSecret(current);
    if (text !== current) {
      fs.writeFileSync(ENV_FILE, text, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(ENV_FILE, 0o600);
    }
    log(".env.local exists; preserved (mode 0600).");
    if (generated) log(`${AUTH_KEY} added to .env.local; value not printed.`);
    log("Edit DATABASE_URL and ARTIFLOW_S3_* to point at your external services.");
    log("Next: bun run check:local");
    return;
  }

  if (!fs.existsSync(EXAMPLE_FILE)) {
    fail("missing .env.example; cannot create .env.local.");
  }
  const { text } = ensureSecret(fs.readFileSync(EXAMPLE_FILE, "utf8"));
  fs.writeFileSync(ENV_FILE, text, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  log("wrote .env.local from .env.example (mode 0600); values not printed.");
  log("Edit DATABASE_URL and ARTIFLOW_S3_* to point at your external services.");
  log("Next: bun run check:local");
}

function looksLikePlaceholder(env) {
  const database = env.DATABASE_URL ?? "";
  const endpoint = env.ARTIFLOW_S3_ENDPOINT ?? "";
  const accessKey = env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "";
  const bucket = env.ARTIFLOW_S3_BUCKET ?? "";
  return (
    database.includes("USER:PASSWORD@HOST") ||
    database.includes("/DBNAME") ||
    /S3_ENDPOINT|ACCOUNT_ID|example\.com/.test(endpoint) ||
    /REPLACE_WITH|YOUR_|your-/.test(accessKey) ||
    /REPLACE_WITH|YOUR_|your-/.test(bucket)
  );
}

async function check() {
  assertWorkspace();
  if (!fs.existsSync(ENV_FILE)) {
    fail("missing .env.local; run bun run setup:local first.");
  }
  assertOwnedEnvFile();
  const env = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));

  if (looksLikePlaceholder(env)) {
    fail(
      "DATABASE_URL / ARTIFLOW_S3_* still contain template placeholders. " +
        "Edit .env.local with the connection details of your external services.",
    );
  }

  const { loadConfig, ConfigError } = await import("../apps/api/src/config.ts");
  const { createDatabase } = await import("../apps/api/src/db/client.ts");
  const { createStorage } = await import("../apps/api/src/storage/client.ts");

  let config;
  try {
    config = loadConfig({ ...process.env, ...env });
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : "invalid configuration";
    fail(reason);
  }

  const database = createDatabase(config.databaseUrl);
  const storage = createStorage(config.storage);
  let failed = false;

  try {
    await database.check();
    log("database: ok");
  } catch {
    failed = true;
    log("database: error (check DATABASE_URL, host, port, credentials and TLS)");
  }

  try {
    await storage.checkBucket();
    log("storage: ok");
  } catch {
    failed = true;
    log("storage: error (check ARTIFLOW_S3_ENDPOINT, bucket, region, credentials and forcePathStyle)");
  } finally {
    storage.destroy();
    await database.close();
  }

  if (failed) {
    fail("one or more external services are not reachable.");
  }
  log("external services are reachable.");
}

const command = process.argv[2];
if (command === "setup") {
  setup();
} else if (command === "check") {
  await check();
} else {
  fail("usage: node scripts/local.mjs <setup|check>");
}
