import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export class WorktreeError extends Error {}

export function log(source, message) {
  console.log(`[orca:${source}] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new WorktreeError(`${command} could not run: ${result.error.message}`);
  }
  return result;
}

function firstLine(value) {
  const line = (value ?? "").trim().split(/\r?\n/).find(Boolean);
  return line ?? "unknown error";
}

function asUrl(value) {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    throw new WorktreeError("DATABASE_URL is not a valid URL");
  }
}

export function parseDatabaseUrl(value) {
  const url = asUrl(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new WorktreeError("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!databaseNameFromUrl(url)) {
    throw new WorktreeError("DATABASE_URL has no database name");
  }
  return url;
}

export function databaseNameFromUrl(value) {
  const url = asUrl(value);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name || name.includes("/")) return "";
  return name;
}

export function hostIdentity(value) {
  const url = asUrl(value);
  const host = (url.hostname || url.searchParams.get("host") || "").replace(/^\[(.*)\]$/, "$1");
  const port = url.port && url.port !== "5432" ? `:${url.port}` : "";
  return `${host.toLowerCase()}${port}`;
}

export function withDatabaseName(value, name) {
  const url = new URL(asUrl(value).toString());
  url.pathname = `/${name}`;
  return url.toString();
}

export function readOwnedFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new WorktreeError(`${file} does not exist`);
  }
  if (!stat.isFile()) {
    throw new WorktreeError(`${file} is not a regular file`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new WorktreeError(`${file} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(file, 0o600);
  }
  return fs.readFileSync(file, "utf8");
}

