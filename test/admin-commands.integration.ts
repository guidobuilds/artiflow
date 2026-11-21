import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { asc, eq } from "drizzle-orm";

import {
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { ACTIVE_ACCOUNT_STATUS, DEACTIVATED_ACCOUNT_STATUS } from "../apps/api/src/identity/account-status.ts";
import { ADMINISTRATOR_ROLE } from "../apps/api/src/identity/roles.ts";
import {
  adminRequest,
  assertStatus,
  sessionCookieOf,
  startAdminHarness,
  type AdminHarness,
  type CommandResult,
} from "./helpers/admin-harness.ts";
import {
  seedTrustedAccount,
  trustedSession,
  type TrustedAccount,
  type TrustedFixture,
  type TrustedSession,
} from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const SIGN_IN_PATH = "/api/auth/sign-in/email";

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
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

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function signIn(email: string, password: string): Promise<Response> {
  return adminRequest(target(), SIGN_IN_PATH, {
    method: "POST",
    headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return rows.map((row) => row.id);
}

async function storedStatus(
  userId: string,
): Promise<{ status: string; deactivatedAt: Date | null; deactivatedBy: string | null }> {
  const rows = await target()
    .database.db.select({ status: user.status, deactivatedAt: user.deactivatedAt, deactivatedBy: user.deactivatedBy })
    .from(user)
    .where(eq(user.id, userId));
  const row = rows[0];
  assert.ok(row, "the account exists");
  return row;
}

type OwnedContent = { artifactId: string; revisionId: string; commentId: string; linkId: string };

async function seedOwnedContent(ownerId: string, readerId: string): Promise<OwnedContent> {
  const db = target().database.db;
  const now = new Date();
  const artifactId = `artifact-${randomUUID()}`;
  const revisionId = randomUUID();
  await db.insert(artifacts).values({
    id: artifactId,
    ownerId,
    title: "Console lifecycle content",
    kind: "markdown",
    observedSizeBytes: 24,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(artifactRevisions).values({
    id: revisionId,
    artifactId,
    revision: 1,
    sizeBytes: 24,
    sha256: createHash("sha256").update(artifactId).digest("hex"),
    storageKey: `console-commands/${artifactId}`,
    createdAt: now,
  });
  await db.update(artifacts).set({ currentRevisionId: revisionId }).where(eq(artifacts.id, artifactId));
  const commentId = randomUUID();
  await db.insert(artifactComments).values({
    id: commentId,
    artifactId,
    authorId: ownerId,
    anchor: { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 2, quotedText: "#" },
    body: "Kept through a console deactivation",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(artifactShares).values({
    artifactId,
    sharedWithUserId: readerId,
    grantedByUserId: ownerId,
    role: "reader",
    createdAt: now,
  });
  const links = await db
    .insert(artifactPublicLinks)
    .values({ artifactId, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), createdAt: now })
    .returning({ id: artifactPublicLinks.id });
  const linkId = links[0]?.id;
  assert.ok(linkId, "the public link was seeded");
  return { artifactId, revisionId, commentId, linkId };
}

async function contentOf(content: OwnedContent): Promise<{
  artifacts: number;
  revisions: number;
  comments: number;
  grants: number;
}> {
  const db = target().database.db;
  const artifactRows = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, content.artifactId));
  const revisionRows = await db
    .select({ id: artifactRevisions.id })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, content.artifactId));
  const commentRows = await db
    .select({ id: artifactComments.id })
    .from(artifactComments)
    .where(eq(artifactComments.artifactId, content.artifactId));
  const shareRows = await db
    .select({ id: artifactShares.id })
    .from(artifactShares)
    .where(eq(artifactShares.artifactId, content.artifactId));
  return {
    artifacts: artifactRows.length,
    revisions: revisionRows.length,
    comments: commentRows.length,
    grants: shareRows.length,
  };
}

async function linkRevokedAt(linkId: string): Promise<Date | null> {
  const rows = await target()
    .database.db.select({ revokedAt: artifactPublicLinks.revokedAt })
    .from(artifactPublicLinks)
    .where(eq(artifactPublicLinks.id, linkId));
  const row = rows[0];
  assert.ok(row, "the public link keeps its row");
  return row.revokedAt;
}

async function liveSession(cookie: string): Promise<Response> {
  const response = await adminRequest(target(), "/api/artifacts", { headers: { cookie } });
  await response.arrayBuffer();
  return response;
}

async function victimSession(name: string): Promise<TrustedSession> {
  return await trustedSession(fixtureOf(), { name });
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
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
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

integration("deactivate blocks a fresh sign-in and stops the session the account already had", async () => {
  const victim = await victimSession("Console Deactivation Victim");
  assertStatus(await liveSession(victim.cookie), 200, "the live session reads before the command runs");
  assert.equal((await sessionIdsOf(victim.userId)).length, 1, "the account holds one session to cut");

  const result = target().command("user:deactivate", [victim.email]);

  assert.equal(result.status, 0, `deactivate succeeds: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const event = singleAuditLine(result);
  assert.equal(event.event, "user.deactivated");
  assert.equal(event.actorRole, "console");
  assert.equal(event.outcome, "applied");
  assert.equal(event.subjectId, victim.userId);
  assert.deepEqual(
    { status: (await storedStatus(victim.userId)).status, by: (await storedStatus(victim.userId)).deactivatedBy },
    { status: DEACTIVATED_ACCOUNT_STATUS, by: "console" },
  );
  assert.notEqual((await storedStatus(victim.userId)).deactivatedAt, null, "the transition is stamped");
  assert.equal((await sessionIdsOf(victim.userId)).length, 0, "the console cut every session of the account");

  const refused = await signIn(victim.email, victim.password);
  assert.equal(refused.status, 401, "the password no longer signs in");
  assert.equal(sessionCookieOf(refused), "", "no session cookie is issued");
  assert.equal((await sessionIdsOf(victim.userId)).length, 0, "the refused sign-in creates no session row");

  assertStatus(await liveSession(victim.cookie), 401, "the session that ended no longer reads");
});

integration("activate restores sign-in without restoring sessions or revoked links", async () => {
  const owner = await victimSession("Console Reactivation Owner");
  const reader = await victimSession("Console Reactivation Reader");
  const content = await seedOwnedContent(owner.userId, reader.userId);
  const endedSessions = await sessionIdsOf(owner.userId);
  assert.equal(endedSessions.length, 1, "the account holds the session that deactivation will end");

  assert.equal(target().command("user:deactivate", [owner.email]).status, 0, "deactivate succeeds");
  assert.notEqual(await linkRevokedAt(content.linkId), null, "deactivation revoked the public link");
  assert.equal((await signIn(owner.email, owner.password)).status, 401, "the deactivated account cannot sign in");

  const result = target().command("user:activate", [owner.email]);

  assert.equal(result.status, 0, `activate succeeds: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const event = singleAuditLine(result);
  assert.equal(event.event, "user.reactivated");
  assert.equal(event.actorRole, "console");
  assert.equal(event.outcome, "applied");
  assert.equal(event.subjectId, owner.userId);
  assert.deepEqual(await storedStatus(owner.userId), {
    status: ACTIVE_ACCOUNT_STATUS,
    deactivatedAt: null,
    deactivatedBy: null,
  });

  const signedIn = await signIn(owner.email, owner.password);
  assert.equal(signedIn.status, 200, "the activated account signs in again");
  assert.equal(sessionCookieOf(signedIn).length > 0, true, "the sign-in issues a fresh session cookie");

  const liveSessions = await sessionIdsOf(owner.userId);
  assert.equal(liveSessions.length, 1, "only the fresh sign-in holds a session");
  assert.equal(
    liveSessions.some((id) => endedSessions.includes(id)),
    false,
    "the sessions that ended were not restored",
  );
  assert.notEqual(await linkRevokedAt(content.linkId), null, "the revoked public link stays revoked");
  assert.deepEqual(await contentOf(content), { artifacts: 1, revisions: 1, comments: 1, grants: 1 });
});

integration("deactivate refuses an unknown address and a redundant transition, recording nothing", async () => {
  const unknown = `unknown-${randomUUID()}@example.test`;

  const missing = target().command("user:deactivate", [unknown]);

  assertRefusal(missing);
  assert.equal(
    missing.stderr.includes("no account exists for that address"),
    true,
    `the refusal names the unknown address: ${missing.stderr}`,
  );
  assert.deepEqual(await target().database.db.select({ id: user.id }).from(user).where(eq(user.email, unknown)), []);

  const missingActivation = target().command("user:activate", [unknown]);
  assertRefusal(missingActivation);
  assert.equal(missingActivation.stderr.includes("no account exists for that address"), true);

  const alreadyActive = await victimSession("Console Already Active");
  const redundantActivation = target().command("user:activate", [alreadyActive.email]);

  assertRefusal(redundantActivation);
  assert.equal(redundantActivation.stderr.includes("already active"), true, `the refusal says why: ${redundantActivation.stderr}`);
  assert.deepEqual(await storedStatus(alreadyActive.userId), {
    status: ACTIVE_ACCOUNT_STATUS,
    deactivatedAt: null,
    deactivatedBy: null,
  });
  assert.equal((await sessionIdsOf(alreadyActive.userId)).length, 1, "the refusal leaves the live session alone");

  const alreadyDeactivated = await victimSession("Console Already Deactivated");
  assert.equal(target().command("user:deactivate", [alreadyDeactivated.email]).status, 0, "deactivate succeeds once");
  const statusAfterFirst = await storedStatus(alreadyDeactivated.userId);
  const redundantDeactivation = target().command("user:deactivate", [alreadyDeactivated.email]);

  assertRefusal(redundantDeactivation);
  assert.equal(
    redundantDeactivation.stderr.includes("already deactivated"),
    true,
    `the refusal says why: ${redundantDeactivation.stderr}`,
  );
  assert.deepEqual(await storedStatus(alreadyDeactivated.userId), statusAfterFirst, "the stored state is unchanged");
  assert.equal((await sessionIdsOf(alreadyDeactivated.userId)).length, 0);
  assert.equal((await signIn(alreadyDeactivated.email, alreadyDeactivated.password)).status, 401);
});

integration("deactivating from the console keeps the content of the account", async () => {
  const owner = await victimSession("Console Content Owner");
  const reader = await victimSession("Console Content Reader");
  const content = await seedOwnedContent(owner.userId, reader.userId);

  assert.equal(target().command("user:deactivate", [owner.email]).status, 0, "deactivate succeeds");

  assert.deepEqual(await contentOf(content), { artifacts: 1, revisions: 1, comments: 1, grants: 1 });
  assert.notEqual(await linkRevokedAt(content.linkId), null, "only the public link is revoked");

  assert.equal(target().command("user:activate", [owner.email]).status, 0, "activate succeeds");

  assert.deepEqual(await contentOf(content), { artifacts: 1, revisions: 1, comments: 1, grants: 1 });
  assert.notEqual(await linkRevokedAt(content.linkId), null, "activation restores no link");
});
