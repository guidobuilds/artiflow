import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { loadConfig } from "../apps/api/src/config.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import {
  COMPLETE_PATH,
  invitationCredential,
  invitePost,
  startInvitationHarness,
  type InvitationHarness,
} from "./helpers/registration-invites.ts";
import { completeSocialSignIn, seedSocialIdentity, type SocialFixture } from "./helpers/social-sign-in.ts";

const TEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const integration = (name: string, run: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, run);

const GITHUB_CLIENT_ID = `github-client-id-${randomUUID()}`;
const GITHUB_CLIENT_SECRET = `github-client-secret-${randomUUID()}`;
const SESSION_PATH = "/api/auth/get-session";

type InvitedAccount = { userId: string; email: string };

let harness: InvitationHarness | null = null;

function target(): InvitationHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixture(): SocialFixture {
  return { database: target().database, baseUrl: target().baseUrl, origin: target().config.publicOrigin };
}

function providerAccountId(): string {
  return `gh-${randomUUID()}`;
}

function refusalCode(location: string): string | null {
  try {
    return new URL(location).searchParams.get("error");
  } catch {
    return null;
  }
}

async function invitedAccount(): Promise<InvitedAccount> {
  const invitation = target().issue(`invited-${randomUUID()}@example.test`);
  const credential = invitationCredential();
  const completed = await invitePost(target(), COMPLETE_PATH, {
    token: invitation.token,
    name: credential.name,
    password: credential.password,
  });
  assert.equal(completed.status, 200, `the invitation completes: ${completed.status}`);
  const rows = await target()
    .database.db.select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, invitation.email));
  assert.equal(rows.length, 1, "the invitation created one account");
  const created = rows[0];
  assert.ok(created, "the account row exists");
  assert.equal(created.emailVerified, false, "an invited account is stored unverified");
  return { userId: created.id, email: invitation.email };
}

async function identitiesOf(userId: string): Promise<string[]> {
  const rows = await target()
    .database.db.select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId));
  return rows.map((row) => row.providerId).sort();
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return rows.length;
}

async function sessionOwner(cookie: string): Promise<string | null> {
  const response = await fetch(`${target().baseUrl}${SESSION_PATH}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(response.status, 200, "the session read answers");
  const payload = (await response.json()) as { user?: { id?: string } } | null;
  return payload?.user?.id ?? null;
}

before(async () => {
  const base = loadConfig(process.env);
  harness = await startInvitationHarness({
    nodeEnv: base.nodeEnv,
    demoAuth: base.demoAuth,
    authSecret: base.authSecret,
    publicOrigin: base.publicOrigin,
    authProviders: { github: { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } },
    secretEncryptionKey: base.secretEncryptionKey ?? null,
  });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("an invited account links a provider identity with a verified claim and signs in", async () => {
  const invited = await invitedAccount();
  const identity = { userId: invited.userId, email: invited.email, providerAccountId: providerAccountId() };

  const outcome = await completeSocialSignIn(fixture(), identity);

  assert.equal(refusalCode(outcome.location), null, `the sign-in is not refused: ${outcome.location}`);
  assert.equal(outcome.location, "/dashboard", "the callback returns to the requested page");
  assert.equal(outcome.cookie.length > 0, true, "the linked identity receives a usable session");
  assert.equal(await sessionOwner(outcome.cookie), invited.userId, "the session belongs to the invited account");
  assert.deepEqual(await identitiesOf(invited.userId), ["credential", "github"], "the provider identity is linked");
  assert.equal(await sessionCount(invited.userId), 1, "one session is stored");
});

integration("a provider asserting an unverified claim is refused", async () => {
  const invited = await invitedAccount();
  const identity = { userId: invited.userId, email: invited.email, providerAccountId: providerAccountId() };

  const outcome = await completeSocialSignIn(fixture(), identity, { emailVerified: false });

  assert.equal(refusalCode(outcome.location), "account_not_linked", "the unverified claim is refused");
  assert.equal(outcome.cookie, "", "no session is issued");
  assert.deepEqual(await identitiesOf(invited.userId), ["credential"], "no identity row is written");
  assert.equal(await sessionCount(invited.userId), 0, "no session is stored");
});

integration("an identity already bound to another account never links to the invited account", async () => {
  const invited = await invitedAccount();
  const other = await seedSocialIdentity(target().database, { role: "member", name: "Other Owner" });

  const outcome = await completeSocialSignIn(fixture(), {
    userId: other.userId,
    email: invited.email,
    providerAccountId: other.providerAccountId,
  });

  assert.deepEqual(
    await identitiesOf(invited.userId),
    ["credential"],
    "no identity row is written for the invited account",
  );
  assert.equal(await sessionCount(invited.userId), 0, "the invited account receives no session");
  assert.equal(await sessionOwner(outcome.cookie), other.userId, "the identity opens only the account it is bound to");
  assert.deepEqual(await identitiesOf(other.userId), ["github"], "the identity stays bound where it was");
});

integration("a second sign-in reuses the link instead of creating anything", async () => {
  const invited = await invitedAccount();
  const identity = { userId: invited.userId, email: invited.email, providerAccountId: providerAccountId() };

  const first = await completeSocialSignIn(fixture(), identity);
  assert.equal(refusalCode(first.location), null, `the first sign-in is admitted: ${first.location}`);
  const linksAfterFirst = await identitiesOf(invited.userId);

  const second = await completeSocialSignIn(fixture(), identity);

  assert.equal(refusalCode(second.location), null, `the second sign-in is admitted: ${second.location}`);
  assert.equal(await sessionOwner(second.cookie), invited.userId, "the second session belongs to the same account");
  assert.deepEqual(await identitiesOf(invited.userId), linksAfterFirst, "the second sign-in adds no identity row");
  assert.deepEqual(await identitiesOf(invited.userId), ["credential", "github"], "one provider identity, not two");
  assert.equal(await sessionCount(invited.userId), 2, "each sign-in stores its own session");
});
