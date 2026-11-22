import { asc, eq } from "drizzle-orm";

import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { ADMINISTRATOR_ROLE } from "../identity/roles.ts";

const USAGE = "usage: bun run admin:list";
const HELP = `${USAGE}
Print one email address per administrator, sorted by address.
An instance with no administrator prints nothing and exits 0.`;

type Arguments = { kind: "help" } | { kind: "list" } | { kind: "usage" };

function parseArguments(argv: string[]): Arguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };
  if (argv.length !== 0) return { kind: "usage" };
  return { kind: "list" };
}

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError) return `admin:list: configuration is invalid: ${error.message}`;
  return "admin:list: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

async function list(): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const rows = await database.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.role, ADMINISTRATOR_ROLE))
      .orderBy(asc(user.email));
    for (const row of rows) process.stdout.write(`${row.email}\n`);
    return 0;
  } catch (error) {
    return refuse(describeFailure(error));
  } finally {
    await database?.close().catch(() => undefined);
  }
}

async function run(argv: string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.kind === "usage") return refuse(USAGE);
  return list();
}

process.exitCode = await run(process.argv.slice(2));
