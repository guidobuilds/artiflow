import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { session } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { adminGet, adminPost, assertStatus, startAdminHarness, type AdminHarness } from "./helpers/admin-harness.ts";
import {
  signInTrustedAccount,
  trustedSession,
  type TrustedAccount,
  type TrustedFixture,
  type TrustedSession,
} from "./helpers/trusted-accounts.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

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
type StoredSession = { id: string; token: string };

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

function sessionsPath(userId: string): string {
  return `/api/admin/users/${userId}/sessions`;
}

function revokeOnePath(userId: string, sessionId: string): string {
  return `${sessionsPath(userId)}/${sessionId}/revoke`;
}

function revokeAllPath(userId: string): string {
  return `${sessionsPath(userId)}/revoke`;
}

function listSessions(userId: string, cookie: string = actor().cookie): Promise<Response> {
  return adminGet(target(), sessionsPath(userId), cookie);
}

function revokeSession(userId: string, sessionId: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), revokeOnePath(userId, sessionId), {}, cookie);
}

function revokeAll(userId: string, cookie: string = actor().cookie): Promise<Response> {
  return adminPost(target(), revokeAllPath(userId), {}, cookie);
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

async function storedSessions(userId: string): Promise<StoredSession[]> {
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

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Session Administrator" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("an administrator lists the sessions of an account without a token", async () => {
  const subject = await trustedSession(fixtureOf(), { name: "Session Subject" });
  assert.ok(await signIn(subject), "a second session is opened");
  const stored = await storedSessions(subject.userId);
  assert.equal(stored.length, 2, "the subject holds two sessions");

  const response = await listSessions(subject.userId);
  assertStatus(response, 200, "the administrator reads the sessions of an account");
  const text = await response.text();
  const body = JSON.parse(text) as SessionList;

  assert.equal(body.sessions.length, 2, "every stored session is listed");
  assert.deepEqual(
    body.sessions.map((row) => row.id).sort(),
    stored.map((row) => row.id).sort(),
    "the listed identifiers are the stored ones and never the tokens",
  );
  for (const row of body.sessions) {
    assert.deepEqual(Object.keys(row).sort(), ["current", "id", "ipAddress", "lastUsedAt", "startedAt", "userAgent"]);
    assert.equal(row.current, false, "the administrator holds no session of this account");
    assert.equal(Number.isNaN(Date.parse(row.startedAt)), false, "the start is an instant");
    assert.equal(Number.isNaN(Date.parse(row.lastUsedAt)), false, "the last use is an instant");
  }
  for (const row of stored) assert.equal(text.includes(row.token), false, "no token reaches the response");
});

integration("the caller's own session is marked when the account is the caller's", async () => {
  const response = await listSessions(actor().userId);
  assertStatus(response, 200, "the administrator reads their own sessions");
  const body = (await response.json()) as SessionList;
  assert.equal(body.sessions.length, 1, "the administrator holds one session");
  const own = body.sessions[0];
  assert.ok(own, "the session is listed");
  assert.equal(own.current, true, "the session behind the caller's cookie is marked");
  assert.equal(own.id, await sessionIdOfCookie(actor().cookie), "the marked session is the caller's");
});

integration("revoking one session closes exactly that session and records it", async () => {
  const subject = await trustedSession(fixtureOf(), { name: "Single Revocation Subject" });
  const keptCookie = await signIn(subject);
  const closedCookie = await signIn(subject);
  const keptId = await sessionIdOfCookie(keptCookie);
  const closedId = await sessionIdOfCookie(closedCookie);
  assert.notEqual(keptId, closedId, "the two sessions are different rows");
  const closedToken = tokenOfCookie(closedCookie);

  const captured = await withAuditCapture(() => revokeSession(subject.userId, closedId));
  assertStatus(captured.result, 200, "the administrator closes one session");
  assert.deepEqual(await captured.result.json(), { session: { id: closedId } });

  const remaining = await storedSessions(subject.userId);
  assert.deepEqual(
    remaining.map((row) => row.id).sort(),
    [await sessionIdOfCookie(subject.cookie), keptId].sort(),
    "the closed row is gone and the other sessions keep their row",
  );
  assert.equal(await sessionUser(closedCookie), null, "the closed session no longer resolves");
  assert.equal(await sessionUser(keptCookie), subject.userId, "the other session keeps working");

  const events = captured.lines.filter((line) => line.event === "session.revoked");
  assert.equal(events.length, 1, "one closed session records one event");
  assert.equal(events[0]?.actorId, actor().userId);
  assert.equal(events[0]?.subjectId, subject.userId, "the event names the subject account");
  assert.equal(events[0]?.sessionId, closedId);
  assert.equal(JSON.stringify(events[0]).includes(closedToken), false, "no event carries a token");
});

