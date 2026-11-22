import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { registrationInvite } from "../apps/api/src/adapters/postgres/db/invite-schema.ts";
import { passwordResetToken } from "../apps/api/src/adapters/postgres/db/password-reset-schema.ts";
import { user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  assertStatus,
  adminGet,
  adminPost,
  adminRequest,
  publicPost,
  startAdminHarness,
  type AdminHarness,
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

const INVITATIONS_PATH = "/api/admin/invitations";
const RESET_LINKS_PATH = "/api/admin/reset-links";
const PREVIEW_PATH = "/api/auth/registration/preview";
const COMPLETE_PATH = "/api/auth/registration/complete";
const RESET_PREVIEW_PATH = "/api/auth/password-reset/preview";
const RESET_COMPLETE_PATH = "/api/auth/password-reset/complete";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const TOKEN_MARKER = "#token=";
const DAY_MS = 86_400_000;

type InvitationView = {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
  issuedBy: { id: string; name: string; email: string } | null;
};
type CreateAnswer = { invitation: InvitationView; link: string; reactivated: boolean };
type ListAnswer = { invitations: InvitationView[] };
type Credential = { name: string; password: string };

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function actor(): TrustedSession {
  assert.ok(administrator, "the administrator exists");
  return administrator;
}

function credential(name = "Invited Person"): Credential {
  return { name, password: `Invited-Password-${randomUUID()}` };
}

function tokenOf(link: string): string {
  const marker = link.indexOf(TOKEN_MARKER);
  assert.equal(marker >= 0, true, "the answered link carries a token fragment");
  return link.slice(marker + TOKEN_MARKER.length);
}

function createInvitation(email: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), INVITATIONS_PATH, { email }, cookie);
}

function revoke(invitationId: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), `${INVITATIONS_PATH}/${invitationId}/revoke`, {}, cookie);
}

function regenerate(invitationId: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), `${INVITATIONS_PATH}/${invitationId}/regenerate`, {}, cookie);
}

function issueResetLink(email: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), RESET_LINKS_PATH, { email }, cookie);
}

function listInvitations(): Promise<Response> {
  return adminGet(target(), INVITATIONS_PATH, actor().cookie);
}

function previewInvitation(token: string): Promise<Response> {
  return publicPost(target(), PREVIEW_PATH, { token });
}

function completeRegistration(token: string, credentials: Credential): Promise<Response> {
  return publicPost(target(), COMPLETE_PATH, { token, ...credentials });
}

function completeReset(token: string, newPassword: string): Promise<Response> {
  return publicPost(target(), RESET_COMPLETE_PATH, { token, newPassword });
}

function signIn(email: string, password: string): Promise<Response> {
  return publicPost(target(), SIGN_IN_PATH, { email, password });
}

async function createdInvitation(email: string): Promise<CreateAnswer> {
  const response = await createInvitation(email);
  assertStatus(response, 200, `inviting ${email} is applied`);
  return (await response.json()) as CreateAnswer;
}

async function inviteRows(email: string): Promise<{ id: string; tokenHash: string; createdBy: string | null }[]> {
  return await target()
    .database.db.select({
      id: registrationInvite.id,
      tokenHash: registrationInvite.tokenHash,
      createdBy: registrationInvite.createdBy,
    })
    .from(registrationInvite)
    .where(eq(registrationInvite.email, email));
}

async function resetRows(userId: string): Promise<{ id: string; createdBy: string | null }[]> {
  return await target()
    .database.db.select({ id: passwordResetToken.id, createdBy: passwordResetToken.createdBy })
    .from(passwordResetToken)
    .where(eq(passwordResetToken.userId, userId));
}

async function accountsFor(email: string): Promise<{ id: string; status: string; deactivatedBy: string | null }[]> {
  return await target()
    .database.db.select({ id: user.id, status: user.status, deactivatedBy: user.deactivatedBy })
    .from(user)
    .where(sql`lower(btrim(${user.email})) = ${email}`);
}

async function expireInvitation(email: string): Promise<void> {
  await target().database.pool.query(
    `UPDATE "registrationInvite" SET "expiresAt" = now() - interval '1 minute'
     WHERE "email" = $1 AND "consumedAt" IS NULL`,
    [email],
  );
}

async function setStatus(userId: string, status: "active" | "deactivated"): Promise<Response> {
  return adminPost(target(), `/api/admin/users/${userId}/status`, { status }, actor().cookie);
}

