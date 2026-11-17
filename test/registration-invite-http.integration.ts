import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { loadConfig } from "../apps/api/src/config.ts";
import {
  COMPLETE_PATH,
  PREVIEW_PATH,
  assertNoLeak,
  assertNoSession,
  invitationCredential,
  inviteGet,
  invitePost,
  sessionUser,
  signInEmail,
  startInvitationHarness,
  type InvitationHarness,
} from "./helpers/registration-invites.ts";

const config = loadConfig(process.env);
const invite = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);

let harness: InvitationHarness;

before(async () => {
  harness = await startInvitationHarness(config);
});

after(async () => {
  await harness?.close();
});

invite("preview returns the fixed canonical email and never consumes the invitation", async () => {
  const issued = harness.issue(`  Preview-${randomUUID()}@Example.TEST  `);
  const first = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assertNoSession(first);
  const body = (await first.json()) as { email?: string };
  assert.equal(body.email, issued.email);

  const repeated = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), body);

  const beforeCompletion = await signInEmail(harness, issued.email, `not-yet-${randomUUID()}`);
  assert.equal(beforeCompletion.status >= 400, true);
  assertNoSession(beforeCompletion);

  const reads = [
    await inviteGet(harness, PREVIEW_PATH),
    await inviteGet(harness, COMPLETE_PATH),
    await inviteGet(harness, `${PREVIEW_PATH}?token=${issued.token}`),
    await inviteGet(harness, `${COMPLETE_PATH}?token=${issued.token}`),
  ];
  for (const read of reads) assertNoSession(read);
  const stillValid = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(stillValid.status, 200);
  assert.deepEqual(await stillValid.json(), body);
});

invite("a valid completion creates the issued email only and issues no session", async () => {
  const issued = harness.issue(`Complete-${randomUUID()}@Example.TEST`);
  const forgedEmail = `forged-${randomUUID()}@example.test`;
  const { name, password } = invitationCredential();
  const response = await invitePost(harness, COMPLETE_PATH, {
    token: issued.token,
    name,
    password,
    email: forgedEmail,
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: true });
  assertNoLeak(text, [issued.token, password]);
  assertNoSession(response);

  const signedIn = await signInEmail(harness, issued.email, password);
  assert.equal(signedIn.status, 200);
  const created = await sessionUser(harness, signedIn);
  assert.equal(created?.email, issued.email);
  assert.equal(created?.emailVerified, false, "invitation possession is not mailbox proof");

  const forged = await signInEmail(harness, forgedEmail, password);
  assert.equal(forged.status >= 400, true);
  assertNoSession(forged);
});
