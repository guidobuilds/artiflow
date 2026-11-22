import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { loadConfig } from "../apps/api/src/config.ts";
import { account, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import {
  RESET_COMPLETE_PATH,
  RESET_PREVIEW_PATH,
  assertNoLeak,
  assertNoSession,
  expireResetToken,
  invitePost,
  inviteRequest,
  issueResetToken,
  sessionCookie,
  signInEmail,
  startInvitationHarness,
  type InvitationHarness,
  type SessionUser,
} from "./helpers/registration-invites.ts";
import { seedTrustedAccount } from "./helpers/trusted-accounts.ts";

const config = loadConfig(process.env);
const reset = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);
const REFUSAL_CODE = "INVALID_RESET";
const SESSION_PATH = "/api/auth/get-session";

type ErrorBody = { code?: string; message?: string };

let harness: InvitationHarness;

before(async () => {
  harness = await startInvitationHarness(config);
});

after(async () => {
  await harness?.close();
});

function newPassword(): string {
  return `Reset-Password-${randomUUID()}`;
}

async function accountWithLink(): Promise<{ userId: string; email: string; password: string; token: string }> {
  const email = `reset-${randomUUID()}@example.test`;
  const password = `old-password-${randomUUID()}`;
  const seeded = await seedTrustedAccount(harness.database, { email, password });
  return { userId: seeded.userId, email, password, token: await issueResetToken(harness, email) };
}

async function openSession(email: string, password: string): Promise<string> {
  const cookie = sessionCookie(await signInEmail(harness, email, password));
  assert.equal(cookie.length > 0, true, "the fixture holds an open session");
  return cookie;
}

async function sessionUserByCookie(cookie: string): Promise<SessionUser | null> {
  const response = await inviteRequest(harness, SESSION_PATH, { headers: { cookie } });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { user?: SessionUser } | null;
  return payload?.user ?? null;
}

function refusal(response: Response): Promise<string> {
  assert.equal(response.status, 400, "an unusable link answers the generic refusal");
  assertNoSession(response);
  return response.text();
}

async function previewEmail(token: string): Promise<string> {
  const response = await invitePost(harness, RESET_PREVIEW_PATH, { token });
  assert.equal(response.status, 200, "the link is still previewable");
  return ((await response.json()) as { email?: string }).email ?? "";
}

reset("preview returns the account email for a pending link and never consumes it", async () => {
  const local = `preview-${randomUUID()}`;
  const seeded = await seedTrustedAccount(harness.database, {
    email: `${local}@example.test`,
    password: `preview-password-${randomUUID()}`,
  });
  const token = await issueResetToken(harness, `  ${local.toUpperCase()}@Example.TEST  `);

  const response = await invitePost(harness, RESET_PREVIEW_PATH, { token });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assertNoSession(response);
  const text = await response.text();
  assertNoLeak(text, [token]);
  assert.deepEqual(JSON.parse(text), { email: seeded.email });

  const repeated = await invitePost(harness, RESET_PREVIEW_PATH, { token });
  assert.deepEqual(await repeated.json(), JSON.parse(text));
  const completed = await invitePost(harness, RESET_COMPLETE_PATH, { token, newPassword: newPassword() });
  assert.equal(completed.status, 200, "preview never spent the link");
});

reset("expired, used, tampered, unknown and empty tokens share one refusal", async () => {
  const expired = await accountWithLink();
  await expireResetToken(harness, expired.userId);

  const used = await accountWithLink();
  assert.equal(
    (await invitePost(harness, RESET_COMPLETE_PATH, { token: used.token, newPassword: newPassword() })).status,
    200,
  );

  const live = await accountWithLink();
  const last = live.token.slice(-1);
  const tampered = live.token.slice(0, -1) + (last === "A" ? "B" : "A");
  const unknown = randomBytes(32).toString("base64url");

  const attempts: [string, Promise<Response>][] = [
    ["expired", invitePost(harness, RESET_PREVIEW_PATH, { token: expired.token })],
    ["used", invitePost(harness, RESET_PREVIEW_PATH, { token: used.token })],
    ["tampered", invitePost(harness, RESET_PREVIEW_PATH, { token: tampered })],
    ["unknown", invitePost(harness, RESET_PREVIEW_PATH, { token: unknown })],
    ["empty", invitePost(harness, RESET_PREVIEW_PATH, { token: "" })],
  ];
  const bodies: string[] = [];
  for (const [label, attempt] of attempts) {
    const response = await attempt;
    const text = await refusal(response);
    assertNoLeak(text, [expired.token, used.token, tampered, unknown]);
    const body = JSON.parse(text) as ErrorBody;
    assert.equal(body.code, REFUSAL_CODE, `${label} answers the generic code`);
    assert.equal(typeof body.message === "string" && body.message.length > 0, true);
    bodies.push(text);
  }
  assert.equal(new Set(bodies).size, 1, "preview refusals must be byte-identical");

  const completions: Promise<Response>[] = [
    invitePost(harness, RESET_COMPLETE_PATH, { token: expired.token, newPassword: newPassword() }),
    invitePost(harness, RESET_COMPLETE_PATH, { token: used.token, newPassword: newPassword() }),
    invitePost(harness, RESET_COMPLETE_PATH, { token: tampered, newPassword: newPassword() }),
    invitePost(harness, RESET_COMPLETE_PATH, { token: unknown, newPassword: newPassword() }),
    invitePost(harness, RESET_COMPLETE_PATH, { token: "", newPassword: newPassword() }),
  ];
  const completionBodies: string[] = [];
  for (const attempt of completions) completionBodies.push(await refusal(await attempt));
  assert.equal(new Set(completionBodies).size, 1, "completion refusals must be byte-identical");
  assert.equal(completionBodies[0], bodies[0], "invalid, expired and used are indistinguishable across both routes");

  assert.equal(await previewEmail(live.token), live.email);
  assert.equal((await signInEmail(harness, live.email, live.password)).status, 200);
});