async function withAuditCapture<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = written
      .flatMap((chunk) => chunk.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

function eventsNamed(lines: Record<string, unknown>[], name: string): Record<string, unknown>[] {
  return lines.filter((line) => line.event === name);
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Invitation Administrator" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member is refused on every invitation and reset endpoint and nothing is created", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Invitation Member" });
  const email = `member-${randomUUID()}@example.test`;

  const captured = await withAuditCapture(async () => {
    const answers: Response[] = [
      await createInvitation(email, member.cookie),
      await adminGet(target(), INVITATIONS_PATH, member.cookie),
      await revoke(randomUUID(), member.cookie),
      await regenerate(randomUUID(), member.cookie),
      await issueResetLink(member.email, member.cookie),
    ];
    return answers;
  });
  for (const answer of captured.result) {
    assertStatus(answer, 403, "managing invitations is an administration action");
    assert.deepEqual(await answer.json(), { error: "administrator_required" });
  }
  assert.deepEqual(captured.lines, [], "a refused operation records nothing");
  assert.deepEqual(await inviteRows(email), [], "a refused operation creates no invitation");
  assert.deepEqual(await resetRows(member.userId), [], "a refused operation creates no reset token");

  const anonymous = await adminRequest(target(), INVITATIONS_PATH, { method: "GET" });
  assertStatus(anonymous, 401, "an anonymous read is refused");
  assert.deepEqual(await anonymous.json(), { error: "sign_in_required" });
});

integration(
  "creating an invitation answers the link once and the pending list names its author and expiry",
  async () => {
    const email = `created-${randomUUID()}@Example.TEST`;
    const canonical = email.trim().toLowerCase();
    const before = Date.now();
    const captured = await withAuditCapture(() => createInvitation(email));
    assertStatus(captured.result, 200, "the administrator creates an invitation");
    const answer = (await captured.result.json()) as CreateAnswer;

    assert.equal(answer.reactivated, false, "a fresh address is not an account to reactivate");
    assert.equal(answer.invitation.email, canonical);
    assert.deepEqual(answer.invitation.issuedBy, {
      id: actor().userId,
      name: actor().name,
      email: actor().email,
    });
    const expiresAt = Date.parse(answer.invitation.expiresAt);
    assert.equal(
      expiresAt >= before + DAY_MS - 60_000 && expiresAt <= Date.now() + DAY_MS + 60_000,
      true,
      "the invitation expires in 24 hours",
    );

    const token = tokenOf(answer.link);
    assert.equal(answer.link.startsWith(harness?.config.publicOrigin ?? ""), true, "the link uses the public origin");
    assertStatus(await previewInvitation(token), 200, "the answered link works");

    const rows = await inviteRows(canonical);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tokenHash, createHash("sha256").update(token).digest("hex"), "only the hash is stored");
    assert.notEqual(rows[0]?.tokenHash, token, "the clear token is never stored");
    assert.equal(rows[0]?.createdBy, actor().userId, "the invitation records who issued it");

    const listed = await listInvitations();
    assertStatus(listed, 200, "the pending list is readable");
    const text = await listed.text();
    assert.equal(text.includes(token), false, "the pending list never returns the link");
    assert.equal(text.includes(rows[0]?.tokenHash ?? ""), false, "the pending list never returns the hash");
    const page = JSON.parse(text) as ListAnswer;
    const pending = page.invitations.find((row) => row.id === answer.invitation.id);
    assert.ok(pending, "the pending list carries the created invitation");
    assert.deepEqual(pending.issuedBy, answer.invitation.issuedBy);
    assert.deepEqual(Object.keys(pending).sort(), ["createdAt", "email", "expiresAt", "id", "issuedBy"]);
    assert.equal(pending.expiresAt, answer.invitation.expiresAt);

    const events = eventsNamed(captured.lines, "invitation.created");
    assert.equal(events.length, 1, "one applied creation records exactly one event");
    assert.equal(events[0]?.actorId, actor().userId);
    assert.equal(events[0]?.actorRole, "administrator");
    assert.equal(events[0]?.subjectId, answer.invitation.id);
    assert.equal(JSON.stringify(events[0]).includes(token), false, "no link reaches the event line");
  },
);

