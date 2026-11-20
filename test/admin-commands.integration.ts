import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { asc, eq } from "drizzle-orm";

import { user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { ADMINISTRATOR_ROLE } from "../apps/api/src/identity/roles.ts";
import { startAdminHarness, type AdminHarness, type CommandResult } from "./helpers/admin-harness.ts";
import { seedTrustedAccount, type TrustedAccount } from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

let harness: AdminHarness | null = null;
let member: TrustedAccount | null = null;
let firstAdministrator: TrustedAccount | null = null;
let secondAdministrator: TrustedAccount | null = null;
let outsider: TrustedAccount | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function account(value: TrustedAccount | null, label: string): TrustedAccount {
  assert.ok(value, `the ${label} account exists`);
  return value;
}

async function roleOf(accountId: string): Promise<string | undefined> {
  const rows = await target().database.db.select({ role: user.role }).from(user).where(eq(user.id, accountId));
  return rows[0]?.role;
}

async function administratorEmails(): Promise<string[]> {
  const rows = await target()
    .database.db.select({ email: user.email })
    .from(user)
    .where(eq(user.role, ADMINISTRATOR_ROLE))
    .orderBy(asc(user.email));
  return rows.map((row) => row.email);
}

function stdoutLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

function singleAuditLine(result: CommandResult): Record<string, unknown> {
  assert.equal(result.stdout.endsWith("\n"), true, "stdout is newline terminated");
  const lines = stdoutLines(result.stdout);
  assert.equal(lines.length, 1, `exactly one audit line on stdout: ${result.stdout}`);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

function assertRefusal(result: CommandResult): void {
  assert.equal(result.status, 1, "a refusal exits with status 1");
  assert.equal(result.stdout, "", "a refusal writes nothing to stdout");
  assert.equal(result.stderr.trim().length > 0, true, "a refusal explains itself on stderr");
  assert.equal(/^\s+at\s/m.test(result.stderr), false, "no stack trace");
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  const suffix = randomUUID();
  member = await seedTrustedAccount(target().database, {
    email: `member-${suffix}@example.test`,
    name: "Ordinary Member",
  });
  outsider = await seedTrustedAccount(target().database, {
    email: `outsider-${suffix}@example.test`,
    name: "Other Member",
  });
  firstAdministrator = await seedTrustedAccount(target().database, {
    email: `zeta-${suffix}@example.test`,
    name: "First Administrator",
    role: ADMINISTRATOR_ROLE,
  });
  secondAdministrator = await seedTrustedAccount(target().database, {
    email: `alpha-${suffix}@example.test`,
    name: "Second Administrator",
    role: ADMINISTRATOR_ROLE,
  });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("grant promotes an existing member and records the applied event", async () => {
  const granted = account(member, "member");
  const result = target().command("admin:grant", [granted.email]);

  assert.equal(result.status, 0, `grant succeeds: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const event = singleAuditLine(result);
  assert.equal(event.event, "role.granted");
  assert.equal(event.actorRole, "console");
  assert.equal(event.outcome, "applied");
  assert.equal(event.subjectId, granted.userId);
  assert.equal(await roleOf(granted.userId), ADMINISTRATOR_ROLE);
});

integration("grant refuses an unknown email, names the invitation path and changes nothing", async () => {
  const existing = account(outsider, "outsider");
  const unknown = `unknown-${randomUUID()}@example.test`;

  const result = target().command("admin:grant", [unknown]);

  assertRefusal(result);
  assert.equal(result.stderr.includes("user:invite"), true, `the refusal names the invitation path: ${result.stderr}`);
  const rows = await target().database.db.select({ id: user.id }).from(user).where(eq(user.email, unknown));
  assert.deepEqual(rows, [], "an unknown address creates no account");
  assert.equal(await roleOf(existing.userId), "member", "the refusal changes no other account");
});

integration("revoke demotes an administrator and records the applied event", async () => {
  const demoted = account(firstAdministrator, "first administrator");
  const result = target().command("admin:revoke", [demoted.email]);

  assert.equal(result.status, 0, `revoke succeeds: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const event = singleAuditLine(result);
  assert.equal(event.event, "role.revoked");
  assert.equal(event.actorRole, "console");
  assert.equal(event.outcome, "applied");
  assert.equal(event.subjectId, demoted.userId);
  assert.equal(await roleOf(demoted.userId), "member");
});

integration("revoke refuses an account that is not an administrator and an unknown address", async () => {
  const notAnAdministrator = account(outsider, "outsider");
  const refusal = target().command("admin:revoke", [notAnAdministrator.email]);

  assertRefusal(refusal);
  assert.equal(/not an administrator/i.test(refusal.stderr), true, `the refusal explains itself: ${refusal.stderr}`);
  assert.equal(await roleOf(notAnAdministrator.userId), "member");

  const unknown = `missing-${randomUUID()}@example.test`;
  const unknownRefusal = target().command("admin:revoke", [unknown]);
  assertRefusal(unknownRefusal);
  assert.equal(/no account/i.test(unknownRefusal.stderr), true, `the refusal explains itself: ${unknownRefusal.stderr}`);
});

integration("list prints every administrator email in order and exits 0", async () => {
  const expected = await administratorEmails();
  assert.equal(expected.length >= 2, true, "the fixture keeps administrators to list");

  const result = target().command("admin:list", []);

  assert.equal(result.status, 0, `list succeeds: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true, "stdout is newline terminated");
  assert.deepEqual(stdoutLines(result.stdout), expected);
  assert.equal(expected.includes(account(secondAdministrator, "second administrator").email), true);
  assert.equal(expected.includes(account(member, "member").email), true);
  assert.equal(expected.includes(account(outsider, "outsider").email), false);
  assert.deepEqual(stdoutLines(result.stdout).slice().sort(), stdoutLines(result.stdout), "the list is sorted");
});

integration("list exits 0 and prints nothing when no administrator is left", async () => {
  const remaining = await administratorEmails();
  assert.equal(remaining.length > 0, true, "the fixture still holds administrators to remove");
  for (const email of remaining) {
    const revoked = target().command("admin:revoke", [email]);
    assert.equal(revoked.status, 0, `revoke succeeds for ${email}: ${revoked.stderr}`);
  }
  assert.deepEqual(await administratorEmails(), []);

  const result = target().command("admin:list", []);

  assert.equal(result.status, 0, `list succeeds with no administrator: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
