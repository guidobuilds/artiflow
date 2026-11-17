import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { appSchema } from "./app-schema.ts";

export type Database = {
  pool: Pool;
  db: NodePgDatabase<typeof appSchema>;
  check: () => Promise<void>;
  close: () => Promise<void>;
};

export type AppDb = NodePgDatabase<typeof appSchema>;
export type AppTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    application_name: "artiflow-local-api",
  });

  return {
    pool,
    db: drizzle(pool, { schema: appSchema }),
    async check() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}
