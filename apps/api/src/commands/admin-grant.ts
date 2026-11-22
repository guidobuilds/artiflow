import { eq, sql } from "drizzle-orm";

import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { ADMINISTRATOR_ROLE } from "../identity/roles.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";

const USAGE = "usage: bun run admin:grant EMAIL";
const HELP = `${USAGE}
Make an existing account an administrator. Use it to name the first administrator or to
recover an instance that has none.
An unknown address is refused: invite the person with user:invite first.`;

const CONSOLE_ACTOR_ID = "console";

type Arguments = { kind: "help" } | { kind: "email"; email: string } | { kind: "usage" } | { kind: "invalid-email" };

function parseArguments(argv: string[]): Arguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };
  if (argv.length !== 1) return { kind: "usage" };
  const raw = argv[0];
  if (raw === undefined) return { kind: "usage" };
  const email = canonicalizeEmail(raw);
  return isEmailAddress(email) ? { kind: "email", email } : { kind: "invalid-email" };
}

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError) return `admin:grant: configuration is invalid: ${error.message}`;
  return "admin:grant: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

type GrantOutcome = { kind: "missing" } | { kind: "unchanged" } | { kind: "changed" };

async function grant(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const outcome = await database.db.transaction(async (tx): Promise<GrantOutcome> => {
      const rows = await tx
        .select({ id: user.id, role: user.role })
        .from(user)
        .where(sql`lower(btrim(${user.email})) = ${email}`)
        .limit(1);
      const account = rows[0];
      if (account === undefined) return { kind: "missing" };
      if (account.role === ADMINISTRATOR_ROLE) return { kind: "unchanged" };
      const updated = await tx
        .update(user)
        .set({ role: ADMINISTRATOR_ROLE, updatedAt: new Date() })
        .where(eq(user.id, account.id))
        .returning({ id: user.id });
      const subject = updated[0];
      if (subject === undefined) return { kind: "missing" };
      recordAdminEvent({
        event: "role.granted",
        actorId: CONSOLE_ACTOR_ID,
        actorRole: "console",
        subjectId: subject.id,
        outcome: "applied",
      });
      return { kind: "changed" };
    });

    if (outcome.kind === "missing") {
      return refuse("admin:grant: no account exists for that address; invite it with user:invite first.");
    }
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
  if (parsed.kind === "invalid-email") return refuse("admin:grant: the EMAIL argument is not a valid email address.");
  return grant(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
