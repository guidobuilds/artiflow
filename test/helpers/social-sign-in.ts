import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { Database } from "../../apps/api/src/adapters/postgres/db/client.ts";
import { account, user } from "../../apps/api/src/adapters/postgres/db/schema.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_VALUE_MARKER = "artiflow.session_token=";

export type SocialIdentity = { userId: string; email: string; providerAccountId: string };

export type SocialFixture = { database: Database; baseUrl: string; origin: string };

type FakeIdp = { origin: string; close: () => Promise<void> };

type FakeProfile = { id: string; name: string; email: string; verified: boolean };

function startFakeIdp(profile: FakeProfile): Promise<FakeIdp> {
  const server: Server = createServer((incoming, response) => {
    incoming.resume();
    const url = incoming.url ?? "";
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (incoming.method === "POST" && url.startsWith("/login/oauth/access_token")) {
      send(200, { access_token: "fake-provider-token", token_type: "bearer", scope: "read:user,user:email" });
      return;
    }
    if (incoming.method === "GET" && url === "/user") {
      send(200, { id: profile.id, login: "fake-octo", name: profile.name, email: profile.email, avatar_url: "" });
      return;
    }
    if (incoming.method === "GET" && url === "/user/emails") {
      send(200, [{ email: profile.email, primary: true, verified: profile.verified }]);
      return;
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function routeProviderToIdp(origin: string): () => void {
  const real = globalThis.fetch;
  const realFetch = real.bind(globalThis);
  const routes: Record<string, string> = {
    "https://github.com/login/oauth/access_token": "/login/oauth/access_token",
    "https://api.github.com/user": "/user",
    "https://api.github.com/user/emails": "/user/emails",
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? "");
    const route = routes[url];
    return realFetch((route === undefined ? input : `${origin}${route}`) as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function sessionPair(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith(SESSION_VALUE_MARKER) && value.length > SESSION_VALUE_MARKER.length) ?? ""
  );
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .filter((value) => value !== "")
    .join("; ");
}

export async function seedSocialIdentity(
  database: Database,
  input: { role: "member" | "administrator"; name: string },
): Promise<SocialIdentity> {
  const userId = randomUUID();
  const providerAccountId = `gh-${randomUUID()}`;
  const email = `social-${randomUUID()}@example.test`;
  const now = new Date();
  await database.db
    .insert(user)
    .values({
      id: userId,
      name: input.name,
      email,
      emailVerified: true,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    });
  await database.db.insert(account).values({
    id: randomUUID(),
    userId,
    providerId: "github",
    accountId: providerAccountId,
    createdAt: now,
    updatedAt: now,
  });
  return { userId, email, providerAccountId };
}

export type SocialOutcome = { location: string; cookie: string; sessionPairs: string[] };

export type SocialAssertion = { emailVerified?: boolean };

export async function completeSocialSignIn(
  fixture: SocialFixture,
  identity: SocialIdentity,
  assertion: SocialAssertion = {},
): Promise<SocialOutcome> {
  const idp = await startFakeIdp({
    id: identity.providerAccountId,
    name: "Social Login",
    email: identity.email,
    verified: assertion.emailVerified !== false,
  });
  const restore = routeProviderToIdp(idp.origin);
  try {
    const begun = await fetch(`${fixture.baseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: fixture.origin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/dashboard", disableRedirect: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.equal(begun.status, 200, `the social sign-in begins: ${begun.status}`);
    const payload = (await begun.json()) as { url?: string };
    const state = new URL(String(payload.url)).searchParams.get("state");
    assert.equal(typeof state === "string" && state.length > 0, true, "the authorization URL carries a state");

    const query = new URLSearchParams({ code: "fake-authorization-code", state: String(state) });
    const response = await fetch(`${fixture.baseUrl}/api/auth/callback/github?${query.toString()}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(begun) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.equal(response.status, 302, "the callback redirects back to the application");
    const sessionPairs = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .filter((value) => value.startsWith(SESSION_VALUE_MARKER));
    return {
      location: response.headers.get("location") ?? "",
      cookie: sessionPair(response),
      sessionPairs,
    };
  } finally {
    restore();
    await idp.close();
  }
}