integration("revoking all sessions closes every one and records it", async () => {
  const subject = await trustedSession(fixtureOf(), { name: "All Revocation Subject" });
  const secondCookie = await signIn(subject);
  const thirdCookie = await signIn(subject);
  const tokens = (await storedSessions(subject.userId)).map((row) => row.token);

  const captured = await withAuditCapture(() => revokeAll(subject.userId));
  assertStatus(captured.result, 200, "the administrator closes every session");
  assert.deepEqual(await captured.result.json(), { revoked: 3 });

  assert.deepEqual(await storedSessions(subject.userId), [], "no session row survives");
  for (const cookie of [subject.cookie, secondCookie, thirdCookie]) {
    assert.equal(await sessionUser(cookie), null, "a closed session no longer resolves");
  }

  const events = captured.lines.filter((line) => line.event === "sessions.revoked");
  assert.equal(events.length, 1, "one closure records one event");
  assert.equal(events[0]?.actorId, actor().userId);
  assert.equal(events[0]?.subjectId, subject.userId, "the event names the subject account");
  for (const token of tokens) assert.equal(JSON.stringify(events[0]).includes(token), false, "no token is logged");
});

integration("an unknown account and an unknown session are refused without a record", async () => {
  const subject = await trustedSession(fixtureOf(), { name: "Missing Subject" });
  const [stored] = await storedSessions(subject.userId);
  assert.ok(stored, "the subject holds a session");

  const captured = await withAuditCapture(async () => {
    const unknownAccount = await listSessions(randomUUID());
    const unknownSubject = await revokeAll(randomUUID());
    const unknownSession = await revokeSession(subject.userId, randomUUID());
    return { unknownAccount, unknownSubject, unknownSession };
  });

  assertStatus(captured.result.unknownAccount, 404, "an unknown account has no sessions to list");
  assert.deepEqual(await captured.result.unknownAccount.json(), { error: "user_not_found" });
  assertStatus(captured.result.unknownSubject, 404, "an unknown account has no sessions to close");
  assert.deepEqual(await captured.result.unknownSubject.json(), { error: "user_not_found" });
  assertStatus(captured.result.unknownSession, 404, "an unknown session is not found");
  assert.deepEqual(await captured.result.unknownSession.json(), { error: "session_not_found" });
  assert.deepEqual(captured.lines, [], "a refused operation records nothing");
  assert.equal((await storedSessions(subject.userId)).length, 1, "a refused operation closes nothing");
});

integration("a member is refused on every administrative session path", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Member Without Authority" });
  const sessionId = await sessionIdOfCookie(member.cookie);

  const captured = await withAuditCapture(async () => {
    const listed = await listSessions(member.userId, member.cookie);
    const closed = await revokeSession(member.userId, sessionId, member.cookie);
    const closedAll = await revokeAll(member.userId, member.cookie);
    return { listed, closed, closedAll };
  });

  for (const response of [captured.result.listed, captured.result.closed, captured.result.closedAll]) {
    assertStatus(response, 403, "session management is an administration action");
    assert.deepEqual(await response.json(), { error: "administrator_required" });
  }
  assert.deepEqual(captured.lines, [], "a refused operation records nothing");
  assert.equal((await storedSessions(member.userId)).length, 1, "the refused requests close nothing");
  assert.equal(await sessionUser(member.cookie), member.userId, "the member keeps their session");
});
