import assert from "node:assert/strict";
import test from "node:test";

import type { AppDb } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  newRevisionStorageKey,
  REVISION_KEY_PREFIX,
  stagingStorageKey,
  type DeletedRevision,
  type StorageResult,
} from "../apps/api/src/adapters/storage/s3.ts";
import {
  REVISION_GC_GRACE_MS,
  REVISION_GC_MAX_KEYS_PER_RUN,
  sweepRevisionOrphans,
  type ExistingRevisionKeysFn,
  type RevisionSweepResult,
} from "../apps/api/src/domain/gc.ts";

const HOUR_MS = 3_600_000;
const GRACE_MS = REVISION_GC_GRACE_MS;
const NOW = new Date("2026-05-01T12:00:00.000Z");
const aged = (ageMs = 48 * HOUR_MS): Date => new Date(NOW.getTime() - ageMs);
const atCutoff = (): Date => new Date(NOW.getTime() - GRACE_MS);

type FakeObject = { lastModified: Date };
type FakeStorage = Storage & { objects: Map<string, FakeObject>; commands: string[] };
type Seed = { key: string; lastModified: Date };

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

function fakeStorage(seed: Seed[], options: { failDeletes?: readonly string[] } = {}): FakeStorage {
  const objects = new Map<string, FakeObject>(seed.map((entry) => [entry.key, { lastModified: entry.lastModified }]));
  const commands: string[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      commands.push(name);
      if (name === "ListObjectsV2Command") {
        const prefix = String(command.input.Prefix ?? "");
        const maxKeys = Number(command.input.MaxKeys ?? 1000);
        const cursor = String(command.input.ContinuationToken ?? "");
        const listed = [...objects.keys()].filter((key) => key.startsWith(prefix) && key > cursor).sort();
        const page = listed.slice(0, maxKeys);
        const truncated = listed.length > page.length;
        return {
          Contents: page.map((key) => ({ Key: key, LastModified: objects.get(key)?.lastModified, Size: 1 })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(page[page.length - 1]) : undefined,
        };
      }
      if (name === "DeleteObjectCommand") {
        const key = String(command.input.Key ?? "");
        if (options.failDeletes?.includes(key)) throw providerError(500);
        objects.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return {
    client: client as unknown as Storage["client"],
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
    objects,
    commands,
  };
}

const db = {} as AppDb;
const rowsNaming = (named: readonly string[]): { fn: ExistingRevisionKeysFn; asked: string[][] } => {
  const asked: string[][] = [];
  const fn: ExistingRevisionKeysFn = async (_db, storageKeys) => {
    asked.push([...storageKeys]);
    return storageKeys.filter((key) => named.includes(key));
  };
  return { fn, asked };
};
const freshKeys = (count: number): string[] =>
  Array.from({ length: count }, () => newRevisionStorageKey()).sort((a, b) => (a < b ? -1 : 1));
const exists = (storage: FakeStorage, key: string): boolean => storage.objects.has(key);

test("an object with no revision row that is older than the grace window is deleted", async () => {
  const [orphan] = freshKeys(1) as [string];
  const storage = fakeStorage([{ key: orphan, lastModified: aged() }]);
  const rows = rowsNaming([]);
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rows.fn });
  const expected: RevisionSweepResult = { examined: 1, candidates: 1, deleted: 1, failed: 0, listFailed: false };
  assert.deepEqual(result, expected, "the run reports exactly one examined key, one candidate, one delete");
  assert.equal(exists(storage, orphan), false, "the orphaned bytes are gone");
  assert.deepEqual(rows.asked, [[orphan]], "the row lookup ran once for the page with the aged key");
  assert.deepEqual(
    storage.commands,
    ["ListObjectsV2Command", "DeleteObjectCommand"],
    "the sweep only lists and deletes: it never reads, writes or heads an object",
  );
});

test("an object a revision row names is never deleted, however old it is", async () => {
  const [named, orphan] = freshKeys(2) as [string, string];
  const storage = fakeStorage([
    { key: named, lastModified: aged(400 * 24 * HOUR_MS) },
    { key: orphan, lastModified: aged() },
  ]);
  const rows = rowsNaming([named]);
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rows.fn });
  assert.deepEqual(result, { examined: 2, candidates: 1, deleted: 1, failed: 0, listFailed: false });
  assert.equal(exists(storage, named), true, "a named revision keeps its bytes forever");
  assert.equal(exists(storage, orphan), false, "the unnamed key of the same page is still collected");
  assert.equal(rows.asked.length, 1, "the row lookup runs once per page, never once per key");
  assert.deepEqual(rows.asked[0], [named, orphan].sort(), "one lookup carries every aged key of the page");
});

test("an object inside the grace window is kept even with no revision row, and the boundary counts as young", async () => {
  const [young, boundary] = freshKeys(2) as [string, string];
  const storage = fakeStorage([
    { key: young, lastModified: aged(HOUR_MS) },
    { key: boundary, lastModified: atCutoff() },
  ]);
  const rows = rowsNaming([]);
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rows.fn });
  assert.deepEqual(result, { examined: 2, candidates: 0, deleted: 0, failed: 0, listFailed: false });
  assert.equal(exists(storage, young), true, "a young orphan can still be claimed by its in-flight writer");
  assert.equal(
    exists(storage, boundary),
    true,
    "the grace boundary is exclusive: only strictly older keys are candidates",
  );
  assert.deepEqual(rows.asked, [], "a young key is never even looked up: by construction it has no row yet");
  assert.deepEqual(storage.commands, ["ListObjectsV2Command"], "nothing was deleted");
});

