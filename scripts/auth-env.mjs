#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = fs.realpathSync(ROOT);
const ENV_FILE = path.join(ROOT, ".env.local");
const KEY = "ARTIFLOW_AUTH_SECRET";
const MIN_LENGTH = 32;

function log(message) {
  console.log(`[auth-env] ${message}`);
}

function fail(message) {
  console.error(`[auth-env] error: ${message}`);
  process.exit(1);
}

if (fs.realpathSync(process.cwd()) !== WORKSPACE) {
  fail(`run this script from ${WORKSPACE}`);
}

let stat;
try {
  stat = fs.lstatSync(ENV_FILE);
} catch {
  fail("missing .env.local; run bun run setup:local first. This script never creates or replaces the file.");
}
if (stat.isSymbolicLink()) {
  fail(".env.local is a symlink; refusing to follow or modify it.");
}
if (!stat.isFile()) {
  fail(".env.local is not a regular file; refusing to modify it.");
}
if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
  fail(".env.local is not owned by the current user; refusing to modify it.");
}
fs.chmodSync(ENV_FILE, 0o600);

const text = fs.readFileSync(ENV_FILE, "utf8");
const existing = text.split(/\r?\n/).find((line) => line.trimStart().startsWith(`${KEY}=`));

if (existing !== undefined) {
  const value = existing
    .slice(existing.indexOf("=") + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (value.length < MIN_LENGTH) {
    fail(
      `${KEY} exists but is shorter than ${MIN_LENGTH} characters; refusing to overwrite it. Replace the value yourself, then rerun.`,
    );
  }
  log(`${KEY} already present with a valid length; unchanged, file preserved.`);
  process.exit(0);
}

const secret = crypto.randomBytes(32).toString("base64url");
const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
fs.appendFileSync(ENV_FILE, `${separator}${KEY}=${secret}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
fs.chmodSync(ENV_FILE, 0o600);
log(`${KEY} appended to .env.local; mode 0600, value not printed, other keys preserved.`);