export function parseEnvironment(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

export function databaseUrlFromEnvironment(text, file) {
  const value = parseEnvironment(text).get("DATABASE_URL");
  if (!value) {
    throw new WorktreeError(`${file} has no DATABASE_URL`);
  }
  return parseDatabaseUrl(value).toString();
}

export function setEnvironmentValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = `${key}=${value}`;
      replaced = true;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines.at(-1) === "") {
      lines.splice(-1, 0, `${key}=${value}`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

export function writeEnvironmentFile(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function resolveWorktreePath() {
  const value = process.env.ORCA_WORKTREE_PATH ?? process.cwd();
  try {
    return fs.realpathSync(path.resolve(value));
  } catch {
    throw new WorktreeError(`${value} does not exist`);
  }
}

export function resolveRootPath(worktreePath) {
  if (process.env.ORCA_ROOT_PATH) {
    return path.resolve(process.env.ORCA_ROOT_PATH);
  }
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new WorktreeError("cannot find the main checkout; set ORCA_ROOT_PATH");
  }
  return path.dirname(result.stdout.trim());
}

function gitDirectory(worktreePath) {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

const STATE_FILE = "orca-worktree.json";

function stateFile(worktreePath) {
  const directory = gitDirectory(worktreePath);
  return directory ? path.join(directory, STATE_FILE) : null;
}

export function readState(worktreePath) {
  const file = stateFile(worktreePath);
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function writeState(worktreePath, state) {
  const file = stateFile(worktreePath);
  if (!file) {
    throw new WorktreeError("cannot locate the worktree git directory");
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function removeState(worktreePath) {
  const file = stateFile(worktreePath);
  if (file) fs.rmSync(file, { force: true });
}

export function normalizeSourceName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export function deriveDatabaseName(sourceUrl, worktreePath) {
  const source = normalizeSourceName(databaseNameFromUrl(sourceUrl));
  const real = fs.realpathSync(worktreePath);
  const slug =
    path
      .basename(real)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "worktree";
  const hash = crypto
    .createHash("sha256")
    .update(`${real}\0${hostIdentity(sourceUrl)}\0${source}`)
    .digest("hex")
    .slice(0, 8);
  return `${`${source}_wt_${slug}`.slice(0, 54)}_${hash}`;
}

export function isGeneratedDatabaseName(name, sourceDatabase) {
  if (typeof name !== "string" || typeof sourceDatabase !== "string") {
    return false;
  }
  if (name.length > 63 || name === sourceDatabase) return false;
  if (!name.startsWith(`${sourceDatabase}_wt_`)) return false;
  return /^[a-z0-9_]+_[0-9a-f]{8}$/.test(name);
}

export function stateIsOurs(state, worktreePath) {
  if (!state || state.version !== 1) return false;
  if (state.worktree !== fs.realpathSync(worktreePath)) return false;
  if (typeof state.database !== "string") return false;
  if (typeof state.sourceDatabase !== "string") return false;
  return isGeneratedDatabaseName(state.database, normalizeSourceName(state.sourceDatabase));
}

const PG_VARIABLES = [
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLCERT",
  "PGSSLKEY",
  "PGSSLCRL",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
];

const PASSTHROUGH_PARAMETERS = new Map([
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"],
  ["sslkey", "PGSSLKEY"],
  ["sslcrl", "PGSSLCRL"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["application_name", "PGAPPNAME"],
]);

export function postgresEnvironment(value, database) {
  const url = parseDatabaseUrl(value);
  const env = { ...process.env };
  for (const key of PG_VARIABLES) delete env[key];
  delete env.DATABASE_URL;
  const socket = url.searchParams.get("host");
  const host = socket || url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host) env.PGHOST = host;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = database ?? databaseNameFromUrl(url);
  for (const [parameter, variable] of PASSTHROUGH_PARAMETERS) {
    const setting = url.searchParams.get(parameter);
    if (setting) env[variable] = setting;
  }
  return env;
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionDirectories(parent) {
  try {
    return fs
      .readdirSync(parent)
      .filter((entry) => /^\d+/.test(entry))
      .sort((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10));
  } catch {
    return [];
  }
}

function candidatePaths(name) {
  const candidates = [];
  for (const prefix of ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"]) {
    candidates.push(path.join(prefix, name));
  }
  for (const version of versionDirectories("/Applications/Postgres.app/Contents/Versions")) {
    candidates.push(path.join("/Applications/Postgres.app/Contents/Versions", version, "bin", name));
  }
  for (const version of versionDirectories("/usr/lib/postgresql")) {
    candidates.push(path.join("/usr/lib/postgresql", version, "bin", name));
  }
  return candidates;
}

export function resolveCommand(name, overrideVariable) {
  const override = process.env[overrideVariable];
  if (override) {
    if (!isExecutable(override)) {
      throw new WorktreeError(`${overrideVariable} does not point to an executable file`);
    }
    return override;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  for (const candidate of candidatePaths(name)) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new WorktreeError(`${name} was not found; install PostgreSQL client tools or set ${overrideVariable}`);
}

export function serverMajorVersion(psql, env) {
  const result = run(psql, ["-X", "-At", "-q", "-c", "show server_version_num"], { env });
  if (result.status !== 0) {
    throw new WorktreeError(`psql could not reach PostgreSQL: ${firstLine(result.stderr)}`);
  }
  const value = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(value)) {
    throw new WorktreeError("psql returned an unexpected server version");
  }
  return Math.floor(value / 10000);
}

function dumpMajorVersion(pgDump) {
  const result = run(pgDump, ["--version"]);
  if (result.status !== 0) {
    throw new WorktreeError(`pg_dump failed: ${firstLine(result.stderr)}`);
  }
  const match = /(\d+)/.exec(result.stdout);
  if (!match) {
    throw new WorktreeError("pg_dump returned an unexpected version");
  }
  return Number.parseInt(match[1], 10);
}

export function adminEnvironment(psql, sourceUrl) {
  if (process.env.ORCA_DATABASE_ADMIN_URL) {
    if (hostIdentity(process.env.ORCA_DATABASE_ADMIN_URL) !== hostIdentity(sourceUrl)) {
      throw new WorktreeError("ORCA_DATABASE_ADMIN_URL must point to the same PostgreSQL server as DATABASE_URL");
    }
    return postgresEnvironment(process.env.ORCA_DATABASE_ADMIN_URL);
  }
  for (const database of ["postgres", "template1"]) {
    const env = postgresEnvironment(sourceUrl, database);
    const probe = run(psql, ["-X", "-At", "-q", "-c", "select 1"], { env });
    if (probe.status === 0) return env;
  }
  throw new WorktreeError(
    "cannot connect to a maintenance database (postgres or template1); set ORCA_DATABASE_ADMIN_URL",
  );
}

export function databaseExists(psql, env, database) {
  const name = requireDatabaseName(database);
  const result = run(psql, ["-X", "-At", "-q", "-c", `select 1 from pg_database where datname = '${name}'`], { env });
  if (result.status !== 0) {
    throw new WorktreeError(`cannot inspect databases: ${firstLine(result.stderr)}`);
  }
  return result.stdout.trim() === "1";
}

export function createDatabase(psql, env, database, owner) {
  const name = requireDatabaseName(database);
  const ownerClause = owner ? ` owner ${quoteIdentifier(owner)}` : "";
  const result = run(
    psql,
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `create database ${quoteIdentifier(name)}${ownerClause}`],
    { env },
  );
  if (result.status !== 0) {
    throw new WorktreeError(`cannot create ${name}: ${firstLine(result.stderr)}`);
  }
}

function quoteIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new WorktreeError("cannot quote an empty database identifier");
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function dropDatabase(psql, env, database) {
  const name = requireDatabaseName(database);
  const result = run(
    psql,
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists "${name}" with (force)`],
    { env },
  );
  if (result.status !== 0) {
    throw new WorktreeError(`cannot drop ${name}: ${firstLine(result.stderr)}`);
  }
}

function requireDatabaseName(database) {
  if (typeof database !== "string" || !/^[a-z0-9_]{1,63}$/.test(database)) {
    throw new WorktreeError(`${database} is not a safe database name`);
  }
  return database;
}

async function stripUnsupportedSettings(file) {
  const temporary = `${file}.filtered`;
  const input = fs.createReadStream(file);
  const output = fs.createWriteStream(temporary, { mode: 0o600 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (/^SET transaction_timeout = 0;$/.test(line.trim())) continue;
    if (!output.write(`${line}\n`)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
  fs.renameSync(temporary, file);
}

export async function cloneDatabase({ pgDump, psql, sourceUrl, targetDatabase, targetDatabaseUrl }) {
  const dumpMajor = dumpMajorVersion(pgDump);
  const sourceEnv = postgresEnvironment(sourceUrl);
  const serverMajor = serverMajorVersion(psql, sourceEnv);
  if (dumpMajor < serverMajor) {
    throw new WorktreeError(
      `pg_dump ${dumpMajor} cannot dump PostgreSQL ${serverMajor}; install PostgreSQL ${serverMajor} client tools or set ORCA_PG_DUMP`,
    );
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artiflow-orca-"));
  const file = path.join(directory, "database.sql");
  try {
    const dump = run(pgDump, ["--no-owner", "--no-privileges", "--format=plain", "--file", file], { env: sourceEnv });
    if (dump.status !== 0) {
      throw new WorktreeError(`pg_dump failed: ${firstLine(dump.stderr)}`);
    }
    await stripUnsupportedSettings(file);
    const targetEnv = postgresEnvironment(targetDatabaseUrl, targetDatabase);
    const restore = run(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "--file", file], {
      env: targetEnv,
    });
    if (restore.status !== 0) {
      throw new WorktreeError(`restore failed: ${firstLine(restore.stderr)}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
