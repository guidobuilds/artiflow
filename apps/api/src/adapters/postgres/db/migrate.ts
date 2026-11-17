import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { MigrationTargetError, assertMigrationTarget } from "./migration-target.ts";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../drizzle");
const ALLOW_REMOTE = process.env.ARTIFLOW_ALLOW_REMOTE_MIGRATE?.trim() === "1";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new MigrationTargetError("DATABASE_URL is not set; configure the external PostgreSQL connection first.");
}
assertMigrationTarget(connectionString, ALLOW_REMOTE);

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5000,
  application_name: "artiflow-local-migrate",
});

try {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  const target = ALLOW_REMOTE ? "the configured database" : "the configured loopback database";
  console.log(`[migrate] migrations applied to ${target}; already-applied migrations are tracked and skipped.`);
} finally {
  await pool.end();
}