integration("opening the link does not consume it while completing the registration does, once", async () => {
  const email = `opened-${randomUUID()}@example.test`;
  const { link } = await createdInvitation(email);
  const token = tokenOf(link);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const preview = await previewInvitation(token);
    assertStatus(preview, 200, "opening the link does not spend it");
    assert.deepEqual(await preview.json(), { email });
  }

  const credentials = credential();
  const completed = await completeRegistration(token, credentials);
  assertStatus(completed, 200, "completing the registration spends the link");
  assert.deepEqual(await completed.json(), { ok: true });

  const repeated = await completeRegistration(token, credential("Second Attempt"));
  assertStatus(repeated, 400, "a consumed invitation is refused");
  assertStatus(await previewInvitation(token), 400, "a consumed invitation no longer previews");

  assert.equal((await accountsFor(email)).length, 1, "the address holds exactly one account");
  const signedIn = await signIn(email, credentials.password);
  assertStatus(signedIn, 200, "the invited person signs in with the password they chose");
});

integration("two concurrent completions of one invitation create one account", async () => {
  const email = `concurrent-${randomUUID()}@example.test`;
  const { link } = await createdInvitation(email);
  const token = tokenOf(link);
  const first = credential("First Racer");
  const second = credential("Second Racer");

  const [a, b] = await Promise.all([completeRegistration(token, first), completeRegistration(token, second)]);
  assert.deepEqual(
    [a.status, b.status].sort((x, y) => x - y),
    [200, 400],
    "exactly one concurrent completion succeeds",
  );

  assert.equal((await accountsFor(email)).length, 1, "two concurrent completions create exactly one account");
  const winner = a.status === 200 ? first : second;
  const loser = a.status === 200 ? second : first;
  assertStatus(await signIn(email, winner.password), 200, "the winning password signs in");
  assert.equal((await signIn(email, loser.password)).status >= 400, true, "the losing password never signs in");
});

integration(
  "a revoked, a regenerated-old, an expired and a consumed invitation refuse with their own reason",
  async () => {
    const revokedEmail = `revoked-${randomUUID()}@example.test`;
    const revoked = await createdInvitation(revokedEmail);
    const revokedToken = tokenOf(revoked.link);

    const captured = await withAuditCapture(() => revoke(revoked.invitation.id));
    assertStatus(captured.result, 200, "revoking a pending invitation is applied");
    const revokedAnswer = (await captured.result.json()) as { invitation: { id: string; revokedAt: string } };
    assert.equal(revokedAnswer.invitation.id, revoked.invitation.id);
    assert.equal(
      Number.isNaN(Date.parse(revokedAnswer.invitation.revokedAt)),
      false,
      "the answer names when it stopped",
    );
    const events = eventsNamed(captured.lines, "invitation.revoked");
    assert.equal(events.length, 1, "one applied revocation records exactly one event");
    assert.equal(events[0]?.subjectId, revoked.invitation.id);
    assert.equal(events[0]?.actorId, actor().userId);
    assertStatus(await previewInvitation(revokedToken), 400, "a revoked link no longer previews");
    assertStatus(await completeRegistration(revokedToken, credential()), 400, "a revoked link never completes");

    const repeated = await revoke(revoked.invitation.id);
    assertStatus(repeated, 409, "revoking a revoked invitation is refused");
    assert.deepEqual(await repeated.json(), { error: "invitation_revoked" });
    const regrown = await regenerate(revoked.invitation.id);
    assertStatus(regrown, 409, "regenerating a revoked invitation is refused");
    assert.deepEqual(await regrown.json(), { error: "invitation_revoked" });

    const regeneratedEmail = `regenerated-${randomUUID()}@example.test`;
    const original = await createdInvitation(regeneratedEmail);
    const originalToken = tokenOf(original.link);
    const regenerated = await regenerate(original.invitation.id);
    assertStatus(regenerated, 200, "regenerating a pending invitation is applied");
    const replacement = (await regenerated.json()) as CreateAnswer;
    assert.notEqual(replacement.invitation.id, original.invitation.id, "a regenerated invitation is a new row");
    assert.equal(replacement.invitation.email, original.invitation.email);
    const replacementToken = tokenOf(replacement.link);
    assertStatus(await previewInvitation(originalToken), 400, "the previous link stops working immediately");
    assertStatus(await completeRegistration(originalToken, credential()), 400, "the previous link never completes");
    assertStatus(await previewInvitation(replacementToken), 200, "the replacement link works");
    const staleRevoke = await revoke(original.invitation.id);
    assertStatus(staleRevoke, 409, "the previous invitation is revoked");
    assert.deepEqual(await staleRevoke.json(), { error: "invitation_revoked" });

    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expired = await createdInvitation(expiredEmail);
    await expireInvitation(expiredEmail);
    const expiredToken = tokenOf(expired.link);
    assertStatus(await previewInvitation(expiredToken), 400, "an expired link no longer previews");
    assertStatus(await completeRegistration(expiredToken, credential()), 400, "an expired link never completes");
    const expiredRevoke = await revoke(expired.invitation.id);
    assertStatus(expiredRevoke, 409, "revoking an expired invitation is refused");
    assert.deepEqual(await expiredRevoke.json(), { error: "invitation_expired" });
    const expiredRegenerate = await regenerate(expired.invitation.id);
    assertStatus(expiredRegenerate, 409, "regenerating an expired invitation is refused");
    assert.deepEqual(await expiredRegenerate.json(), { error: "invitation_expired" });

    const consumedEmail = `consumed-${randomUUID()}@example.test`;
    const consumed = await createdInvitation(consumedEmail);
    assertStatus(
      await completeRegistration(tokenOf(consumed.link), credential()),
      200,
      "the invitation completes once",
    );
    const storedRows = await inviteRows(consumedEmail);
    const consumedRevoke = await revoke(consumed.invitation.id);
    assertStatus(consumedRevoke, 409, "revoking a consumed invitation is refused");
    assert.deepEqual(await consumedRevoke.json(), { error: "invitation_consumed" });
    const consumedRegenerate = await regenerate(consumed.invitation.id);
    assertStatus(consumedRegenerate, 409, "regenerating a consumed invitation is refused");
    assert.deepEqual(await consumedRegenerate.json(), { error: "invitation_consumed" });

    const unknown = randomUUID();
    const captured2 = await withAuditCapture(async () => [await revoke(unknown), await regenerate(unknown)]);
    for (const answer of captured2.result) {
      assertStatus(answer, 404, "an unknown invitation is not found");
      assert.deepEqual(await answer.json(), { error: "invitation_not_found" });
    }
    assert.deepEqual(captured2.lines, [], "a refused change records nothing");
    assert.deepEqual(await inviteRows(consumedEmail), storedRows, "refusals never create a row");
    assert.equal((await inviteRows(regeneratedEmail)).length, 2, "regeneration writes exactly one new row");
  },
);

