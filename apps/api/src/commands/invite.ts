import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { registrationInvite } from "../adapters/postgres/db/invite-schema.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { canonicalizeEmail, createInviteToken, inviteUrl, isEmailAddress } from "../invites/token.ts";
import { recordConsoleAdminEvent } from "../logging/admin-events.ts";

const USAGE = "usage: bun run user:invite EMAIL";
const CONSOLE_ACTOR_ID = "console";
const HELP = `${USAGE}
Print one single-use registration URL for EMAIL. The link expires in 24 hours.
An existing account is refused: this command never resets a password.`;

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
  if (error instanceof ConfigError) return `invitation: configuration is invalid: ${error.message}`;
  return "invitation: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

async function invite(email: string): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);
    const db = drizzle(database.pool);

    const existing = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(btrim(${user.email})) = ${email}`)
      .limit(1);
    if (existing.length > 0) {
      return refuse("invitation: an account already exists for that address; this command never resets a password.");
    }

    const issued = createInviteToken();
    const invitationId = randomUUID();
    await db.insert(registrationInvite).values({
      id: invitationId,
      email,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
    });
    recordConsoleAdminEvent({
      event: "invitation.created",
      actorId: CONSOLE_ACTOR_ID,
      actorRole: "console",
      subjectId: invitationId,
      outcome: "applied",
    });
    process.stdout.write(`${inviteUrl(config.publicOrigin, issued.token)}\n`);
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
  if (parsed.kind === "invalid-email") return refuse("invitation: the EMAIL argument is not a valid email address.");
  return invite(parsed.email);
}

process.exitCode = await run(process.argv.slice(2));
