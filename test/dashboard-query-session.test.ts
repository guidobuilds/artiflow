import assert from "node:assert/strict";
import test from "node:test";

import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";
import { sessionQueryOptions } from "../apps/dashboard/src/query/session.ts";

const USER = { id: "user-1", name: "Ada", email: "ada@example.com", image: null };

async function withSessionFetch(body: unknown, status: number, run: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(body === null ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("one session key shares a single in-flight getSession and then the cache", async () => {
  await withSessionFetch({ user: USER }, 200, async (calls) => {
    const client = createQueryClient();
    const [first, second] = await Promise.all([
      client.fetchQuery(sessionQueryOptions),
      client.fetchQuery(sessionQueryOptions),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endsWith("/api/auth/get-session"), true);
    assert.deepEqual(first, USER);
    assert.deepEqual(second, first);
    const cached = await client.fetchQuery(sessionQueryOptions);
    assert.equal(calls.length, 1);
    assert.deepEqual(cached, first);
  });
});

test("a signed-out reader caches null and does not ask again", async () => {
  await withSessionFetch(null, 200, async (calls) => {
    const client = createQueryClient();
    assert.equal(await client.fetchQuery(sessionQueryOptions), null);
    assert.equal(await client.fetchQuery(sessionQueryOptions), null);
    assert.equal(calls.length, 1);
  });
});

test("a failed session read ends in the error state instead of cached data", async () => {
  await withSessionFetch({ error: "down" }, 500, async (calls) => {
    const client = createQueryClient();
    await assert.rejects(client.fetchQuery({ ...sessionQueryOptions, retryDelay: 0 }), /answered unexpectedly/);
    assert.equal(client.getQueryData(queryKeys.auth.session), undefined);
    assert.equal(client.getQueryState(queryKeys.auth.session)?.status, "error");
    assert.equal(calls.length, 2);
  });
});

test("a later reader asks again after a failure instead of reusing it", async () => {
  await withSessionFetch({ error: "down" }, 500, async (calls) => {
    const client = createQueryClient();
    await assert.rejects(client.fetchQuery({ ...sessionQueryOptions, retryDelay: 0 }));
    await assert.rejects(client.fetchQuery({ ...sessionQueryOptions, retryDelay: 0 }));
    assert.equal(calls.length, 4);
  });
});

test("a slower response for one artifact key does not replace another key", async () => {
  let releaseOlder: () => void = () => {};
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  const client = createQueryClient();
  const older = client.fetchQuery({
    queryKey: queryKeys.artifact.shares("artifact-older"),
    queryFn: async () => {
      await olderGate;
      return ["older-grant"];
    },
  });
  const newer = await client.fetchQuery({
    queryKey: queryKeys.artifact.shares("artifact-newer"),
    queryFn: async () => ["newer-grant"],
  });
  releaseOlder();
  assert.deepEqual(await older, ["older-grant"]);
  assert.deepEqual(newer, ["newer-grant"]);
  assert.deepEqual(client.getQueryData(queryKeys.artifact.shares("artifact-newer")), ["newer-grant"]);
  assert.deepEqual(client.getQueryData(queryKeys.artifact.shares("artifact-older")), ["older-grant"]);
});
