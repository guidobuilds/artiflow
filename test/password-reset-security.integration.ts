import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createAuth } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  RESET_COMPLETE_PATH,
  RESET_PREVIEW_PATH,
  assertNoLeak,
  assertNoSession,
  inviteGet,
  invitePost,
  inviteRequest,
  issueResetToken,
  signInEmail,
  startInvitationHarness,
  type InvitationHarness,
} from "./helpers/registration-invites.ts";
import { seedTrustedAccount } from "./helpers/trusted-accounts.ts";

const config = loadConfig(process.env);
const reset = (name: string, fn: () => Promise<void>) => test(name, { timeout: 30_000 }, fn);
const REFUSAL_CODE = "INVALID_RESET";
const TOKEN_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

type ErrorBody = { code?: string; message?: string };

let harness: InvitationHarness;

before(async () => {
  harness = await startInvitationHarness(config);
});

after(async () => {
  await harness?.close();
});

function newPassword(): string {
  return `reset-password-${randomUUID()}`;
}

async function storedTokens(email: string): Promise<number> {
  const result = await harness.database.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "passwordResetToken" t JOIN "user" u ON u."id" = t."userId" WHERE u."email" = $1',
    [email],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function assertNoToken(text: string): void {
  assert.equal(text.includes("#token="), false, "no response may carry a reset URL");
  assert.equal(TOKEN_SHAPE.test(text), false, "no response may carry a reset token");
}

reset("no public endpoint starts a reset or hands out a link", async () => {
  const email = `start-${randomUUID()}@example.test`;
  await seedTrustedAccount(harness.database, { email, password: `start-password-${randomUUID()}` });

  const probes: [string, Promise<Response>][] = [];
  for (const path of [
    "/api/auth/forget-password",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/password-reset",
    "/api/auth/password-reset/request",
    "/api/auth/sign-in/email",
  ]) {
    probes.push([path, invitePost(harness, path, { email })]);
  }
  probes.push(["preview-with-email", invitePost(harness, RESET_PREVIEW_PATH, { email })]);
  probes.push(["complete-with-email", invitePost(harness, RESET_COMPLETE_PATH, { email, newPassword: newPassword() })]);

  for (const [label, attempt] of probes) {
    const response = await attempt;
    assertNoSession(response);
    const text = await response.text();
    assertNoToken(text);
    assertNoLeak(text, []);
    if (label === "preview-with-email" || label === "complete-with-email") {
      assert.equal(response.status >= 400, true, `${label} is refused`);
      assert.equal(text.includes(email), false, `${label} never echoes the address`);
    }
  }

  for (const path of [RESET_PREVIEW_PATH, RESET_COMPLETE_PATH]) {
    const read = await inviteGet(harness, path);
    assert.equal(read.status >= 400, true, `${path} is POST only`);
    assertNoToken(await read.text());
  }
  const capabilities = await inviteGet(harness, "/api/auth/capabilities");
  const capabilityBody = await capabilities.text();
  assertNoToken(capabilityBody);
  assert.equal(/password-?reset/i.test(capabilityBody), false, "the capability document advertises no reset flow");

  assert.equal(await storedTokens(email), 0, "probing with an address never issues a link");
});

reset("refusals are identical whether or not the account exists", async () => {
  const known = `known-${randomUUID()}@example.test`;
  await seedTrustedAccount(harness.database, { email: known, password: `known-password-${randomUUID()}` });
  const missing = `missing-${randomUUID()}@example.test`;
  const unknown = randomBytes(32).toString("base64url");

  const pairs: [string, [Promise<Response>, Promise<Response>]][] = [
    [
      "preview",
      [
        invitePost(harness, RESET_PREVIEW_PATH, { token: unknown, email: known }),
        invitePost(harness, RESET_PREVIEW_PATH, { token: unknown, email: missing }),
      ],
    ],
    [
      "complete",
      [
        invitePost(harness, RESET_COMPLETE_PATH, { token: unknown, newPassword: newPassword(), email: known }),
        invitePost(harness, RESET_COMPLETE_PATH, { token: unknown, newPassword: newPassword(), email: missing }),
      ],
    ],
  ];
  for (const [label, [existing, absent]] of pairs) {
    const first = await existing;
    const second = await absent;
    assert.equal(first.status, 400, `${label} refuses`);
    assert.equal(second.status, 400, `${label} refuses the same way`);
    assertNoSession(first);
    assertNoSession(second);
    const firstText = await first.text();
    const secondText = await second.text();
    assert.equal(firstText, secondText, `${label} refuses identically for an existing and a missing account`);
    assert.equal((JSON.parse(firstText) as ErrorBody).code, REFUSAL_CODE);
    assertNoLeak(firstText, [known, missing, unknown]);
  }

  assert.equal(await storedTokens(known), 0, "a refusal for a real account issues nothing");
  assert.equal(await storedTokens(missing), 0, "a refusal for a missing account writes nothing");
});

reset("a token cannot be guessed or altered into a usable one", async () => {
  const email = `guess-${randomUUID()}@example.test`;
  const password = `guess-password-${randomUUID()}`;
  await seedTrustedAccount(harness.database, { email, password });
  const token = await issueResetToken(harness, email);
  assert.equal(TOKEN_SHAPE.test(token), true, "the issued token has the documented shape");

  const pivot = Math.floor(token.length / 2);
  const swapped = token[pivot] === "A" ? "B" : "A";
  const variants: Record<string, string> = {
    truncated: token.slice(0, -1),
    extended: `${token}A`,
    fragment: token.slice(0, 20),
    middle: token.slice(0, pivot) + swapped + token.slice(pivot + 1),
    upper: token.toUpperCase(),
    random: randomBytes(32).toString("base64url"),
    empty: "",
  };

  const bodies: string[] = [];
  for (const [label, candidate] of Object.entries(variants)) {
    for (const path of [RESET_PREVIEW_PATH, RESET_COMPLETE_PATH]) {
      const response = await invitePost(harness, path, { token: candidate, newPassword: newPassword() });
      assert.equal(response.status, 400, `${label} is refused by ${path}`);
      assertNoSession(response);
      const text = await response.text();
      assert.equal((JSON.parse(text) as ErrorBody).code, REFUSAL_CODE, `${label} is a generic refusal`);
      assertNoLeak(text, candidate.length > 0 ? [candidate] : []);
      bodies.push(text);
    }
  }
  assert.equal(new Set(bodies).size, 1, "every guess is indistinguishable from every other");

  const preview = await invitePost(harness, RESET_PREVIEW_PATH, { token });
  assert.equal(preview.status, 200, "the real link still works");
  assert.equal((await signInEmail(harness, email, password)).status, 200, "the password is unchanged");
});

reset("the origin and JSON guard also covers the reset paths", async () => {
  const email = `guard-${randomUUID()}@example.test`;
  const password = `guard-password-${randomUUID()}`;
  await seedTrustedAccount(harness.database, { email, password });
  const token = await issueResetToken(harness, email);

  for (const path of [RESET_PREVIEW_PATH, RESET_COMPLETE_PATH]) {
    const body = { token, newPassword: newPassword() };
    assert.equal((await invitePost(harness, path, body, { origin: "http://127.0.0.1:9999" })).status, 403);
    assert.equal((await invitePost(harness, path, body, { origin: "null" })).status, 403);
    assert.equal(
      (
        await inviteRequest(harness, path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      403,
      "a mutation without Origin is refused",
    );
    assert.equal((await invitePost(harness, path, body, { "content-type": "text/plain" })).status, 415);
    assert.equal(
      (await invitePost(harness, path, body, { "content-type": "application/x-www-form-urlencoded" })).status,
      415,
    );
  }

  const preview = await invitePost(harness, RESET_PREVIEW_PATH, { token });
  assert.equal(preview.status, 200);
});

reset("a flood of reset requests answers the same refusal and changes nothing", async () => {
  const unknown = () => randomBytes(32).toString("base64url");
  const attempts: Promise<Response>[] = [];
  for (let index = 0; index < 30; index += 1) {
    attempts.push(invitePost(harness, RESET_PREVIEW_PATH, { token: unknown() }));
    attempts.push(invitePost(harness, RESET_COMPLETE_PATH, { token: unknown(), newPassword: newPassword() }));
  }
  const bodies = new Set<string>();
  for (const response of await Promise.all(attempts)) {
    assert.equal(response.status, 400, "a flooded request is refused");
    assertNoSession(response);
    const text = await response.text();
    assert.equal((JSON.parse(text) as ErrorBody).code, REFUSAL_CODE);
    bodies.add(text);
  }
  assert.equal(bodies.size, 1, "every flooded answer is the same refusal");

  const auth = createAuth(config, harness.database);
  const context = await auth.$context;
  const rules = (context.rateLimit.customRules ?? {}) as Record<string, { window: number; max: number } | undefined>;
  assert.deepEqual(rules["/password-reset/preview"], rules["/registration/preview"], "preview budget parity");
  assert.deepEqual(rules["/password-reset/complete"], rules["/registration/complete"], "complete budget parity");
  assert.equal(rules["/password-reset/preview"]?.max !== undefined, true, "the preview limit exists");
  assert.equal(rules["/password-reset/complete"]?.max !== undefined, true, "the complete limit exists");
});
