import assert from "node:assert/strict";
import { test } from "node:test";

import { commentsListGate } from "../apps/api/src/routes/library.ts";

const OWNED = { storageKey: "key/one", sha256: "a".repeat(64), revisionNumber: 4 };

test("a bearer caller is refused before the session or the artifact is read", () => {
  assert.deepEqual(
    commentsListGate({ bearerPresent: true, sessionUserId: null, artifact: null }),
    { kind: "unauthorized" },
  );
  assert.deepEqual(
    commentsListGate({ bearerPresent: true, sessionUserId: "user-1", artifact: OWNED }),
    { kind: "unauthorized" },
    "the bearer header wins over a valid cookie session, as the route documents",
  );
});

test("an anonymous caller is unauthorized", () => {
  assert.deepEqual(
    commentsListGate({ bearerPresent: false, sessionUserId: null, artifact: null }),
    { kind: "unauthorized" },
  );
});

test("an artifact the caller cannot read is not found", () => {
  assert.deepEqual(
    commentsListGate({ bearerPresent: false, sessionUserId: "user-1", artifact: null }),
    { kind: "not_found" },
  );
  assert.deepEqual(
    commentsListGate({ bearerPresent: false, sessionUserId: "user-1", artifact: undefined }),
    { kind: "not_found" },
  );
});

test("an artifact without a current revision is a conflict, not a not-found", () => {
  for (const artifact of [
    { storageKey: null, sha256: "a".repeat(64), revisionNumber: 4 },
    { storageKey: "key/one", sha256: null, revisionNumber: 4 },
    { storageKey: "key/one", sha256: "a".repeat(64), revisionNumber: null },
  ]) {
    assert.deepEqual(
      commentsListGate({ bearerPresent: false, sessionUserId: "user-1", artifact }),
      { kind: "no_current_revision" },
    );
  }
});

test("an owned artifact with a current revision passes the owner through", () => {
  const gate = commentsListGate({ bearerPresent: false, sessionUserId: "user-1", artifact: OWNED });
  assert.equal(gate.kind, "ok");
  assert.deepEqual(gate, {
    kind: "ok",
    ownerId: "user-1",
    artifact: OWNED,
    storageKey: OWNED.storageKey,
    sha256: OWNED.sha256,
    revisionNumber: OWNED.revisionNumber,
  });
});
