import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";
import { sessionQueryOptions } from "../apps/dashboard/src/query/session.ts";

const USER = { id: "user-1", name: "Ada", email: "ada@example.com", image: null };

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

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
    assert.equal(first.ok && first.value?.id, USER.id);
    assert.deepEqual(second, first);
    const cached = await client.fetchQuery(sessionQueryOptions);
    assert.equal(calls.length, 1);
    assert.deepEqual(cached, first);
  });
});

test("a stored session failure is the same result for every reader on that client", async () => {
  await withSessionFetch({ error: "down" }, 500, async (calls) => {
    const client = createQueryClient();
    const result = await client.fetchQuery(sessionQueryOptions);
    assert.equal(result.ok, false);
    const again = await client.fetchQuery(sessionQueryOptions);
    assert.equal(calls.length, 1);
    assert.deepEqual(again, result);
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

test("the session screens read useSession and no longer call getSession from an effect", () => {
  const files = [
    "../apps/dashboard/src/components/app/app-shell.tsx",
    "../apps/dashboard/src/AccountPage.tsx",
    "../apps/dashboard/src/ShareModal.tsx",
    "../apps/dashboard/src/ConsentPage.tsx",
    "../apps/dashboard/src/components/comments/markdown-comments.tsx",
    "../apps/dashboard/src/EditorPage.tsx",
  ];
  for (const file of files) {
    const text = source(file);
    assert.match(text, /useSession\(/, file);
    assert.doesNotMatch(text, /getSession\(/, file);
  }
  const main = source("../apps/dashboard/src/main.tsx");
  assert.match(main, /<QueryProvider>/);
  assert.match(main, /<\/QueryProvider>/);
});