test("one failed delete neither aborts the sweep nor loses the remaining candidates", async () => {
  const [failing, healthy] = freshKeys(2) as [string, string];
  const storage = fakeStorage(
    [
      { key: failing, lastModified: aged(2 * GRACE_MS) },
      { key: healthy, lastModified: aged(2 * GRACE_MS) },
    ],
    { failDeletes: [failing] },
  );
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rowsNaming([]).fn });
  assert.deepEqual(result, { examined: 2, candidates: 2, deleted: 1, failed: 1, listFailed: false });
  assert.equal(exists(storage, healthy), false, "the candidate after the failure is still collected");
  assert.equal(exists(storage, failing), true, "the failed key stays for the next run instead of being assumed gone");
});

test("the per-run key cap bounds the work and leaves the rest of the bucket for the next run", async () => {
  const seeded = freshKeys(10);
  const storage = fakeStorage(seeded.map((key) => ({ key, lastModified: aged() })));
  const rows = rowsNaming([]);
  const result = await sweepRevisionOrphans({
    db,
    storage,
    now: NOW,
    existingRevisionKeysFn: rows.fn,
    maxKeysPerRun: 4,
  });
  assert.deepEqual(result, { examined: 4, candidates: 4, deleted: 4, failed: 0, listFailed: false });
  assert.equal(storage.objects.size, 6, "the run stops at the cap instead of sweeping the whole bucket");
  const looked = rows.asked.flat();
  assert.equal(looked.length, 4, "the row lookup is bounded by the same cap");
  assert.deepEqual([...looked].sort(), seeded.slice(0, 4), "the lookup never asks about a key the run did not examine");
});

test("the default cap pages the listing instead of loading the bucket", async () => {
  const total = Math.min(REVISION_GC_MAX_KEYS_PER_RUN, 250);
  const seeded = freshKeys(total);
  const storage = fakeStorage(seeded.map((key) => ({ key, lastModified: aged() })));
  const rows = rowsNaming([]);
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rows.fn });
  assert.equal(result.examined, total, "every key of the bounded run is examined");
  assert.equal(result.deleted, total, "every orphaned key is collected");
  assert.equal(result.failed, 0);
  assert.equal(result.listFailed, false);
  assert.deepEqual([...storage.objects.keys()], [], "the bucket's revision prefix is empty afterwards");
  assert.equal(
    storage.commands.filter((name) => name === "ListObjectsV2Command").length > 1,
    true,
    "more keys than one page are listed page by page",
  );
});

test("the sweep never deletes a key outside the revision prefix or shape", async () => {
  const revisionKey = newRevisionStorageKey();
  const foreignShape = `${REVISION_KEY_PREFIX}Not-A-Revision-Id`;
  const stagingKey = stagingStorageKey("a".repeat(64));
  const otherPrefix = "backups/2026-05-01.tar";
  const storage = fakeStorage([
    { key: revisionKey, lastModified: aged() },
    { key: foreignShape, lastModified: aged() },
    { key: stagingKey, lastModified: aged() },
    { key: otherPrefix, lastModified: aged() },
  ]);
  const rows = rowsNaming([]);
  const result = await sweepRevisionOrphans({ db, storage, now: NOW, existingRevisionKeysFn: rows.fn });
  assert.deepEqual(result, { examined: 1, candidates: 1, deleted: 1, failed: 0, listFailed: false });
  for (const key of [foreignShape, stagingKey, otherPrefix]) {
    assert.equal(exists(storage, key), true, `a non-revision key is never a delete target: ${key}`);
  }
  assert.equal(exists(storage, revisionKey), false, "the one real orphan key is collected");
  assert.deepEqual(rows.asked.flat(), [revisionKey], "the row lookup only ever receives real revision keys");
});

test("a failed listing page ends the run with no delete instead of guessing", async () => {
  const [orphan] = freshKeys(1) as [string];
  const storage = fakeStorage([{ key: orphan, lastModified: aged() }]);
  const failedList = async (): Promise<StorageResult<{ objects: never[]; nextToken: undefined }>> => ({
    ok: false,
    kind: "conflict",
    reason: "injected listing failure",
  });
  const result = await sweepRevisionOrphans({
    db,
    storage,
    now: NOW,
    existingRevisionKeysFn: rowsNaming([]).fn,
    listRevisionKeysFn: failedList as never,
  });
  assert.deepEqual(result, { examined: 0, candidates: 0, deleted: 0, failed: 0, listFailed: true });
  assert.equal(exists(storage, orphan), true, "an unreadable listing deletes nothing");
});

test("the delete seam is what failure isolation is proven against, and it receives the exact key", async () => {
  const [orphan] = freshKeys(1) as [string];
  const storage = fakeStorage([{ key: orphan, lastModified: aged() }]);
  const deleted: string[] = [];
  const result = await sweepRevisionOrphans({
    db,
    storage,
    now: NOW,
    existingRevisionKeysFn: rowsNaming([]).fn,
    deleteRevisionBytesFn: async (input): Promise<StorageResult<DeletedRevision>> => {
      deleted.push(input.storageKey);
      storage.objects.delete(input.storageKey);
      return { ok: true, value: { storageKey: input.storageKey } };
    },
  });
  assert.deepEqual(result, { examined: 1, candidates: 1, deleted: 1, failed: 0, listFailed: false });
  assert.deepEqual(deleted, [orphan], "the sweep deletes by key, never by digest or prefix");
});
