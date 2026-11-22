#!/usr/bin/env node
import path from "node:path";
import {
  adminEnvironment,
  cloneDatabase,
  createDatabase,
  databaseExists,
  databaseNameFromUrl,
  databaseUrlFromEnvironment,
  deriveDatabaseName,
  dropDatabase,
  hostIdentity,
  log,
  postgresEnvironment,
  readOwnedFile,
  readState,
  resolveCommand,
  resolveRootPath,
  resolveWorktreePath,
  setEnvironmentValue,
  withDatabaseName,
  writeEnvironmentFile,
  writeState,
} from "./worktree-shared.mjs";

async function main() {
  const worktree = resolveWorktreePath();
  const root = resolveRootPath(worktree);
  const sourceFile = process.env.ORCA_WORKTREE_ENV_SOURCE ?? path.join(root, ".env.local");
  const sourceText = readOwnedFile(sourceFile);
  const sourceUrl = databaseUrlFromEnvironment(sourceText, sourceFile);
  const sourceDatabase = databaseNameFromUrl(sourceUrl);
  const sourceEnvironment = postgresEnvironment(sourceUrl);
  const targetDatabase = deriveDatabaseName(sourceUrl, worktree);
  const psql = resolveCommand("psql", "ORCA_PSQL");
  const pgDump = resolveCommand("pg_dump", "ORCA_PG_DUMP");
  const admin = adminEnvironment(psql, sourceUrl);
  const state = readState(worktree);
  const refresh = process.env.ORCA_WORKTREE_DB_REFRESH === "1";
  const reusable = state?.version === 1 && state.worktree === worktree && state.database === targetDatabase && !refresh;
  const exists = databaseExists(psql, admin, targetDatabase);

  if (!reusable || !exists) {
    if (exists) {
      log("setup", `dropping previous ${targetDatabase}`);
      dropDatabase(psql, admin, targetDatabase);
    }
    log("setup", `creating ${targetDatabase}`);
    createDatabase(psql, admin, targetDatabase, sourceEnvironment.PGUSER);
    try {
      log("setup", `cloning ${sourceDatabase} into ${targetDatabase}`);
      await cloneDatabase({
        pgDump,
        psql,
        sourceUrl,
        targetDatabase,
        targetDatabaseUrl: withDatabaseName(sourceUrl, targetDatabase),
      });
    } catch (error) {
      try {
        dropDatabase(psql, admin, targetDatabase);
      } catch {}
      throw error;
    }
  } else {
    log("setup", `reusing ${targetDatabase}`);
  }

  const targetUrl = withDatabaseName(sourceUrl, targetDatabase);
  writeEnvironmentFile(path.join(worktree, ".env.local"), setEnvironmentValue(sourceText, "DATABASE_URL", targetUrl));
  writeState(worktree, {
    version: 1,
    worktree,
    sourceDatabase,
    sourceHost: hostIdentity(sourceUrl),
    database: targetDatabase,
    createdAt: new Date().toISOString(),
  });
  log("setup", `wrote ${path.join(worktree, ".env.local")}`);
}

try {
  await main();
} catch (error) {
  console.error(`[orca:setup] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
