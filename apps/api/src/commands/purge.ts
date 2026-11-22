import { readSync } from "node:fs";

import { createDatabase, type Database } from "../adapters/postgres/db/client.ts";
import { findAccountByEmail, type AccountLookup } from "../admin/accounts.ts";
import { purgeAccount, type PurgeContent } from "../admin/purge.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";

const USAGE = "usage: bun run user:purge EMAIL (--reassign-to EMAIL | --delete-content) [--yes]";
const HELP = `${USAGE}
Delete the account of EMAIL together with its identities, sessions, issued tokens, pending
invitation and reset links, and its share grants.
Pass --reassign-to EMAIL to give the artifacts, revisions, comments and public links of that
account to another existing account, so the people they were shared with keep opening them.
Pass --delete-content to delete those artifacts, revisions, comments and public links instead.
The purge asks for the address to be typed again unless --yes is passed. It is never available
from the interface.`;

const CONSOLE_ACTOR_ID = "console";
const NOT_CONFIRMED =
  "user:purge: the purge of that account was not confirmed; type the address to confirm or pass --yes for non-interactive use.";

type Content = { kind: "delete" } | { kind: "reassign"; email: string };

type Arguments =
  | { kind: "help" }
  | { kind: "usage" }
  | { kind: "invalid-email" }
  | { kind: "invalid-target" }
  | { kind: "no-content" }
  | { kind: "both-content" }
  | { kind: "purge"; email: string; content: Content; confirmed: boolean };

function parseArguments(argv: string[]): Arguments {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };

  let email: string | null = null;
  let reassignTo: string | null = null;
  let deleteContent = false;
  let confirmed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--delete-content") {
      deleteContent = true;
      continue;
    }
    if (token === "--yes") {
      confirmed = true;
      continue;
    }
    if (token === "--reassign-to") {
      const value = argv[index + 1];
      if (value === undefined) return { kind: "usage" };
      reassignTo = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { kind: "usage" };
    if (email !== null) return { kind: "usage" };
    email = token;
  }

  if (email === null) return { kind: "usage" };
  const canonical = canonicalizeEmail(email);
  if (!isEmailAddress(canonical)) return { kind: "invalid-email" };
  if (reassignTo !== null && deleteContent) return { kind: "both-content" };
  if (reassignTo === null && !deleteContent) return { kind: "no-content" };
  if (reassignTo === null) return { kind: "purge", email: canonical, content: { kind: "delete" }, confirmed };

  const target = canonicalizeEmail(reassignTo);
  if (!isEmailAddress(target)) return { kind: "invalid-target" };
  return { kind: "purge", email: canonical, content: { kind: "reassign", email: target }, confirmed };
}

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError) return `user:purge: configuration is invalid: ${error.message}`;
  return "user:purge: the database is unavailable; check DATABASE_URL and that migrations are applied.";
}

function readLine(): string | null {
  const buffer = Buffer.alloc(1024);
  const chunks: Buffer[] = [];
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch {
      break;
    }
    if (read <= 0) break;
    const chunk = buffer.subarray(0, read);
    chunks.push(Buffer.from(chunk));
    if (chunk.includes(10)) break;
  }
  const [line] = Buffer.concat(chunks).toString("utf8").split("\n");
  return line === undefined || line.trim() === "" ? null : line.trim();
}

function confirmedAtPrompt(email: string): boolean {
  process.stderr.write(`user:purge: type ${email} to confirm the purge:\n`);
  const answer = readLine();
  return answer !== null && canonicalizeEmail(answer) === email;
}

async function purge(input: { email: string; content: Content; confirmed: boolean }): Promise<number> {
  let database: Database | null = null;
  try {
    const config = loadConfig(process.env);
    database = createDatabase(config.databaseUrl);

    const owner = await findAccountByEmail(database.db, input.email);
    if (owner === null) return refuse("user:purge: no account exists for that address.");

    let content: PurgeContent = { kind: "delete" };
    if (input.content.kind === "reassign") {
      const target: AccountLookup | null = await findAccountByEmail(database.db, input.content.email);
      if (target === null) {
        return refuse("user:purge: no account exists for the reassignment target; nothing was purged.");
      }
      if (target.id === owner.id) {
        return refuse("user:purge: the reassignment target is the same account; nothing was purged.");
      }
      content = { kind: "reassign", targetUserId: target.id };
    }

    if (!input.confirmed && !confirmedAtPrompt(input.email)) return refuse(NOT_CONFIRMED);

    const outcome = await purgeAccount({
      db: database.db,
      userId: owner.id,
      content,
      actorId: CONSOLE_ACTOR_ID,
      actorRole: "console",
    });

    if (outcome.kind === "missing") return refuse("user:purge: no account exists for that address.");
    if (outcome.kind === "target-missing") {
      return refuse("user:purge: no account exists for the reassignment target; nothing was purged.");
    }
    if (outcome.kind === "same-account") {
      return refuse("user:purge: the reassignment target is the same account; nothing was purged.");
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
  if (parsed.kind === "invalid-email") return refuse("user:purge: the EMAIL argument is not a valid email address.");
  if (parsed.kind === "invalid-target") {
    return refuse("user:purge: the --reassign-to argument is not a valid email address.");
  }
  if (parsed.kind === "no-content") {
    return refuse("user:purge: choose exactly one content choice: --reassign-to EMAIL or --delete-content.");
  }
  if (parsed.kind === "both-content") {
    return refuse("user:purge: --reassign-to and --delete-content cannot be combined; choose one.");
  }
  return purge(parsed);
}

process.exitCode = await run(process.argv.slice(2));
