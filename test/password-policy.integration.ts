import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { DEFAULT_PASSWORD_POLICY, type PasswordPolicyDocument, type PasswordPolicyView } from "@artiflow/contracts/settings";

import { loadConfig } from "../apps/api/src/config.ts";
import { issuePasswordReset } from "../apps/api/src/password-reset/service.ts";
import { passwordPolicySetting, readSetting } from "../apps/api/src/settings/store.ts";
import { seedTrustedAccount, trustedSession, type TrustedFixture, type TrustedSession } from "./helpers/trusted-accounts.ts";
import {
  adminGet,
  adminPut,
  adminRequest,
  assertStatus,
  publicPost,
  sessionCookieOf,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const POLICY_PATH = "/api/admin/password-policy";
const PUBLIC_POLICY_PATH = "/api/auth/password-policy";
const INVITE_PREVIEW_PATH = "/api/auth/registration/preview";
const INVITE_COMPLETE_PATH = "/api/auth/registration/complete";
const RESET_PREVIEW_PATH = "/api/auth/password-reset/preview";
const RESET_COMPLETE_PATH = "/api/auth/password-reset/complete";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const CHANGE_PASSWORD_PATH = "/api/auth/change-password";
const TOKEN_MARKER = "#token=";

type PolicyBody = { revision: number | null; policy: PasswordPolicyDocument };
type RefusalBody = { code?: string; message?: string; missing?: { requirement: string; message: string }[] };

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;
let member: TrustedSession | null = null;
let revision: number | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function actor(session: TrustedSession | null): TrustedSession {
  assert.ok(session, "the account exists");
  return session;
}

function adminCookie(): string {
  return actor(administrator).cookie;
}

function policyOf(overrides: Partial<PasswordPolicyDocument> = {}): PasswordPolicyDocument {
  return { ...DEFAULT_PASSWORD_POLICY, ...overrides };
}

async function readConfiguration(): Promise<PolicyBody> {
  const response = await adminGet(target(), POLICY_PATH, adminCookie());
  assertStatus(response, 200, "an administrator reads the password policy");
  return (await response.json()) as PolicyBody;
}

async function writePolicy(policy: PasswordPolicyDocument, expected: number | null): Promise<Response> {
  return adminPut(target(), POLICY_PATH, { revision: expected, policy }, adminCookie());
}

async function appliedPolicy(policy: PasswordPolicyDocument): Promise<PolicyBody> {
  const response = await writePolicy(policy, revision);
  assertStatus(response, 200, "the administrator's change is applied");
  const body = (await response.json()) as PolicyBody;
  revision = body.revision;
  return body;
}

async function publicPolicy(): Promise<PasswordPolicyView> {
  const response = await adminRequest(target(), PUBLIC_POLICY_PATH, { method: "GET" });
  assertStatus(response, 200, "anyone can read the policy before choosing a password");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as PasswordPolicyView;
}

function issueInvite(email: string): string {
  const result = target().command("user:invite", [email]);
  assert.equal(result.status, 0, `user:invite failed: ${result.stderr}`);
  const url = result.stdout.trim();
  const marker = url.indexOf(TOKEN_MARKER);
  assert.ok(marker > 0, "the console command printed an invitation URL");
  return url.slice(marker + TOKEN_MARKER.length);
}

async function signIn(email: string, password: string): Promise<Response> {
  return publicPost(target(), SIGN_IN_PATH, { email, password });
}

async function refusalOf(response: Response): Promise<{ status: number; body: RefusalBody; text: string }> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as RefusalBody, text };
}

function requirementsOf(body: RefusalBody): string[] {
  return (body.missing ?? []).map((rule) => rule.requirement);
}

type Captured = { result: Response; lines: Record<string, unknown>[] };