integration("a refused creation records nothing and leaves the stored rows untouched", async () => {
  const existing = await trustedSession(fixtureOf(), { name: "Existing Account" });
  const captured = await withAuditCapture(async () => ({
    activeAccount: await createInvitation(existing.email),
    malformed: await createInvitation("not-an-address"),
  }));
  assertStatus(captured.result.activeAccount, 409, "an address with an active account is refused");
  assert.deepEqual(await captured.result.activeAccount.json(), { error: "email_in_use" });
  assertStatus(captured.result.malformed, 400, "a malformed address is refused");
  assert.deepEqual(await captured.result.malformed.json(), { error: "invalid_email" });
  assert.deepEqual(captured.lines, [], "a refused creation records nothing");
  assert.deepEqual(await inviteRows(existing.email), [], "a refused creation stores no invitation");
  assert.deepEqual(await inviteRows("not-an-address"), []);
});

integration("inviting a deactivated account reactivates it without creating another account", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Deactivated Invitee" });
  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");
  const before = await accountsFor(victim.email);
  assert.equal(before.length, 1);
  assert.equal(before[0]?.status, "deactivated");

  const captured = await withAuditCapture(() => createInvitation(victim.email));
  assertStatus(captured.result, 200, "inviting a deactivated account is applied");
  const answer = (await captured.result.json()) as CreateAnswer;
  assert.equal(answer.reactivated, true, "the response says the account was reactivated");
  assert.equal(eventsNamed(captured.lines, "invitation.created").length, 1, "the invitation records one event");

  const after = await accountsFor(victim.email);
  assert.equal(after.length, 1, "no second account is created for the same address");
  assert.equal(after[0]?.id, victim.userId, "the invitation is issued on the same account");
  assert.equal(after[0]?.status, "active", "the account is reactivated");
  assert.equal(after[0]?.deactivatedBy, null, "the reactivation clears who deactivated it");

  const replacement = credential("Reactivated Person");
  assertStatus(
    await completeRegistration(tokenOf(answer.link), replacement),
    200,
    "the link completes on that account",
  );
  assert.equal((await accountsFor(victim.email)).length, 1, "completing never creates a second account");
  assertStatus(await signIn(victim.email, replacement.password), 200, "the reactivated person signs in");
  assert.equal(
    (await signIn(victim.email, victim.password)).status >= 400,
    true,
    "the previous password stopped working",
  );
});

