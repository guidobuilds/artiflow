import { findAccountByEmail } from "../admin/accounts.ts";
import { deactivateAccount } from "../admin/lifecycle.ts";
import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";

const USAGE = "usage: bun run user:deactivate EMAIL";
const HELP = `${USAGE}
Cut the access of the account that holds EMAIL, exactly as the users directory does: the
account is marked deactivated, its sessions are deleted, the tokens issued to it are revoked
and the public links of its artifacts are revoked, all in one transaction.
Nothing is deleted. The artifacts, revisions, comments and share grants keep their rows.
An unknown address and an account that is already deactivated are refused with nothing changed.
The account is brought back with user:activate.`;

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
  if (error instanceof ConfigError) return `user:deactivate: configuration is invalid: ${error.message}`;
  return "user:deactivate: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

async function deactivate(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const owner = await findAccountByEmail(database.db, email);
    if (owner === null) return refuse("user:deactivate: no account exists for that address.");

    const outcome = await deactivateAccount({
      db: database.db,
      userId: owner.id,
      actorId: CONSOLE_ACTOR_ID,
      actorRole: "console",
    });

    if (outcome.kind === "missing") return refuse("user:deactivate: no account exists for that address.");
    if (outcome.kind === "unchanged") {
      return refuse("user:deactivate: that account is already deactivated; nothing changed.");
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
    return refuse("user:deactivate: the EMAIL argument is not a valid email address.");
  }
  return deactivate(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
