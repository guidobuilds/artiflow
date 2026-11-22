import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";
import { recordConsoleAdminEvent } from "../logging/admin-events.ts";
import { issuePasswordReset } from "../password-reset/service.ts";
import { resetPasswordUrl } from "../password-reset/token.ts";

const USAGE = "usage: bun run user:reset-password EMAIL";
const CONSOLE_ACTOR_ID = "console";
const HELP = `${USAGE}
Print one single-use password reset URL for an existing account. The link expires in 1 hour.
An unknown account is refused: this command never creates accounts and never changes a password.`;

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
  if (error instanceof ConfigError) return `password-reset: configuration is invalid: ${error.message}`;
  return "password-reset: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

async function reset(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const issued = await issuePasswordReset(database.db, email);
    if (issued.kind === "no-account") {
      return refuse("password-reset: no account exists for that address; this command never creates an account.");
    }
    recordConsoleAdminEvent({
      event: "password.reset.issued",
      actorId: CONSOLE_ACTOR_ID,
      actorRole: "console",
      subjectId: issued.userId,
      outcome: "applied",
    });
    process.stdout.write(`${resetPasswordUrl(config.publicOrigin, issued.token)}\n`);
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
    return refuse("password-reset: the EMAIL argument is not a valid email address.");
  return reset(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
