import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { loadConfig } from "../apps/api/src/config.ts";
import { user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { trustedSession, type TrustedFixture, type TrustedSession } from "./helpers/trusted-accounts.ts";
import {
  adminGet,
  adminPost,
  adminRequest,
  assertStatus,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 20_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;
let secondAdministrator: TrustedSession | null = null;
let member: TrustedSession | null = null;

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

async function roleOf(userId: string): Promise<string | undefined> {
  const rows = await target().database.db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  return rows[0]?.role;
}

async function setBanned(userId: string, banned: boolean): Promise<void> {
  await target().database.db.update(user).set({ banned }).where(eq(user.id, userId));
}

async function withAuditCapture<T>(run: () => Promise<T>): Promise<{ result: T; auditLines: string[] }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    return { result, auditLines: written.filter(isAuditLine) };
  } finally {
    process.stdout.write = original;
  }
}

function isAuditLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.subjectId === "string" && typeof parsed.actorId === "string";
  } catch {
    return false;
  }
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "First Administrator" });
  secondAdministrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Second Administrator" });
  member = await trustedSession(fixtureOf(), { name: "Ordinary Member" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("an anonymous caller is refused before any administration work happens", async () => {
  const list = await adminRequest(target(), "/api/admin/administrators", { method: "GET" });
  assertStatus(list, 401, "listing administrators requires a session");
  assert.deepEqual(await list.json(), { error: "sign_in_required" });

  const change = await adminRequest(target(), `/api/admin/users/${actor(member).userId}/role`, {
    method: "POST",
    headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ role: "administrator" }),
  });
  assertStatus(change, 401, "changing a role requires a session");
  assert.equal(await roleOf(actor(member).userId), "member");
});

integration("an account without the role can neither read nor change administration", async () => {
  const list = await adminGet(target(), "/api/admin/administrators", actor(member).cookie);
  assertStatus(list, 403, "listing administrators is an administration action");
  assert.deepEqual(await list.json(), { error: "administrator_required" });

  const selfPromotion = await adminPost(
    target(),
    `/api/admin/users/${actor(member).userId}/role`,
    { role: "administrator" },
    actor(member).cookie,
  );
  assertStatus(selfPromotion, 403, "a member cannot grant themselves the role");
  assert.equal(await roleOf(actor(member).userId), "member");
});

integration("the library administration endpoints refuse a member too", async () => {
  const listUsers = await adminGet(target(), "/api/auth/admin/list-users", actor(member).cookie);
  assertStatus(listUsers, 403, "the library user listing is an administration action");

  const setRole = await adminPost(
    target(),
    "/api/auth/admin/set-role",
    { userId: actor(member).userId, role: "administrator" },
    actor(member).cookie,
  );
  assertStatus(setRole, 403, "the library role endpoint is an administration action");
  assert.equal(await roleOf(actor(member).userId), "member");
});

integration("an administrator sees every administrator and two of them operate at once", async () => {
  const response = await adminGet(target(), "/api/admin/administrators", actor(administrator).cookie);
  assertStatus(response, 200, "an administrator reads the administrator list");
  const body = (await response.json()) as { administrators: { id: string; email: string; role: string }[] };
  const ids = body.administrators.map((entry) => entry.id).sort();
  assert.deepEqual(ids, [actor(administrator).userId, actor(secondAdministrator).userId].sort());
  assert.equal(
    body.administrators.every((entry) => entry.role === "administrator"),
    true,
    "the list carries only administrators",
  );
});

