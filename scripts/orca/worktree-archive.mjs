#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  adminEnvironment,
  databaseExists,
  databaseNameFromUrl,
  databaseUrlFromEnvironment,
  deriveDatabaseName,
  dropDatabase,
  isGeneratedDatabaseName,
  log,
  normalizeSourceName,
  readOwnedFile,
  readState,
  removeState,
  resolveCommand,
  resolveRootPath,
  resolveWorktreePath,
  stateIsOurs,
} from "./worktree-shared.mjs";

function readRootSource(root) {
  if (!root) return null;
  const file = process.env.ORCA_WORKTREE_ENV_SOURCE ?? path.join(root, ".env.local");
  if (!fs.existsSync(file)) return null;
  try {
    return databaseUrlFromEnvironment(readOwnedFile(file), file);
  } catch {
    return null;
  }
}

function readWorktreeSource(worktree) {
  const file = path.join(worktree, ".env.local");
  if (!fs.existsSync(file)) return null;
  return databaseUrlFromEnvironment(readOwnedFile(file), file);
}

function main() {
  const worktree = resolveWorktreePath();
  let root = null;
  try {
    root = resolveRootPath(worktree);
  } catch {}
  const state = readState(worktree);
  const rootSource = readRootSource(root);
  let connectionSource = rootSource;
  if (!connectionSource) {
    try {
      connectionSource = readWorktreeSource(worktree);
    } catch {
      connectionSource = null;
    }
  }
  const owned = stateIsOurs(state, worktree);

  let database = null;
  let recorded = null;
  let sourceDatabase = null;
  if (owned) {
    recorded = state.database;
    database = state.database;
    sourceDatabase = normalizeSourceName(state.sourceDatabase);
    if (rootSource) {
      const derived = deriveDatabaseName(rootSource, worktree);
      if (derived !== database) {
        log("archive", `state names ${database}, current source derives ${derived}; leaving ${database} in place`);
        database = null;
      }
    }
  } else if (rootSource) {
    database = deriveDatabaseName(rootSource, worktree);
    sourceDatabase = normalizeSourceName(databaseNameFromUrl(rootSource));
  }

  if (!database || !sourceDatabase || !isGeneratedDatabaseName(database, sourceDatabase)) {
    log("archive", "no generated database found; nothing to drop");
  } else if (!connectionSource) {
    log("archive", `cannot connect; drop ${database} manually`);
  } else {
    const psql = resolveCommand("psql", "ORCA_PSQL");
    const admin = adminEnvironment(psql, connectionSource);
    try {
      if (databaseExists(psql, admin, database)) {
        log("archive", `dropping ${database}`);
        dropDatabase(psql, admin, database);
      } else {
        log("archive", `${database} does not exist`);
      }
    } catch (error) {
      log("archive", `drop ${database} manually if it still exists`);
      throw error;
    }
  }

  const envFile = path.join(worktree, ".env.local");
  if (recorded && fs.existsSync(envFile)) {
    try {
      const worktreeSource = readWorktreeSource(worktree);
      if (worktreeSource && databaseNameFromUrl(worktreeSource) === recorded) {
        fs.rmSync(envFile);
        log("archive", `removed ${envFile}`);
      }
    } catch {}
  }
  removeState(worktree);
}

try {
  main();
} catch (error) {
  console.error(`[orca:archive] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
