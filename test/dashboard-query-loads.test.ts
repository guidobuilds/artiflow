import assert from "node:assert/strict";
import test from "node:test";

import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";

test("a slower document read does not replace the document now on screen", async () => {
  let releaseOlder: () => void = () => {};
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  const client = createQueryClient();
  const older = client.fetchQuery({
    queryKey: queryKeys.artifact.document("older"),
    queryFn: async () => {
      await olderGate;
      return { ok: true as const, value: { id: "older" } };
    },
  });
  const newer = await client.fetchQuery({
    queryKey: queryKeys.artifact.document("newer"),
    queryFn: async () => ({ ok: true as const, value: { id: "newer" } }),
  });
  releaseOlder();
  await older;
  assert.equal(newer.value.id, "newer");
  assert.deepEqual(client.getQueryData(queryKeys.artifact.document("newer")), { ok: true, value: { id: "newer" } });
  assert.deepEqual(client.getQueryData(queryKeys.artifact.document("older")), { ok: true, value: { id: "older" } });
});

test("an oauth resume key is the search string, so a newer link does not read the previous attempt", async () => {
  const client = createQueryClient();
  await client.fetchQuery({
    queryKey: queryKeys.auth.oauthResume("?client_id=first"),
    queryFn: async () => "first",
  });
  assert.equal(client.getQueryData(queryKeys.auth.oauthResume("?client_id=second")), undefined);
});
