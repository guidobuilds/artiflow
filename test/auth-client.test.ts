import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getCapabilities, getSession, signIn, signOut, signUp } from "../apps/dashboard/src/auth-client.ts";

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;

function useFetch(reply: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? "null" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const header = (call: Call, name: string): string =>
  String((call.init.headers as Record<string, string> | undefined)?.[name] ?? "");

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("capabilities accept only real availability flags, drop extra keys, and never cache", async () => {
  useFetch(() => json({ emailPassword: "true", socialProviders: [] }));
  assert.equal((await getCapabilities()).ok, false);

  useFetch(() => json({ emailPassword: true, socialProviders: ["github", 7] }));
  assert.equal((await getCapabilities()).ok, false);

  useFetch(() => json({ emailPassword: true, registration: "true", socialProviders: [] }));
  assert.equal((await getCapabilities()).ok, false);

  const calls = useFetch(() =>
    json({ emailPassword: true, registration: false, socialProviders: ["github"], origin: "http://evil.test" }),
  );
  assert.deepEqual(await getCapabilities(), {
    ok: true,
    value: { emailPassword: true, registration: false, socialProviders: ["github"] },
  });
  assert.equal(calls[0]?.url, "/api/auth/capabilities");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.cache, "no-store");
  assert.equal(calls[0]?.init.credentials, "same-origin");
});

test("an older payload without the registration flag fails closed for account creation", async () => {
  useFetch(() => json({ emailPassword: true, socialProviders: ["github"] }));
  assert.deepEqual(await getCapabilities(), {
    ok: true,
    value: { emailPassword: true, registration: false, socialProviders: ["github"] },
  });

  useFetch(() => json({ emailPassword: true, registration: true, socialProviders: [] }));
  assert.deepEqual(await getCapabilities(), {
    ok: true,
    value: { emailPassword: true, registration: true, socialProviders: [] },
  });
});

test("a session rejects incomplete users and exposes only id, name and email", async () => {
  useFetch(() => json({ user: { id: "u1", name: "Ada" } }));
  assert.equal((await getSession()).ok, false);

  useFetch(() =>
    json({
      session: { token: "session-token-value" },
      user: { id: "u1", name: "Ada", email: "ada@example.test", emailVerified: true },
    }),
  );
  const result = await getSession();
  assert.deepEqual(result, { ok: true, value: { id: "u1", name: "Ada", email: "ada@example.test", image: null } });
  assert.equal(JSON.stringify(result).includes("session-token-value"), false);
});

test("a signed-out session is null, not an error", async () => {
  useFetch(() => json(null));
  assert.deepEqual(await getSession(), { ok: true, value: null });
  useFetch(() => new Response("", { status: 200 }));
  assert.deepEqual(await getSession(), { ok: true, value: null });
});

test("server and network failures never leak their own text", async () => {
  useFetch(() => json({ message: "database secret-token-abc failed" }, 500));
  const server = await getSession();
  assert.equal(server.ok, false);
  assert.equal(server.ok === false && server.error.includes("secret-token-abc"), false);

  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
  }) as typeof fetch;
  const offline = await getSession();
  assert.equal(offline.ok, false);
  assert.equal(offline.ok === false && offline.error.includes("ECONNREFUSED"), false);
});

test("sign-in confirms identity from get-session and drops the returned token", async () => {
  const calls = useFetch((_call, index) =>
    index === 0
      ? json({ token: "bearer-token-value", user: { id: "fake", name: "Fake", email: "fake@x.test" } })
      : json({ user: { id: "real", name: "Real Owner", email: "owner@example.test" } }),
  );
  const result = await signIn({ email: "owner@example.test", password: "local-password" });
  assert.deepEqual(result, {
    ok: true,
    value: { id: "real", name: "Real Owner", email: "owner@example.test", image: null },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.url, "/api/auth/get-session");
  assert.equal(JSON.stringify(result).includes("bearer-token-value"), false);
});

test("bad credentials give a static error, not the server body", async () => {
  useFetch(() => json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "no user ada@example.test" }, 401));
  const result = await signIn({ email: "ada@example.test", password: "wrong-password" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.includes("ada@example.test"), false);
});

test("sign-up and sign-out send JSON and never report unconfirmed success", async () => {
  const created = useFetch((_call, index) => (index === 0 ? json({ user: { id: "u2" } }) : json(null)));
  assert.equal((await signUp({ name: "New Owner", email: "new@example.test", password: "local-password" })).ok, false);
  assert.equal(header(created[0]!, "content-type"), "application/json");
  assert.equal(created[0]?.init.credentials, "same-origin");

  const surviving = useFetch((_call, index) =>
    index === 0 ? json({ success: true }) : json({ user: { id: "u1", name: "Ada", email: "ada@example.test" } }),
  );
  assert.equal((await signOut()).ok, false);
  assert.equal(surviving[0]?.url, "/api/auth/sign-out");
  assert.equal(surviving[0]?.init.body, "{}");
  assert.equal(surviving[0]?.init.credentials, "same-origin");

  useFetch((_call, index) => (index === 0 ? json({ success: true }) : json(null)));
  assert.deepEqual(await signOut(), { ok: true, value: null });
});

test("social sign-in posts the provider and callback and follows only a real redirect", async () => {
  const { socialSignIn } = await import("../apps/dashboard/src/auth-client.ts");
  const calls = useFetch(() => json({ redirect: true, url: "https://github.com/login/oauth/authorize?client_id=x" }));
  const result = await socialSignIn("github", "/dashboard?return=x");
  assert.deepEqual(result, { ok: true, url: "https://github.com/login/oauth/authorize?client_id=x" });
  assert.equal(calls[0]?.url, "/api/auth/sign-in/social");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { provider: "github", callbackURL: "/dashboard?return=x" });

  useFetch(() => json({ error: "no_provider" }, 400));
  const refused = await socialSignIn("github", "/");
  assert.deepEqual(refused, {
    ok: false,
    error: "The auth service answered unexpectedly. Nothing was changed.",
    restartable: false,
  });
});
