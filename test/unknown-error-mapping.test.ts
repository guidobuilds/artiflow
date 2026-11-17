import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactWithRevision } from "../apps/api/src/domain/commits.ts";
import type { AppDb } from "../apps/api/src/adapters/postgres/db/client.ts";

test("an unknown transaction failure is an internal error, not a conflict", async () => {
  const database = {
    transaction: async () => {
      throw new Error("driver exploded");
    },
  } as unknown as AppDb;
  const result = await createArtifactWithRevision(database, {
    ownerId: "22222222-2222-4222-8222-222222222222",
    title: null,
    kind: "html",
    revision: {
      revision: 1,
      sizeBytes: 1,
      sha256: "a".repeat(64),
      storageKey: "staging/x",
      observedSizeBytes: 1,
    },
  });
  assert.ok(!result.ok);
  assert.equal(result.kind, "error");
  assert.equal(result.reason, "commit_transaction_failed");
});
