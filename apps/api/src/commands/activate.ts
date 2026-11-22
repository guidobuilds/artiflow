import { findAccountByEmail } from "../admin/accounts.ts";
import { reactivateAccount } from "../admin/lifecycle.ts";
import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";

const USAGE = "usage: bun run user:activate EMAIL";
const HELP = `${USAGE}
Bring back the account that holds EMAIL after a deactivation, exactly as the users directory
does: the account is marked active again and can sign in with the methods the instance allows.
The sessions that ended stay ended and the public links that were revoked stay revoked; the
account signs in again, and a link that is still needed has to be published again.
An unknown address and an account that is already active are refused with nothing changed.`;

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
  if (error instanceof ConfigError) return `user:activate: configuration is invalid: ${error.message}`;
  return "user:activate: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

async function activate(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const owner = await findAccountByEmail(database.db, email);
    if (owner === null) return refuse("user:activate: no account exists for that address.");

    const outcome = await reactivateAccount({
      db: database.db,
      userId: owner.id,
      actorId: CONSOLE_ACTOR_ID,
      actorRole: "console",
    });

    if (outcome.kind === "missing") return refuse("user:activate: no account exists for that address.");
    if (outcome.kind === "unchanged") {
      return refuse("user:activate: that account is already active; nothing changed.");
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
  if (parsed.kind === "invalid-email") {
    return refuse("user:activate: the EMAIL argument is not a valid email address.");
  }
  return activate(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
