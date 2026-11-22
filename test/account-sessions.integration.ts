import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { session } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  adminGet,
  adminPost,
  adminRequest,
  assertStatus,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";
import {
  signInTrustedAccount,
  trustedSession,
  type TrustedAccount,
  type TrustedFixture,
} from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const SESSIONS_PATH = "/api/account/sessions";
const REVOKE_OTHERS_PATH = "/api/account/sessions/revoke-others";
const SESSION_PATH = "/api/auth/get-session";

type SessionView = {
  id: string;
  startedAt: string;
  lastUsedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
};
type SessionList = { sessions: SessionView[] };

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

function listSessions(cookie: string): Promise<Response> {
  return adminGet(target(), SESSIONS_PATH, cookie);
}

function revokeSession(sessionId: string, cookie: string): Promise<Response> {
  return adminPost(target(), `${SESSIONS_PATH}/${sessionId}/revoke`, {}, cookie);
}

function revokeOtherSessions(cookie: string): Promise<Response> {
  return adminPost(target(), REVOKE_OTHERS_PATH, {}, cookie);
}

function signIn(person: TrustedAccount): Promise<string> {
  return signInTrustedAccount(target().baseUrl, target().config.publicOrigin, person);
}

function tokenOfCookie(cookie: string): string {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const token = decodeURIComponent(value).split(".")[0] ?? "";
  assert.notEqual(token.length, 0, "the session cookie carries a token");
  return token;
}

async function storedSessions(userId: string): Promise<{ id: string; token: string }[]> {
  return await target()
    .database.db.select({ id: session.id, token: session.token })
    .from(session)
    .where(eq(session.userId, userId));
}

async function sessionIdOfCookie(cookie: string): Promise<string> {
  const token = tokenOfCookie(cookie);
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.token, token));
  const row = rows[0];
  assert.ok(row, "the session behind the cookie exists");
  return row.id;
}

async function sessionUser(cookie: string): Promise<string | null> {
  const response = await adminGet(target(), SESSION_PATH, cookie);
  assertStatus(response, 200, "reading the session answers");
  const body = (await response.json()) as { user?: { id?: string } } | null;
  return body?.user?.id ?? null;
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member lists only their own sessions and the current one is marked", async () => {
  const first = await trustedSession(fixtureOf(), { name: "Own Sessions Member" });
  const second = await trustedSession(fixtureOf(), { name: "Other Sessions Member" });
  const firstStored = await storedSessions(first.userId);
  const secondStored = await storedSessions(second.userId);

  const response = await listSessions(first.cookie);
  assertStatus(response, 200, "the member reads their own sessions");
  const text = await response.text();
  const body = JSON.parse(text) as SessionList;

  assert.deepEqual(
    body.sessions.map((row) => row.id),
    firstStored.map((row) => row.id),
    "only the caller's sessions are listed",
  );
  const [own] = body.sessions;
  assert.ok(own, "the caller's session is listed");
  assert.deepEqual(Object.keys(own).sort(), ["current", "id", "ipAddress", "lastUsedAt", "startedAt", "userAgent"]);
  assert.equal(own.current, true, "the session behind the cookie is marked");
  assert.equal(own.id, await sessionIdOfCookie(first.cookie), "the marked session is the caller's");
  for (const token of [...firstStored, ...secondStored].map((row) => row.token)) {
    assert.equal(text.includes(token), false, "no token reaches the response");
  }

  const secondAnswer = await listSessions(second.cookie);
  assertStatus(secondAnswer, 200, "the other member reads their own sessions");
  const secondBody = (await secondAnswer.json()) as SessionList;
  assert.deepEqual(
    secondBody.sessions.map((row) => row.id),
    secondStored.map((row) => row.id),
    "the other member sees their own session and never the first one",
  );
});

integration("a member cannot revoke a session of another account", async () => {
  const attacker = await trustedSession(fixtureOf(), { name: "Revocation Attacker" });
  const victim = await trustedSession(fixtureOf(), { name: "Revocation Victim" });
  const victimSessionId = await sessionIdOfCookie(victim.cookie);

  const foreign = await revokeSession(victimSessionId, attacker.cookie);
  assertStatus(foreign, 404, "a session of somebody else is not found, never forbidden");
  const foreignBody = await foreign.json();
  assert.deepEqual(foreignBody, { error: "session_not_found" });

  const unknown = await revokeSession(randomUUID(), attacker.cookie);
  assertStatus(unknown, 404, "an unknown session is refused the same way");
  assert.deepEqual(await unknown.json(), foreignBody, "the answer does not confirm that the session exists");

  assert.equal((await storedSessions(victim.userId)).length, 1, "the victim's session survives");
  assert.equal(await sessionUser(victim.cookie), victim.userId, "the victim keeps working");
  assert.equal((await storedSessions(attacker.userId)).length, 1, "the refused requests close nothing");
});

