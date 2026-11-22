import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { loadConfig } from "../apps/api/src/config.ts";
import {
  COMPLETE_PATH,
  PREVIEW_PATH,
  assertNoLeak,
  assertNoSession,
  invitationCredential,
  invitePost,
  inviteRequest,
  seedCredentialUser,
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

invite("expired, used, unknown and tampered invitations are refused generically", async () => {
  const expired = harness.issue(`expired-${randomUUID()}@example.test`);
  await harness.expire(expired.email);
  const used = harness.issue(`used-${randomUUID()}@example.test`);
  assert.equal(
    (await invitePost(harness, COMPLETE_PATH, { token: used.token, ...invitationCredential("Used Once") })).status,
    200,
  );
  const tamperedIssue = harness.issue(`tampered-${randomUUID()}@example.test`);
  const last = tamperedIssue.token.slice(-1);
  const tampered = tamperedIssue.token.slice(0, -1) + (last === "A" ? "B" : "A");
  const unknown = randomBytes(32).toString("base64url");

  const attempts: Promise<Response>[] = [
    invitePost(harness, PREVIEW_PATH, { token: expired.token }),
    invitePost(harness, COMPLETE_PATH, { token: expired.token, ...invitationCredential("Expired") }),
    invitePost(harness, PREVIEW_PATH, { token: used.token }),
    invitePost(harness, COMPLETE_PATH, { token: used.token, ...invitationCredential("Reused") }),
    invitePost(harness, PREVIEW_PATH, { token: unknown }),
    invitePost(harness, COMPLETE_PATH, { token: unknown, ...invitationCredential("Unknown") }),
    invitePost(harness, PREVIEW_PATH, { token: tampered }),
    invitePost(harness, COMPLETE_PATH, { token: tampered, ...invitationCredential("Tampered") }),
  ];
  const bodies: string[] = [];
  for (const attempt of attempts) {
    const refusal = await attempt;
    assert.equal(refusal.status, 400);
    assertNoSession(refusal);
    const text = await refusal.text();
    assertNoLeak(text, [expired.token, used.token, tampered, unknown]);
    bodies.push(text);
  }
  assert.equal(new Set(bodies).size, 1, "refusals must be indistinguishable");
});

invite("an invalid name or password is rejected without consuming the invitation", async () => {
  const issued = harness.issue(`validation-${randomUUID()}@example.test`);
  const attempts = [
    { name: "   ", password: `valid-password-${randomUUID()}` },
    { name: "Valid Name", password: "short7!" },
    { name: "Valid Name", password: "x".repeat(129) },
  ];
  for (const attempt of attempts) {
    const refusal = await invitePost(harness, COMPLETE_PATH, { token: issued.token, ...attempt });
    assert.equal(refusal.status, 400);
    assertNoSession(refusal);
    assertNoLeak(await refusal.text(), [issued.token, attempt.password]);
  }

  const preview = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(preview.status, 200);
  const accepted = await invitePost(harness, COMPLETE_PATH, {
    token: issued.token,
    ...invitationCredential("Valid Name"),
  });
  assert.equal(accepted.status, 200);
});

invite("an account created after issuance is refused and never reset", async () => {
  const issued = harness.issue(`later-${randomUUID()}@example.test`);
  const originalPassword = `original-password-${randomUUID()}`;
  await seedCredentialUser(harness, issued.email, originalPassword);

  const attemptPassword = `attempt-password-${randomUUID()}`;
  const refused = await invitePost(harness, COMPLETE_PATH, {
    token: issued.token,
    name: "Override Attempt",
    password: attemptPassword,
  });
  assert.equal(refused.status, 400);
  assertNoSession(refused);
  assertNoLeak(await refused.text(), [issued.token, attemptPassword]);

  const original = await signInEmail(harness, issued.email, originalPassword);
  assert.equal(original.status, 200);
  assert.equal((await sessionUser(harness, original))?.email, issued.email);

  const replaced = await signInEmail(harness, issued.email, attemptPassword);
  assert.equal(replaced.status >= 400, true);
  assertNoSession(replaced);
});

invite("a credential-creation fault rolls back and leaves the invitation usable", async () => {
  const issued = harness.issue(`fault-${randomUUID()}@example.test`);
  const fault = `registration_invite_fault_${randomUUID().replaceAll("-", "")}`;
  const pool = harness.database.pool;
  await pool.query(
    `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW."providerId" = 'credential'
          AND EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "email" = '${issued.email}')
       THEN RAISE EXCEPTION 'registration fixture fault';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await pool.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON "account" FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
  try {
    const failed = await invitePost(harness, COMPLETE_PATH, {
      token: issued.token,
      ...invitationCredential("Faulted"),
    });
    assert.equal(failed.status >= 400, true);
    assertNoSession(failed);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${fault} ON "account"`);
    await pool.query(`DROP FUNCTION IF EXISTS ${fault}()`);
  }

  const preview = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(preview.status, 200);
  assert.equal(((await preview.json()) as { email?: string }).email, issued.email);
  const recovered = invitationCredential("Recovered");
  const accepted = await invitePost(harness, COMPLETE_PATH, { token: issued.token, ...recovered });
  assert.equal(accepted.status, 200);
  assert.equal((await signInEmail(harness, issued.email, recovered.password)).status, 200);
});

invite("two concurrent completions of one token produce exactly one account", async () => {
  const issued = harness.issue(`race-${randomUUID()}@example.test`);
  const first = invitationCredential("First Racer");
  const second = invitationCredential("Second Racer");
  const [a, b] = await Promise.all([
    invitePost(harness, COMPLETE_PATH, { token: issued.token, ...first }),
    invitePost(harness, COMPLETE_PATH, { token: issued.token, ...second }),
  ]);
  assert.deepEqual(
    [a.status, b.status].sort((x, y) => x - y),
    [200, 400],
  );

  const winner = a.status === 200 ? first : second;
  const loser = a.status === 200 ? second : first;
  const winnerSignIn = await signInEmail(harness, issued.email, winner.password);
  assert.equal(winnerSignIn.status, 200);
  assert.equal((await sessionUser(harness, winnerSignIn))?.name, winner.name);

  const loserSignIn = await signInEmail(harness, issued.email, loser.password);
  assert.equal(loserSignIn.status >= 400, true);
});

invite("the origin and JSON guard also covers the new registration paths", async () => {
  const issued = harness.issue(`guard-${randomUUID()}@example.test`);
  const foreign = await invitePost(harness, PREVIEW_PATH, { token: issued.token }, { origin: "http://127.0.0.1:9999" });
  assert.equal(foreign.status, 403);
  assert.equal((await invitePost(harness, PREVIEW_PATH, { token: issued.token }, { origin: "null" })).status, 403);
  const missingOrigin = await inviteRequest(harness, PREVIEW_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token }),
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(
    (await invitePost(harness, PREVIEW_PATH, { token: issued.token }, { "content-type": "text/plain" })).status,
    415,
  );
  const form = await invitePost(
    harness,
    COMPLETE_PATH,
    { token: issued.token, ...invitationCredential() },
    {
      "content-type": "application/x-www-form-urlencoded",
    },
  );
  assert.equal(form.status, 415);

  const preview = await invitePost(harness, PREVIEW_PATH, { token: issued.token });
  assert.equal(preview.status, 200);
});
