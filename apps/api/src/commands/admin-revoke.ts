import { eq, sql } from "drizzle-orm";

import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { ADMINISTRATOR_ROLE, MEMBER_ROLE } from "../identity/roles.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";

const USAGE = "usage: bun run admin:revoke EMAIL";
const HELP = `${USAGE}
Return an existing administrator to the member role.
An unknown address and an account that is not an administrator are refused.`;

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
  if (error instanceof ConfigError) return `admin:revoke: configuration is invalid: ${error.message}`;
  return "admin:revoke: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

type RevokeOutcome = { kind: "missing" } | { kind: "not-administrator" } | { kind: "revoked" };

async function revoke(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const outcome = await database.db.transaction(async (tx): Promise<RevokeOutcome> => {
      const rows = await tx
        .select({ id: user.id, role: user.role })
        .from(user)
        .where(sql`lower(btrim(${user.email})) = ${email}`)
        .limit(1);
      const account = rows[0];
      if (account === undefined) return { kind: "missing" };
      if (account.role !== ADMINISTRATOR_ROLE) return { kind: "not-administrator" };
      const updated = await tx
        .update(user)
        .set({ role: MEMBER_ROLE, updatedAt: new Date() })
        .where(eq(user.id, account.id))
        .returning({ id: user.id });
      const subject = updated[0];
      if (subject === undefined) return { kind: "missing" };
      recordAdminEvent({
        event: "role.revoked",
        actorId: CONSOLE_ACTOR_ID,
        actorRole: "console",
        subjectId: subject.id,
        outcome: "applied",
      });
      return { kind: "revoked" };
    });

    if (outcome.kind === "missing") return refuse("admin:revoke: no account exists for that address.");
    if (outcome.kind === "not-administrator") {
      return refuse("admin:revoke: that account is not an administrator; nothing to revoke.");
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
  if (parsed.kind === "invalid-email")
    return refuse("admin:revoke: the EMAIL argument is not a valid email address.");
  return revoke(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