integration(
  "a reset link for an existing account works once and refuses for an unknown or deactivated account",
  async () => {
    const owner = await trustedSession(fixtureOf(), { name: "Reset Owner" });
    const captured = await withAuditCapture(() => issueResetLink(owner.email));
    assertStatus(captured.result, 200, "the administrator issues a reset link");
    const issued = (await captured.result.json()) as { link: string; expiresAt: string };
    const token = tokenOf(issued.link);
    assert.equal(issued.expiresAt.length > 0, true, "the answer names when the link expires");
    assert.equal(eventsNamed(captured.lines, "password.reset.issued").length, 1, "one issuance records one event");
    assert.equal(eventsNamed(captured.lines, "password.reset.issued")[0]?.subjectId, owner.userId);
    assert.equal(JSON.stringify(captured.lines).includes(token), false, "no link reaches the event line");

    const stored = await resetRows(owner.userId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.createdBy, actor().userId, "the reset link records who issued it");

    assertStatus(await publicPost(target(), RESET_PREVIEW_PATH, { token }), 200, "the issued link works");
    const newPassword = `Reset-Password-${randomUUID()}`;
    assertStatus(await completeReset(token, newPassword), 200, "the reset completes once");
    assertStatus(await completeReset(token, `Again-Password-${randomUUID()}`), 400, "the consumed link is refused");
    assertStatus(await signIn(owner.email, newPassword), 200, "the new password signs in");
    assert.equal(
      (await signIn(owner.email, owner.password)).status >= 400,
      true,
      "the previous password stopped working",
    );

    const unknown = await issueResetLink(`unknown-${randomUUID()}@example.test`);
    assertStatus(unknown, 404, "an unknown account is refused");
    assert.deepEqual(await unknown.json(), { error: "user_not_found" });

    const victim = await trustedSession(fixtureOf(), { name: "Deactivated Reset Owner" });
    assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");
    const deactivated = await issueResetLink(victim.email);
    assertStatus(deactivated, 409, "a deactivated account is refused");
    assert.deepEqual(await deactivated.json(), { error: "account_deactivated" });
    assert.deepEqual(await resetRows(victim.userId), [], "a refused issuance stores no token");

    const malformed = await issueResetLink("not-an-address");
    assertStatus(malformed, 400, "a malformed address is refused");
    assert.deepEqual(await malformed.json(), { error: "invalid_email" });
  },
);

integration("the console commands still produce a working link", async () => {
  const invitedEmail = `command-${randomUUID()}@example.test`;
  const issuedInvitation = target().command("user:invite", [invitedEmail]);
  assert.equal(issuedInvitation.status, 0, `user:invite succeeds: ${issuedInvitation.stderr}`);
  const invitationToken = tokenOf(issuedInvitation.stdout.trim());

  const listed = (await (await listInvitations()).json()) as ListAnswer;
  const pending = listed.invitations.find((row) => row.email === invitedEmail);
  assert.ok(pending, "an invitation issued by the console is pending");
  assert.equal(pending.issuedBy, null, "an invitation without an issuing account stays unattributed");

  const invitedCredential = credential("Command Invitee");
  assertStatus(
    await completeRegistration(invitationToken, invitedCredential),
    200,
    "a link issued by the console completes",
  );
  assertStatus(
    await signIn(invitedEmail, invitedCredential.password),
    200,
    "the console invitation creates a usable account",
  );

  const owner: TrustedAccount = await seedTrustedAccount(target().database, { name: "Command Reset Owner" });
  const issuedReset = target().command("user:reset-password", [owner.email]);
  assert.equal(issuedReset.status, 0, `user:reset-password succeeds: ${issuedReset.stderr}`);
  const resetToken = tokenOf(issuedReset.stdout.trim());
  const resetPassword = `Console-Password-${randomUUID()}`;
  assertStatus(await completeReset(resetToken, resetPassword), 200, "a link issued by the console completes the reset");
  assertStatus(await signIn(owner.email, resetPassword), 200, "the console reset link works");
});