integration("a member revokes one of their own sessions and it is gone", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Partial Revocation Member" });
  const keptCookie = await signIn(member);
  const closedCookie = await signIn(member);
  const keptId = await sessionIdOfCookie(keptCookie);
  const closedId = await sessionIdOfCookie(closedCookie);
  assert.notEqual(keptId, closedId, "the two sessions are different rows");

  const response = await revokeSession(closedId, keptCookie);
  assertStatus(response, 200, "the member closes one of their sessions");
  assert.deepEqual(await response.json(), { session: { id: closedId } });

  const listed = await listSessions(keptCookie);
  assertStatus(listed, 200, "the member keeps working");
  const body = (await listed.json()) as SessionList;
  assert.deepEqual(
    body.sessions.map((row) => row.id).sort(),
    [keptId, await sessionIdOfCookie(member.cookie)].sort(),
    "the closed session is gone from the listing",
  );
  assert.equal(await sessionUser(closedCookie), null, "the closed session no longer resolves");
  assert.equal(await sessionUser(keptCookie), member.userId, "the current session keeps working");
});

integration("a member revokes the other sessions and keeps the current one", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Other Revocation Member" });
  const secondCookie = await signIn(member);
  const thirdCookie = await signIn(member);
  const currentId = await sessionIdOfCookie(member.cookie);

  const response = await revokeOtherSessions(member.cookie);
  assertStatus(response, 200, "the member closes their other sessions");
  assert.deepEqual(await response.json(), { revoked: 2 });

  const remaining = await storedSessions(member.userId);
  assert.deepEqual(
    remaining.map((row) => row.id),
    [currentId],
    "only the current session keeps its row",
  );
  for (const cookie of [secondCookie, thirdCookie]) {
    assert.equal(await sessionUser(cookie), null, "a closed session no longer resolves");
  }
  const listed = await listSessions(member.cookie);
  assertStatus(listed, 200, "the member keeps working");
  const body = (await listed.json()) as SessionList;
  assert.deepEqual(
    body.sessions.map((row) => row.id),
    [currentId],
    "the listing shows the current session alone",
  );
  assert.equal(body.sessions[0]?.current, true, "the surviving session is the current one");
});

integration("a member revoking the current session ends it", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Current Revocation Member" });
  const currentId = await sessionIdOfCookie(member.cookie);

  const response = await revokeSession(currentId, member.cookie);
  assertStatus(response, 200, "the member closes the session they are using");
  assert.deepEqual(await response.json(), { session: { id: currentId } });

  assert.deepEqual(await storedSessions(member.userId), [], "no session row survives");
  assert.equal(await sessionUser(member.cookie), null, "the closed session no longer resolves");

  const afterwards = await listSessions(member.cookie);
  assertStatus(afterwards, 401, "the closed session cannot reach the account surface");
  assert.deepEqual(await afterwards.json(), { error: "sign_in_required" });
});

integration("an anonymous caller and an unguarded mutation are refused", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Guarded Member" });
  const sessionId = await sessionIdOfCookie(member.cookie);

  const anonymousList = await adminRequest(target(), SESSIONS_PATH, { method: "GET" });
  assertStatus(anonymousList, 401, "an anonymous read is refused");
  assert.deepEqual(await anonymousList.json(), { error: "sign_in_required" });

  const anonymousMutations = await Promise.all(
    [REVOKE_OTHERS_PATH, `${SESSIONS_PATH}/${sessionId}/revoke`].map((path) =>
      adminRequest(target(), path, {
        method: "POST",
        headers: { origin: target().config.publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    ),
  );
  for (const response of anonymousMutations) {
    assertStatus(response, 401, "an anonymous mutation is refused");
    assert.deepEqual(await response.json(), { error: "sign_in_required" });
  }

  const withoutOrigin = await adminRequest(target(), REVOKE_OTHERS_PATH, {
    method: "POST",
    headers: { cookie: member.cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertStatus(withoutOrigin, 403, "a cookie mutation requires the public origin");
  assert.deepEqual(await withoutOrigin.json(), { error: "origin_not_allowed" });

  const withoutJson = await adminRequest(target(), REVOKE_OTHERS_PATH, {
    method: "POST",
    headers: { cookie: member.cookie, origin: target().config.publicOrigin, "content-type": "text/plain" },
    body: "{}",
  });
  assertStatus(withoutJson, 415, "a cookie mutation requires a JSON body");
  assert.deepEqual(await withoutJson.json(), { error: "json_content_type_required" });

  assert.equal((await storedSessions(member.userId)).length, 1, "the refused mutations close nothing");
  assert.equal(await sessionUser(member.cookie), member.userId, "the member keeps their session");
});
