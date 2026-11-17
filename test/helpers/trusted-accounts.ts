import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import type { Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import { account, user } from "../../apps/api/src/adapters/postgres/db/schema.ts";

const SIGN_IN_PATH = "/api/auth/sign-in/email";
const REQUEST_TIMEOUT_MS = 10_000;

export type TrustedAccountInit = { email?: string; name?: string; password?: string };
export type TrustedAccount = { email: string; name: string; password: string; userId: string };
export type TrustedSession = TrustedAccount & { cookie: string };

export type TrustedFixture = { database: Database; baseUrl: string; origin: string };

function sessionCookie(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.includes("session_token")) ?? ""
  );
}

export async function seedTrustedAccount(
  database: Database,
  init: TrustedAccountInit = {},
): Promise<TrustedAccount> {
  const userId = randomUUID();
  const email = (init.email ?? `fixture-${userId}@example.test`).trim().toLowerCase();
  const name = init.name ?? "Fixture Owner";
  const password = init.password ?? `fixture-password-${randomUUID()}`;
  const now = new Date();
  await database.db
    .insert(user)
    .values({ id: userId, name, email, emailVerified: false, createdAt: now, updatedAt: now });
  await database.db.insert(account).values({
    id: randomUUID(),
    userId,
    providerId: "credential",
    accountId: userId,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  return { email, name, password, userId };
}

export async function signInTrustedAccount(
  baseUrl: string,
  origin: string,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await fetch(`${baseUrl}${SIGN_IN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const detail =
    response.status === 200
      ? ""
      : ` (status ${response.status}): ${await response
          .clone()
          .text()
          .catch(() => "<body unreadable>")}`;
  assert.equal(response.status, 200, `the trusted identity signs in over the public route${detail}`);
  const cookie = sessionCookie(response);
  assert.equal(cookie.length > 0, true, "a successful sign-in issues a session cookie");
  return cookie;
}

export async function trustedSession(
  fixture: TrustedFixture,
  init: TrustedAccountInit = {},
): Promise<TrustedSession> {
  const account = await seedTrustedAccount(fixture.database, init);
  return { ...account, cookie: await signInTrustedAccount(fixture.baseUrl, fixture.origin, account) };
}
