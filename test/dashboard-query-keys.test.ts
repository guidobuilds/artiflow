import assert from "node:assert/strict";
import test from "node:test";

import { createQueryClient } from "../apps/dashboard/src/query/client.ts";
import { queryKeys } from "../apps/dashboard/src/query/keys.ts";

test("an artifact prefix selects every child of that artifact and nothing of another", async () => {
  const client = createQueryClient();
  client.setQueryData(queryKeys.artifact.shares("a"), ["share-a"]);
  client.setQueryData(queryKeys.artifact.links("a"), ["link-a"]);
  client.setQueryData(queryKeys.artifact.document("a"), ["document-a"]);
  client.setQueryData(queryKeys.artifact.shares("b"), ["share-b"]);
  await client.invalidateQueries({ queryKey: queryKeys.artifact.byId("a") });
  assert.equal(client.getQueryState(queryKeys.artifact.shares("a"))?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.artifact.links("a"))?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.artifact.document("a"))?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.artifact.shares("b"))?.isInvalidated, false);
});

test("the auth prefix selects the session and the other auth reads", async () => {
  const client = createQueryClient();
  client.setQueryData(queryKeys.auth.session, { id: "user-1" });
  client.setQueryData(queryKeys.auth.capabilities, { emailPassword: true });
  client.setQueryData(queryKeys.artifact.shares("a"), ["share-a"]);
  await client.invalidateQueries({ queryKey: queryKeys.auth.all });
  assert.equal(client.getQueryState(queryKeys.auth.session)?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.auth.capabilities)?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.artifact.shares("a"))?.isInvalidated, false);
});

test("the library, account and admin prefixes stay inside their own domain", async () => {
  const client = createQueryClient();
  client.setQueryData(queryKeys.library.owned, ["one"]);
  client.setQueryData(queryKeys.account.sessions, ["session-1"]);
  client.setQueryData(queryKeys.admin.invitations, ["invite-1"]);
  client.setQueryData(queryKeys.admin.sso, { enabled: false });
  await client.invalidateQueries({ queryKey: queryKeys.library.all });
  await client.invalidateQueries({ queryKey: queryKeys.account.all });
  assert.equal(client.getQueryState(queryKeys.library.owned)?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.account.sessions)?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.admin.invitations)?.isInvalidated, false);
  await client.invalidateQueries({ queryKey: queryKeys.admin.all });
  assert.equal(client.getQueryState(queryKeys.admin.invitations)?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.admin.sso)?.isInvalidated, true);
});