reset("complete replaces the password, kills every open session and is single use", async () => {
  const owner = await accountWithLink();
  const laptop = await openSession(owner.email, owner.password);
  const phone = await openSession(owner.email, owner.password);
  assert.equal((await sessionUserByCookie(laptop))?.email, owner.email, "the sessions work before the reset");

  const replacement = newPassword();
  const response = await invitePost(harness, RESET_COMPLETE_PATH, { token: owner.token, newPassword: replacement });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assertNoSession(response);
  assertNoLeak(await response.clone().text(), [owner.token, replacement]);
  assert.deepEqual(await response.json(), { status: "ok" });

  assert.equal((await signInEmail(harness, owner.email, replacement)).status, 200, "the new password signs in");
  assert.equal((await signInEmail(harness, owner.email, owner.password)).status >= 400, true, "the old one does not");
  assert.equal(await sessionUserByCookie(laptop), null, "the pre-existing session is dead");
  assert.equal(await sessionUserByCookie(phone), null, "the second pre-existing session is dead");

  const reused = await invitePost(harness, RESET_COMPLETE_PATH, { token: owner.token, newPassword: newPassword() });
  assert.equal((await refusal(reused)).includes(REFUSAL_CODE), true, "the same link never works twice");
  assert.equal((await signInEmail(harness, owner.email, replacement)).status, 200, "a reuse attempt changes nothing");
});

reset("a password outside the policy is refused and does not consume the link", async () => {
  const owner = await accountWithLink();
  const short = "short7!";
  const long = "x".repeat(129);

  for (const candidate of [short, long]) {
    const response = await invitePost(harness, RESET_COMPLETE_PATH, { token: owner.token, newPassword: candidate });
    assert.equal(response.status, 400);
    assertNoSession(response);
    const text = await response.text();
    const body = JSON.parse(text) as ErrorBody;
    assert.equal(body.code, "PASSWORD_INVALID");
    assert.equal(typeof body.message === "string" && body.message.length <= 120, true, "one bounded message");
    assertNoLeak(text, [owner.token, candidate]);
  }

  assert.equal(await previewEmail(owner.token), owner.email);
  assert.equal((await signInEmail(harness, owner.email, owner.password)).status, 200);

  const accepted = newPassword();
  const completed = await invitePost(harness, RESET_COMPLETE_PATH, { token: owner.token, newPassword: accepted });
  assert.equal(completed.status, 200, "the untouched link still completes");
  assert.equal((await signInEmail(harness, owner.email, accepted)).status, 200);
});

reset("a social-only account gains a local password through the same link", async () => {
  const email = `social-${randomUUID()}@example.test`;
  const now = new Date();
  const userId = randomUUID();
  await harness.database.db
    .insert(user)
    .values({ id: userId, name: "Social Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
  await harness.database.db.insert(account).values({
    id: randomUUID(),
    userId,
    providerId: "github",
    accountId: `github-${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal((await signInEmail(harness, email, newPassword())).status >= 400, true, "no local password yet");

  const token = await issueResetToken(harness, email);
  const local = newPassword();
  const completed = await invitePost(harness, RESET_COMPLETE_PATH, { token, newPassword: local });
  assert.equal(completed.status, 200);
  assertNoSession(completed);
  assert.equal((await signInEmail(harness, email, local)).status, 200, "the new local password signs in");
});