async function withPolicyAuditCapture(run: () => Promise<Response>): Promise<Captured> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = written
      .flatMap((line) => line.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((line) => line.event === "password.policy.updated");
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Policy Administrator" });
  member = await trustedSession(fixtureOf(), { name: "Ordinary Member" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member can neither read nor change the password policy", async () => {
  const read = await adminGet(target(), POLICY_PATH, actor(member).cookie);
  assertStatus(read, 403, "reading the policy is an administration action");
  assert.deepEqual(await read.json(), { error: "administrator_required" });

  const write = await adminPut(target(), POLICY_PATH, { revision: null, policy: policyOf() }, actor(member).cookie);
  assertStatus(write, 403, "changing the policy is an administration action");
  assert.deepEqual(await write.json(), { error: "administrator_required" });

  assert.equal(await readSetting(target().database.db, passwordPolicySetting), null, "a refusal stores nothing");
});

integration("an administrator reads the seeded default before anything is stored", async () => {
  const body = await readConfiguration();
  assert.deepEqual(body, { revision: null, policy: { ...DEFAULT_PASSWORD_POLICY } });
});

integration("the public read answers the current policy with a message per requirement", async () => {
  const view = await publicPolicy();
  assert.equal(view.minLength, 12);
  assert.equal(view.maxLength, 128);
  assert.equal(view.requireUppercase, true);
  assert.equal(view.requireLowercase, true);
  assert.equal(view.requireNumber, true);
  assert.equal(view.requireSymbol, true);
  assert.deepEqual(
    view.requirements.map((rule) => rule.requirement),
    ["minLength", "maxLength", "uppercase", "lowercase", "number", "symbol"],
  );
  for (const rule of view.requirements) {
    assert.equal(rule.message.length > 0, true, `${rule.requirement} carries a renderable message`);
    assert.equal(rule.message.length <= 120, true, `${rule.requirement} stays one bounded sentence`);
  }
});

integration("a registration completion refuses a password that misses a requirement and names it", async () => {
  const email = `policy-register-${randomUUID()}@example.test`;
  const token = issueInvite(email);
  const candidate = "lowercase-1-password";

  const refused = await refusalOf(
    await publicPost(target(), INVITE_COMPLETE_PATH, { token, name: "Policy Person", password: candidate }),
  );
  assert.equal(refused.status, 400, "a password outside the policy is refused");
  assert.equal(refused.body.code, "INVALID_PASSWORD");
  assert.deepEqual(requirementsOf(refused.body), ["uppercase"], "the refusal names the missing requirement");
  assert.match(refused.body.message ?? "", /uppercase letter/i);
  assert.equal(refused.text.includes(candidate), false, "the refusal never echoes the password");
  assert.equal(refused.text.includes(token), false, "the refusal never echoes the invitation token");

  const preview = await publicPost(target(), INVITE_PREVIEW_PATH, { token });
  assertStatus(preview, 200, "the refused completion leaves the invitation usable");

  const accepted = await publicPost(target(), INVITE_COMPLETE_PATH, {
    token,
    name: "Policy Person",
    password: "Compliant-1-Password",
  });
  assertStatus(accepted, 200, "a password that meets the policy completes the registration");
  assert.deepEqual(await accepted.json(), { ok: true });

  const session = await signIn(email, "Compliant-1-Password");
  assertStatus(session, 200, "the created account signs in with the password it set");
});

integration("a reset completion refuses a password that misses a requirement and names it", async () => {
  const owner = await seedTrustedAccount(target().database, { password: `old-password-${randomUUID()}` });
  const issued = await issuePasswordReset(target().database.db, owner.email);
  assert.equal(issued.kind, "issued");
  const token = issued.kind === "issued" ? issued.token : "";
  const candidate = "NoSymbols1234Password";

  const refused = await refusalOf(
    await publicPost(target(), RESET_COMPLETE_PATH, { token, newPassword: candidate }),
  );
  assert.equal(refused.status, 400, "a password outside the policy is refused");
  assert.equal(refused.body.code, "PASSWORD_INVALID");
  assert.deepEqual(requirementsOf(refused.body), ["symbol"], "the refusal names the missing requirement");
  assert.match(refused.body.message ?? "", /symbol/i);
  assert.equal(refused.text.includes(candidate), false, "the refusal never echoes the password");

  const preview = await publicPost(target(), RESET_PREVIEW_PATH, { token });
  assertStatus(preview, 200, "the refused completion does not consume the link");
  assert.equal((await signIn(owner.email, owner.password)).status, 200, "the stored password is untouched");

  const replacement = `Replacement-1-${randomUUID()}`;
  const accepted = await publicPost(target(), RESET_COMPLETE_PATH, { token, newPassword: replacement });
  assertStatus(accepted, 200, "a password that meets the policy completes the reset");
  assert.equal((await signIn(owner.email, replacement)).status, 200, "the new password signs in");
  assert.equal((await signIn(owner.email, owner.password)).status >= 400, true, "the previous password stops working");
});

integration("the library endpoint that sets a password directly answers the same list", async () => {
  const owner = await seedTrustedAccount(target().database, { password: "Current-1-Password" });
  const signedIn = await signIn(owner.email, "Current-1-Password");
  assertStatus(signedIn, 200, "the fixture account signs in");
  const cookie = sessionCookieOf(signedIn);
  assert.equal(cookie.length > 0, true);

  const refused = await refusalOf(
    await adminRequest(target(), CHANGE_PASSWORD_PATH, {
      method: "POST",
      headers: { cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "Current-1-Password", newPassword: "short" }),
    }),
  );
  assert.equal(refused.status, 400, "an endpoint that sets a password directly applies the policy");
  assert.equal(refused.body.code, "INVALID_PASSWORD");
  assert.deepEqual(requirementsOf(refused.body), ["minLength", "uppercase", "number", "symbol"]);
  assert.match(refused.body.message ?? "", /at least 12 characters/i);
  assert.equal(refused.text.includes("short"), false, "the refusal never echoes the password");

  const accepted = await adminRequest(target(), CHANGE_PASSWORD_PATH, {
    method: "POST",
    headers: { cookie, origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "Current-1-Password", newPassword: "Changed-1-Password" }),
  });
  assertStatus(accepted, 200, "a password that meets the policy is accepted");
  assert.equal((await signIn(owner.email, "Changed-1-Password")).status, 200, "the changed password signs in");
});

