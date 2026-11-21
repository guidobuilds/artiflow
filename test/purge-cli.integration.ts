import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import {
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { registrationInvite } from "../apps/api/src/adapters/postgres/db/invite-schema.ts";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../apps/api/src/adapters/postgres/db/oauth-schema.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { hashInviteToken } from "../apps/api/src/invites/token.ts";
import { hashLinkToken } from "../apps/api/src/routes/sharing.ts";
import { seedTrustedAccount, trustedSession, type TrustedFixture } from "./helpers/trusted-accounts.ts";
import {
  adminRequest,
  startAdminHarness,
  type AdminHarness,
  type CommandResult,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const SIGN_IN_PATH = "/api/auth/sign-in/email";
const REGISTRATION_PREVIEW_PATH = "/api/auth/registration/preview";
const RESET_PREVIEW_PATH = "/api/auth/password-reset/preview";
const RESET_MARKER = "#token=";

const ACCOUNT_REFERENCES: readonly [table: string, column: string][] = [
  ["account", "userId"],
  ["session", "userId"],
  ["registrationInvite", "userId"],
  ["registrationInvite", "createdBy"],
  ["passwordResetToken", "userId"],
  ["passwordResetToken", "createdBy"],
  ["oauthAccessToken", "userId"],
  ["oauthRefreshToken", "userId"],
  ["oauthConsent", "userId"],
  ["oauthClient", "userId"],
  ["ssoProvider", "userId"],
  ["artifactUploads", "ownerId"],
  ["artifacts", "ownerId"],
  ["artifactComments", "authorId"],
  ["artifactComments", "resolvedBy"],
  ["artifactShares", "sharedWithUserId"],
  ["artifactShares", "grantedByUserId"],
];

type OwnedContent = {
  artifactId: string;
  revisionId: string;
  linkToken: string;
  ownerCommentId: string;
  readerCommentId: string;
  storageKey: string;
};

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function purge(args: string[], stdin?: string): CommandResult {
  return target().command("user:purge", args, stdin);
}

function stdoutLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

function singleLineOf(result: CommandResult): Record<string, unknown> {
  const lines = stdoutLines(result.stdout);
  assert.equal(lines.length, 1, `exactly one line on stdout: ${result.stdout}`);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

function assertRefusal(result: CommandResult, pattern: RegExp): void {
  assert.equal(result.status, 1, `a refusal exits with status 1: ${result.stdout}`);
  assert.equal(result.stdout, "", "a refusal writes nothing to stdout");
  assert.equal(result.stderr.trim().length > 0, true, "a refusal explains itself on stderr");
  assert.equal(/^\s+at\s/m.test(result.stderr), false, "no stack trace");
  assert.match(result.stderr, pattern);
}

async function accountExists(userId: string): Promise<boolean> {
  const rows = await target().database.db.select({ id: user.id }).from(user).where(eq(user.id, userId));
  return rows.length > 0;
}

async function referenceCounts(userId: string): Promise<{ table: string; column: string; rows: number }[]> {
  const counted = await Promise.all(
    ACCOUNT_REFERENCES.map(async ([table, column]) => {
      const result = await target().database.pool.query<{ count: string }>(
        `select count(*)::text as count from "${table}" where "${column}" = $1`,
        [userId],
      );
      return { table, column, rows: Number(result.rows[0]?.count ?? "0") };
    }),
  );
  return counted;
}

async function assertNoDanglingReferences(userId: string): Promise<void> {
  const counted = await referenceCounts(userId);
  const remaining = counted.filter((entry) => entry.rows > 0);
  assert.deepEqual(remaining, [], "no row anywhere references the purged account");
}

async function seedOwnedContent(ownerId: string, readerId: string, title: string): Promise<OwnedContent> {
  const db = target().database.db;
  const now = new Date();
  const artifactId = `artifact-${randomUUID()}`;
  const revisionId = randomUUID();
  const storageKey = `purge/${artifactId}`;
  await db.insert(artifacts).values({
    id: artifactId,
    ownerId,
    title,
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
    storageKey,
    createdAt: now,
  });
  await db.update(artifacts).set({ currentRevisionId: revisionId }).where(eq(artifacts.id, artifactId));
  const ownerCommentId = randomUUID();
  const readerCommentId = randomUUID();
  const anchor = { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 2, quotedText: "#" };
  await db.insert(artifactComments).values([
    { id: ownerCommentId, artifactId, authorId: ownerId, anchor, body: "Written by the owner", createdAt: now, updatedAt: now },
    { id: readerCommentId, artifactId, authorId: readerId, anchor, body: "Written by the reader", createdAt: now, updatedAt: now },
  ]);
  await db.insert(artifactShares).values({
    artifactId,
    sharedWithUserId: readerId,
    grantedByUserId: ownerId,
    role: "reader",
    createdAt: now,
  });
  const linkToken = randomBytes(32).toString("base64url");
  await db.insert(artifactPublicLinks).values({
    id: randomUUID(),
    artifactId,
    tokenHash: hashLinkToken(linkToken),
    createdAt: now,
  });
  return { artifactId, revisionId, linkToken, ownerCommentId, readerCommentId, storageKey };
}

async function seedIssuedCredentials(ownerId: string): Promise<void> {
  const db = target().database.db;
  const now = new Date();
  const clientId = `purge-client-${randomUUID()}`;
  await db.insert(oauthClient).values({
    id: randomUUID(),
    clientId,
    name: "Purge Fixture Client",
    redirectUris: ["http://127.0.0.1:5173/oauth/callback"],
    userId: ownerId,
  });
  await db.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: `refresh-${randomUUID()}`,
    clientId,
    userId: ownerId,
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    scopes: ["artifacts:read"],
  });
  await db.insert(oauthAccessToken).values({
    id: randomUUID(),
    token: `access-${randomUUID()}`,
    clientId,
    userId: ownerId,
    expiresAt: new Date(now.getTime() + 900_000),
    createdAt: now,
    scopes: ["artifacts:read"],
  });
  await db.insert(oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId: ownerId,
    scopes: ["artifacts:read"],
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPendingInvitation(email: string, createdBy: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await target().database.db.insert(registrationInvite).values({
    id: randomUUID(),
    email,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdBy,
  });
  return token;
}

function resetTokenOf(email: string): string {
  const issued = target().command("user:reset-password", [email]);
  assert.equal(issued.status, 0, `the reset link is issued: ${issued.stderr}`);
  const url = issued.stdout.trim();
  const marker = url.indexOf(RESET_MARKER);
  assert.equal(marker > 0, true, `the reset link carries a token: ${url}`);
  return url.slice(marker + RESET_MARKER.length);
}

async function contentCounts(content: OwnedContent): Promise<{ artifacts: number; revisions: number; comments: number; grants: number; links: number }> {
  const db = target().database.db;
  const [artifactRows, revisionRows, commentRows, grantRows, linkRows] = await Promise.all([
    db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, content.artifactId)),
    db.select({ id: artifactRevisions.id }).from(artifactRevisions).where(eq(artifactRevisions.artifactId, content.artifactId)),
    db.select({ id: artifactComments.id }).from(artifactComments).where(eq(artifactComments.artifactId, content.artifactId)),
    db.select({ id: artifactShares.id }).from(artifactShares).where(eq(artifactShares.artifactId, content.artifactId)),
    db.select({ id: artifactPublicLinks.id }).from(artifactPublicLinks).where(eq(artifactPublicLinks.artifactId, content.artifactId)),
  ]);
  return {
    artifacts: artifactRows.length,
    revisions: revisionRows.length,
    comments: commentRows.length,
    grants: grantRows.length,
    links: linkRows.length,
  };
}

function artifactRequest(artifactId: string, cookie: string): Promise<Response> {
  return adminRequest(target(), `/api/artifacts/${artifactId}`, { headers: { cookie } });
}

function publicLink(path: string): Promise<Response> {
  return adminRequest(target(), path);
}

function signIn(email: string, password: string): Promise<Response> {
  return adminRequest(target(), SIGN_IN_PATH, {
    method: "POST",
    headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function preview(path: string, token: string): Promise<Response> {
  return adminRequest(target(), path, {
    method: "POST",
    headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("the command refuses a missing argument, an unknown flag and a malformed address", async () => {
  const usage = purge([]);
  assertRefusal(usage, /usage: bun run user:purge/);

  const unknownFlag = purge([`someone-${randomUUID()}@example.test`, "--delete-all"]);
  assertRefusal(unknownFlag, /usage: bun run user:purge/);

  const malformed = purge(["not-an-address", "--delete-content"]);
  assertRefusal(malformed, /not a valid email address/i);
});

integration("the help text names both content choices and the non-interactive flag", async () => {
  const help = purge(["--help"]);

  assert.equal(help.status, 0, "asking for help succeeds");
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /usage: bun run user:purge EMAIL \(--reassign-to EMAIL \| --delete-content\) \[--yes\]/);
  assert.equal(help.stdout.includes("--reassign-to"), true);
  assert.equal(help.stdout.includes("--delete-content"), true);
  assert.equal(help.stdout.includes("--yes"), true);
});

integration("the command refuses neither and both content choices", async () => {
  const victim = await seedTrustedAccount(target().database, { name: "No Choice Victim" });

  const neither = purge([victim.email, "--yes"]);
  assertRefusal(neither, /choose exactly one content choice/i);
  assert.equal(neither.stderr.includes("--reassign-to"), true, "the refusal names the reassignment flag");
  assert.equal(neither.stderr.includes("--delete-content"), true, "the refusal names the deletion flag");

  const both = purge([victim.email, "--reassign-to", victim.email, "--delete-content", "--yes"]);
  assertRefusal(both, /cannot be combined/i);

  assert.equal(await accountExists(victim.userId), true, "neither refusal purges the account");
});

integration("the command refuses an unknown address, an unknown target and the account itself", async () => {
  const victim = await seedTrustedAccount(target().database, { name: "Target Choice Victim" });
  const content = await seedOwnedContent(victim.userId, (await seedTrustedAccount(target().database, { name: "Target Reader" })).userId, "Kept");

  const unknownAddress = `unknown-${randomUUID()}@example.test`;
  const missingAccount = purge([unknownAddress, "--delete-content", "--yes"]);
  assertRefusal(missingAccount, /no account exists for that address/i);

  const unknownTarget = `missing-target-${randomUUID()}@example.test`;
  const missingTarget = purge([victim.email, "--reassign-to", unknownTarget, "--yes"]);
  assertRefusal(missingTarget, /no account exists for the reassignment target/i);
  assert.equal(missingTarget.stderr.includes(unknownTarget), false, "the refusal names no address");

  const itself = purge([victim.email, "--reassign-to", victim.email, "--yes"]);
  assertRefusal(itself, /same account/i);

  assert.equal(await accountExists(victim.userId), true, "no refusal purges the account");
  assert.deepEqual(await contentCounts(content), { artifacts: 1, revisions: 1, comments: 2, grants: 1, links: 1 });
});

integration("the command refuses without a confirmation and changes nothing", async () => {
  const victim = await seedTrustedAccount(target().database, { name: "Unconfirmed Victim" });
  const reader = await seedTrustedAccount(target().database, { name: "Unconfirmed Reader" });
  const content = await seedOwnedContent(victim.userId, reader.userId, "Untouched");

  const silent = purge([victim.email, "--delete-content"]);
  assertRefusal(silent, /not confirmed/i);
  assert.equal(silent.stderr.includes("--yes"), true, "the refusal names the non-interactive flag");

  const wrong = purge([victim.email, "--delete-content"], `someone-else-${randomUUID()}@example.test\n`);
  assertRefusal(wrong, /not confirmed/i);

  assert.equal(await accountExists(victim.userId), true, "an unconfirmed purge removes no account");
  assert.deepEqual(await contentCounts(content), { artifacts: 1, revisions: 1, comments: 2, grants: 1, links: 1 });
});

integration("a confirmation that repeats the address purges the account and records one line", async () => {
  const victim = await seedTrustedAccount(target().database, { name: "Confirmed Victim" });

  const result = purge([victim.email, "--delete-content"], `${victim.email}\n`);

  assert.equal(result.status, 0, `the confirmed purge succeeds: ${result.stderr}`);
  assert.equal(await accountExists(victim.userId), false, "the account row is gone");
  const event = singleLineOf(result);
  assert.equal(event.event, "user.purged");
  assert.equal(event.actorId, "console");
  assert.equal(event.actorRole, "console");
  assert.equal(event.subjectId, victim.userId);
  assert.equal(event.outcome, "applied");
});

integration("the reassign choice moves the owned content and the reader keeps opening it", async () => {
  const owner = await trustedSession(fixtureOf(), { name: "Reassign Owner" });
  const reader = await trustedSession(fixtureOf(), { name: "Reassign Reader" });
  const operator = await seedTrustedAccount(target().database, { name: "Reassign Target" });
  const owned = await seedOwnedContent(owner.userId, reader.userId, "Reassigned artifact");
  const foreign = await seedOwnedContent(reader.userId, owner.userId, "Artifact of the reader");
  await seedIssuedCredentials(owner.userId);
  const pendingInvitation = await seedPendingInvitation(owner.email, reader.userId);
  const resetToken = resetTokenOf(owner.email);
  const sessionCount = (
    await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, owner.userId))
  ).length;
  assert.equal(sessionCount > 0, true, "the owner holds a live session");

  assert.equal((await artifactRequest(owned.artifactId, reader.cookie)).status, 200, "the reader reads it before");
  assert.equal((await publicLink(`/share/${owned.linkToken}?meta=1`)).status, 200, "the public link resolves before");

  const result = purge([owner.email, "--reassign-to", operator.email, "--yes"]);

  assert.equal(result.status, 0, `the reassignment succeeds: ${result.stderr}`);
  const event = singleLineOf(result);
  assert.equal(event.event, "user.purged");
  assert.equal(event.actorRole, "console");
  assert.equal(event.subjectId, owner.userId);
  assert.equal(event.outcome, "applied");

  assert.equal(await accountExists(owner.userId), false, "the account row is gone");
  await assertNoDanglingReferences(owner.userId);

  const movedArtifact = await target().database.db
    .select({ ownerId: artifacts.ownerId })
    .from(artifacts)
    .where(eq(artifacts.id, owned.artifactId));
  assert.equal(movedArtifact[0]?.ownerId, operator.userId, "the artifact changes owner");

  const movedComment = await target().database.db
    .select({ authorId: artifactComments.authorId })
    .from(artifactComments)
    .where(eq(artifactComments.id, owned.ownerCommentId));
  assert.equal(movedComment[0]?.authorId, operator.userId, "the owner's comment changes author");

  const movedGrant = await target().database.db
    .select({ grantedByUserId: artifactShares.grantedByUserId })
    .from(artifactShares)
    .where(eq(artifactShares.artifactId, owned.artifactId));
  assert.equal(movedGrant[0]?.grantedByUserId, operator.userId, "the grant changes issuer so the reader keeps access");

  const detail = await artifactRequest(owned.artifactId, reader.cookie);
  assert.equal(detail.status, 200, "the person it was shared with still opens the reassigned artifact");
  assert.equal(((await detail.json()) as { id: string }).id, owned.artifactId);
  const shared = await adminRequest(target(), "/api/artifacts/shared", { headers: { cookie: reader.cookie } });
  assert.equal(shared.status, 200, "the shared library still answers");
  const listed = (await shared.json()) as { artifacts: { id: string }[] };
  assert.equal(
    listed.artifacts.some((row) => row.id === owned.artifactId),
    true,
    "the reassigned artifact stays in the reader's shared library",
  );
  assert.equal((await publicLink(`/share/${owned.linkToken}?meta=1`)).status, 200, "the public link keeps resolving");
  assert.deepEqual(
    await contentCounts(foreign),
    { artifacts: 1, revisions: 1, comments: 2, grants: 0, links: 1 },
    "another person's artifact keeps its rows; only the share grant the purged account held goes",
  );

  assert.equal((await preview(RESET_PREVIEW_PATH, resetToken)).status, 400, "the pending reset link is gone");
  assert.equal((await preview(REGISTRATION_PREVIEW_PATH, pendingInvitation)).status, 400, "the pending invitation is gone");
  assert.equal((await signIn(owner.email, owner.password)).status, 401, "the purged account cannot sign in");
  assert.equal((await adminRequest(target(), "/api/artifacts", { headers: { cookie: owner.cookie } })).status, 401);
});

integration("the delete choice removes the content and nothing of it survives", async () => {
  const owner = await trustedSession(fixtureOf(), { name: "Delete Owner" });
  const reader = await trustedSession(fixtureOf(), { name: "Delete Reader" });
  const own = await seedOwnedContent(owner.userId, reader.userId, "Deleted artifact");
  const bystander = await seedOwnedContent(reader.userId, owner.userId, "Bystander artifact");
  await seedIssuedCredentials(owner.userId);
  const row = await target().database.db.select({ id: account.id }).from(account).where(eq(account.userId, owner.userId));
  await target().database.db.insert(account).values({
    id: randomUUID(),
    userId: owner.userId,
    providerId: "github",
    accountId: `gh-${randomUUID()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(row.length > 0, true, "the owner holds an identity row");

  assert.equal((await artifactRequest(own.artifactId, reader.cookie)).status, 200, "the reader reads it before");

  const result = purge([owner.email, "--delete-content", "--yes"]);

  assert.equal(result.status, 0, `the deletion succeeds: ${result.stderr}`);
  assert.equal(singleLineOf(result).event, "user.purged");
  assert.equal(await accountExists(owner.userId), false, "the account row is gone");
  await assertNoDanglingReferences(owner.userId);
  assert.deepEqual(await contentCounts(own), { artifacts: 0, revisions: 0, comments: 0, grants: 0, links: 0 });
  const storageKeys = await target()
    .database.pool.query<{ count: string }>(`select count(*)::text as count from "artifactRevisions" where "storageKey" = $1`, [
      own.storageKey,
    ]);
  assert.equal(storageKeys.rows[0]?.count, "0", "no revision row names the deleted bytes");

  assert.equal((await artifactRequest(own.artifactId, reader.cookie)).status, 404, "the deleted artifact is gone");
  assert.equal((await publicLink(`/share/${own.linkToken}?meta=1`)).status, 404, "the public link of the deleted artifact is gone");
  assert.deepEqual(
    await contentCounts(bystander),
    { artifacts: 1, revisions: 1, comments: 1, grants: 0, links: 1 },
    "another person's artifact keeps its rows; the purged account's own comment and grants go with it",
  );
  assert.equal(
    (await artifactRequest(bystander.artifactId, reader.cookie)).status,
    200,
    "the reader still opens their own artifact",
  );
});

integration("the purge is never reachable from the administration interface", async () => {
  const administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Purge Administrator" });
  const victim = await seedTrustedAccount(target().database, { name: "Interface Victim" });

  for (const path of [`/api/admin/users/${victim.userId}/purge`, `/api/admin/users/${victim.userId}/delete`]) {
    const response = await adminRequest(target(), path, {
      method: "POST",
      headers: { cookie: administrator.cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404, `${path} is not a route`);
  }

  const removed = await adminRequest(target(), `/api/admin/users/${victim.userId}`, {
    method: "DELETE",
    headers: { cookie: administrator.cookie, origin: target().config.publicOrigin },
  });
  assert.equal(removed.status, 404, "no administration route deletes an account");

  assert.equal(await accountExists(victim.userId), true, "no interface call purges the account");
});

integration("the purge refuses a malformed reassignment target before touching the database", async () => {
  const victim = await seedTrustedAccount(target().database, { name: "Malformed Target Victim" });

  const result = purge([victim.email, "--reassign-to", "not-an-address", "--yes"]);

  assertRefusal(result, /not a valid email address/i);
  assert.equal(await accountExists(victim.userId), true, "the account survives a malformed target");
});

integration("an unknown reassignment target leaves every identity and token of the account in place", async () => {
  const owner = await seedTrustedAccount(target().database, { name: "Untouched Owner" });
  await seedIssuedCredentials(owner.userId);

  const refused = purge([owner.email, "--reassign-to", `missing-${randomUUID()}@example.test`, "--yes"]);
  assertRefusal(refused, /reassignment target/i);

  const counts = await referenceCounts(owner.userId);
  const populated = counts.filter((entry) => entry.rows > 0).map((entry) => `${entry.table}.${entry.column}`);
  assert.deepEqual(populated, [
    "account.userId",
    "oauthAccessToken.userId",
    "oauthRefreshToken.userId",
    "oauthConsent.userId",
    "oauthClient.userId",
  ]);
  assert.equal(await accountExists(owner.userId), true, "the refused purge removes no account");
});