integration(
  "an administrator grants the role, the new administrator operates, and revocation takes effect",
  async () => {
    const granted = await adminPost(
      target(),
      `/api/admin/users/${actor(member).userId}/role`,
      { role: "administrator" },
      actor(administrator).cookie,
    );
    assertStatus(granted, 200, "an administrator grants the role");
    assert.deepEqual(await granted.json(), {
      user: { id: actor(member).userId, role: "administrator" },
      changed: true,
    });

    const asNewAdministrator = await adminGet(target(), "/api/admin/administrators", actor(member).cookie);
    assertStatus(asNewAdministrator, 200, "the granted role is effective for the same session");

    const revoked = await adminPost(
      target(),
      `/api/admin/users/${actor(administrator).userId}/role`,
      { role: "member" },
      actor(member).cookie,
    );
    assertStatus(revoked, 200, "the new administrator revokes the first one");
    assert.equal(await roleOf(actor(administrator).userId), "member");

    const afterRevocation = await adminGet(target(), "/api/admin/administrators", actor(administrator).cookie);
    assertStatus(afterRevocation, 403, "revocation takes effect on the next request");
  },
);

integration("impersonation is refused even for an administrator", async () => {
  const response = await adminPost(
    target(),
    "/api/auth/admin/impersonate-user",
    { userId: actor(member).userId },
    actor(secondAdministrator).cookie,
  );
  assertStatus(response, 403, "impersonation is not an authority this product grants");
});

integration("an invalid role is refused and the account keeps the role it had", async () => {
  const response = await adminPost(
    target(),
    `/api/admin/users/${actor(secondAdministrator).userId}/role`,
    { role: "owner" },
    actor(secondAdministrator).cookie,
  );
  assertStatus(response, 400, "an unknown role is refused");
  assert.deepEqual(await response.json(), { error: "invalid_role" });
  assert.equal(await roleOf(actor(secondAdministrator).userId), "administrator");
});

integration("an unknown account is refused", async () => {
  const response = await adminPost(
    target(),
    "/api/admin/users/00000000-0000-4000-8000-000000000000/role",
    { role: "administrator" },
    actor(secondAdministrator).cookie,
  );
  assertStatus(response, 404, "an unknown account is refused");
  assert.deepEqual(await response.json(), { error: "user_not_found" });
});

integration("a role change without the public origin is refused before it is applied", async () => {
  const response = await adminRequest(target(), `/api/admin/users/${actor(secondAdministrator).userId}/role`, {
    method: "POST",
    headers: { cookie: actor(secondAdministrator).cookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  });
  assertStatus(response, 403, "a cookie mutation requires the public origin");
  assert.equal(await roleOf(actor(secondAdministrator).userId), "administrator");
});

integration("assigning the role an account already holds changes nothing and records no event", async () => {
  const { result: response, auditLines } = await withAuditCapture(() =>
    adminPost(
      target(),
      `/api/admin/users/${actor(secondAdministrator).userId}/role`,
      { role: "administrator" },
      actor(secondAdministrator).cookie,
    ),
  );
  assertStatus(response, 200, "a role the account already holds is not an error");
  assert.deepEqual(auditLines, [], "a no-op role change emits no audit line");
  assert.equal(await roleOf(actor(secondAdministrator).userId), "administrator");
  assert.deepEqual(await response.json(), {
    user: { id: actor(secondAdministrator).userId, role: "administrator" },
    changed: false,
  });
});

integration("a banned administrator is refused on the next request until the flag is cleared", async () => {
  await setBanned(actor(secondAdministrator).userId, true);
  try {
    const list = await adminGet(target(), "/api/admin/administrators", actor(secondAdministrator).cookie);
    assertStatus(list, 403, "a banned administrator is not an administrator for authorization");
    assert.deepEqual(await list.json(), { error: "administrator_required" });

    const change = await adminPost(
      target(),
      `/api/admin/users/${actor(member).userId}/role`,
      { role: "member" },
      actor(secondAdministrator).cookie,
    );
    assertStatus(change, 403, "a banned administrator cannot change roles");
    assert.equal(await roleOf(actor(member).userId), "administrator");
  } finally {
    await setBanned(actor(secondAdministrator).userId, false);
  }

  const afterClearing = await adminGet(target(), "/api/admin/administrators", actor(secondAdministrator).cookie);
  assertStatus(afterClearing, 200, "clearing the flag restores the same administrator");
  assert.equal(await roleOf(actor(secondAdministrator).userId), "administrator");
});