integration("a stored password keeps working after the policy tightens", async () => {
  const owner = await seedTrustedAccount(target().database, { password: `kept-password-${randomUUID()}` });
  assert.equal((await signIn(owner.email, owner.password)).status, 200, "the password works before the change");

  const body = await appliedPolicy(policyOf({ minLength: 40, requireSymbol: true }));
  assert.equal(body.policy.minLength, 40);
  assert.equal(body.revision, 1);

  assert.equal((await signIn(owner.email, owner.password)).status, 200, "no forced reset follows a tighter policy");

  const view = await publicPolicy();
  assert.equal(view.minLength, 40, "the public read answers the tightened policy");

  const unknown = await refusalOf(
    await publicPost(target(), RESET_COMPLETE_PATH, { token: "unknown-token", newPassword: "Short-1!" }),
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "INVALID_RESET", "an unknown link is refused before the password is judged");
  assert.equal(requirementsOf(unknown.body).length, 0, "an unknown link answers no requirement list");
});

integration("an applied change records one closed event and a stale revision changes nothing", async () => {
  const before = await readConfiguration();
  assert.equal(before.revision, 1);
  const { result, lines } = await withPolicyAuditCapture(() =>
    writePolicy(policyOf({ minLength: 16, requireSymbol: false }), 1),
  );
  assertStatus(result, 200, "the administrator saves a policy");
  const applied = (await result.json()) as PolicyBody;
  assert.equal(applied.revision, 2);
  assert.equal(applied.policy.minLength, 16);
  assert.equal(applied.policy.requireSymbol, false);

  assert.equal(lines.length, 1, "an applied change records exactly one event");
  assert.equal(lines[0]?.event, "password.policy.updated");
  assert.equal(lines[0]?.actorId, actor(administrator).userId);
  assert.equal(lines[0]?.actorRole, "administrator");
  assert.equal(lines[0]?.settingKey, "password.policy");
  assert.equal(lines[0]?.outcome, "applied");
  assert.deepEqual(Object.keys(lines[0] ?? {}).sort(), [
    "actorId",
    "actorRole",
    "event",
    "level",
    "outcome",
    "requestId",
    "settingKey",
    "ts",
  ]);

  const stored = await readSetting(target().database.db, passwordPolicySetting);
  assert.deepEqual(stored?.value, applied.policy, "the stored document is the applied policy");
  assert.equal(stored?.updatedBy, actor(administrator).userId);

  const stale = await withPolicyAuditCapture(() => writePolicy(policyOf({ minLength: 8 }), 1));
  assertStatus(stale.result, 409, "a write against an old revision is refused");
  assert.deepEqual(await stale.result.json(), { error: "revision_conflict" });
  assert.deepEqual(stale.lines, [], "a conflict records nothing");
  const after = await readConfiguration();
  assert.deepEqual(after, applied, "the stored document is unchanged by the refused write");

  const missingLength = await writePolicy({ ...policyOf(), minLength: 4 }, after.revision);
  assertStatus(missingLength, 400, "a length under the floor is refused");
  assert.deepEqual(await missingLength.json(), { error: "invalid_body" });

  const staleRevision = await writePolicy(policyOf(), 1);
  assertStatus(staleRevision, 409, "the conflict does not depend on the payload");
  revision = after.revision;
});

integration("the policy is stored once and survives a reread of the administration surface", async () => {
  const stored = await readSetting(target().database.db, passwordPolicySetting);
  assert.ok(stored, "the document exists after the first administrator change");
  const reread = await readConfiguration();
  assert.equal(reread.revision, stored.revision);
  assert.deepEqual(reread.policy, stored.value);
});
