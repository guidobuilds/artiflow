import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  FREEZE_INTERVAL_MS,
  FREEZE_OPERATION_THRESHOLD,
  applyOperations,
  applyOperationsAndFreeze,
  freezeIfDue,
  openDraft,
  publish,
  textAt,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const PUBLISHED = "# Published\n\nbody";
const digitOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type FakeRevision = SnapshotRecord & { id: string; revision: number };
type FakeOperation = OperationRecord & { id: string };

function fakeStorage(): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const providerError = (status: number): Error =>
    Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Uint8Array.from(command.input.Body as Uint8Array));
        return {};
      }
      if (name === "GetObjectCommand") {
        if (!stored) throw providerError(404);
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield stored;
          })(),
        };
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
  };
}

function fakeStore(seed: { artifactId: string; publishedSeq?: number; snapshotText?: string } = { artifactId: "a1" }) {
  const artifacts = new Map<string, { publishedSeq: number; currentRevisionId: string | null }>();
  const drafts = new Map<string, DraftRecord>();
  const operations: FakeOperation[] = [];
  const revisions: FakeRevision[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const store: DocumentStore = {
    async readArtifact(artifactId: string): Promise<ArtifactDocumentState | null> {
      const artifact = artifacts.get(artifactId);
      if (!artifact) return null;
      const mine = revisions.filter((revision) => revision.artifactId === artifactId);
      const current = mine.find((revision) => revision.id === artifact.currentRevisionId);
      return {
        artifactId,
        publishedSeq: artifact.publishedSeq,
        currentRevisionId: artifact.currentRevisionId,
        revisionCount: mine.length,
        latestSnapshot: current
          ? {
              storageKey: current.storageKey,
              sha256: current.sha256,
              formatVersion: current.formatVersion,
              createdAt: current.createdAt,
            }
          : null,
      };
    },
    async readDraft(artifactId: string): Promise<DraftRecord | null> {
      return drafts.get(artifactId) ?? null;
    },
    async insertDraftIfAbsent(record: DraftRecord): Promise<DraftRecord> {
      if (!drafts.has(record.artifactId)) drafts.set(record.artifactId, record);
      return drafts.get(record.artifactId) as DraftRecord;
    },
    async readOperation(artifactId: string, idempotencyKey: string): Promise<OperationRecord | null> {
      return operations.find((row) => row.artifactId === artifactId && row.idempotencyKey === idempotencyKey) ?? null;
    },
    async readSnapshotAtOrBefore(artifactId: string, seq: number) {
      const candidates = revisions
        .filter((row) => row.artifactId === artifactId && row.seqTo <= seq)
        .sort((left, right) => right.seqTo - left.seqTo || right.revision - left.revision);
      const row = candidates[0];
      return row
        ? { seqTo: row.seqTo, storageKey: row.storageKey, sha256: row.sha256, formatVersion: row.formatVersion }
        : null;
    },
    async readAppliedOperations(artifactId: string, afterSeq: number, toSeq: number): Promise<OperationRecord[]> {
      return operations
        .filter((row) => row.artifactId === artifactId && row.result === "applied")
        .filter((row) => row.seq > afterSeq && row.seq <= toSeq)
        .sort((left, right) => left.seq - right.seq);
    },
    commitOperation: (input) =>
      serial(async () => {
        if (operations.some((row) => row.idempotencyKey === input.operation.idempotencyKey))
          return { committed: false };
        if (
          input.draft &&
          operations.some(
            (row) =>
              row.artifactId === input.operation.artifactId &&
              row.result === "applied" &&
              row.seq === input.operation.seq,
          )
        )
          return { committed: false };
        operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true };
      }),
    commitSnapshot: (input) =>
      serial(async () => {
        const artifact = artifacts.get(input.revision.artifactId);
        if (!artifact) return { committed: false, revisionId: null, revisionNumber: null };
        if (
          artifact.publishedSeq !== input.expectedPublishedSeq ||
          (drafts.get(input.revision.artifactId)?.seq ?? 0) !== input.expectedDraftSeq
        )
          return { committed: false, revisionId: null, revisionNumber: null };
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisionNumber}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };
  artifacts.set(seed.artifactId, { publishedSeq: seed.publishedSeq ?? 0, currentRevisionId: null });
  return {
    store,
    artifacts,
    drafts,
    operations,
    revisions,
    seedSnapshot: (storage: Storage & { objects: Map<string, Uint8Array> }, text: string, createdAt = NOW): void => {
      const artifactId = seed.artifactId;
      const bytes = new TextEncoder().encode(text);
      const storageKey = `artifacts/revision-${revisions.length + 1}`;
      storage.objects.set(storageKey, bytes);
      const artifact = artifacts.get(artifactId) as { publishedSeq: number; currentRevisionId: string | null };
      const id = `revision-${revisions.length + 1}`;
      revisions.push({
        id,
        revision: revisions.length + 1,
        artifactId,
        formatVersion: 1,
        seqFrom: 0,
        seqTo: artifact.publishedSeq,
        sizeBytes: bytes.length,
        sha256: digitOf(bytes),
        storageKey,
        blockIndex: null,
        createdAt,
      });
      artifact.currentRevisionId = id;
    },
  };
}

const draftOf = (store: ReturnType<typeof fakeStore>, artifactId = "a1"): DraftRecord => {
  const draft = store.drafts.get(artifactId);
  assert.ok(draft, "the draft exists");
  return draft;
};
const textOf = (store: ReturnType<typeof fakeStore>, artifactId = "a1"): string => {
  const state = draftOf(store, artifactId).state as { text: string };
  return state.text;
};

test("openDraft materialises a draft from the current snapshot at the published sequence", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 3 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED);
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.value, { artifactId: "a1", seq: 3, formatVersion: 1, text: PUBLISHED });
  assert.equal(draftOf(seeded).seq, 3, "the draft starts at the published sequence");
  const reopened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.equal(reopened.ok && reopened.value.text, PUBLISHED);
  assert.equal(seeded.drafts.size, 1, "the draft is materialised once");
});

test("openDraft on a document with no snapshot starts empty at sequence zero and refuses an unknown artifact", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.deepEqual(opened, { ok: true, value: { artifactId: "a1", seq: 0, formatVersion: 1, text: "" } });
  const missing = await openDraft({ store: seeded.store, storage, artifactId: "nope" });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.kind, "not_found");
});

test("applyOperations appends exactly one operation row and advances the draft with the applied count", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "# First" }],
    now: NOW,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  if (!applied.ok) return;
  assert.deepEqual(applied.value, { artifactId: "a1", seq: 1, applied: 1, replayed: false });
  assert.equal(seeded.operations.length, 1, "one row per accepted write");
  const row = seeded.operations[0] as FakeOperation;
  assert.deepEqual(
    [row.seq, row.baseSeq, row.result, row.authorKind, row.authorId, row.idempotencyKey],
    [1, 0, "applied", "agent", "agent-1", "key-1"],
  );
  assert.deepEqual(row.ops, [{ op: "append_blocks", text: "# First" }], "the typed operations are stored as sent");
  assert.equal(textOf(seeded), "# First");
  assert.equal(draftOf(seeded).seq, 1);
});

test("applyOperations with a stale baseSeq refuses and reports the current sequence", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const base = {
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person" as const,
    authorId: "u1",
    now: NOW,
  };
  await applyOperations({ ...base, baseSeq: 0, idempotencyKey: "key-1", ops: [{ op: "append_blocks", text: "one" }] });
  const stale = await applyOperations({
    ...base,
    baseSeq: 0,
    idempotencyKey: "key-2",
    ops: [{ op: "append_blocks", text: "two" }],
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.kind, "concurrent_edit");
  assert.equal(stale.currentSeq, 1, "the refusal carries the current sequence");
  assert.equal(seeded.operations.length, 1, "a refused write appends no row");
  assert.equal(textOf(seeded), "one");
});

test("replaying the same idempotencyKey applies once and appends one row", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const input = {
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent" as const,
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "same-key",
    ops: [{ op: "append_blocks" as const, text: "# Once" }],
    now: NOW,
  };
  const first = await applyOperations(input);
  const replay = await applyOperations(input);
  assert.equal(first.ok && first.value.replayed, false);
  assert.equal(replay.ok, true, replay.ok ? "" : replay.reason);
  if (!replay.ok || !first.ok) return;
  assert.deepEqual(replay.value, { artifactId: "a1", seq: 1, applied: 1, replayed: true });
  assert.equal(seeded.operations.length, 1, "the replay adds no row");
  assert.equal(textOf(seeded), "# Once", "the text is applied exactly once");
});

test("a rejected batch appends a rejected row and changes nothing else", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const before = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "kept" }],
    now: NOW,
  });
  assert.equal(before.ok, true);
  const rejected = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 1,
    idempotencyKey: "key-2",
    ops: [
      { op: "replace_text", find: "kept", replace: "changed" },
      { op: "replace_text", find: "absent", replace: "nothing" },
    ],
    now: NOW,
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.kind, "operation_rejected");
  assert.equal(rejected.reason, "text_not_found");
  assert.equal(rejected.opIndex, 1);
  assert.equal(seeded.operations.length, 2);
  assert.equal(seeded.operations[1]?.result, "rejected");
  assert.equal(draftOf(seeded).seq, 1, "the rejected batch does not advance the sequence");
  assert.equal(textOf(seeded), "kept", "the rejected batch does not change the text");
  const emptied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 1,
    idempotencyKey: "key-3",
    ops: [{ op: "replace_document", text: "" }],
    now: NOW,
  });
  assert.equal(emptied.ok, false);
  if (emptied.ok) return;
  assert.equal(emptied.kind, "operation_rejected");
  assert.equal(emptied.reason, "empty_document");
  assert.equal(seeded.operations.length, 3);
  assert.equal(seeded.operations[2]?.result, "rejected");
  assert.equal(draftOf(seeded).seq, 1, "the emptied batch does not advance the sequence");
  assert.equal(textOf(seeded), "kept", "the emptied batch does not change the text");
  assert.equal(storage.objects.size, 0, "an empty document never reaches storage");
});

test("freezeIfDue waits below both thresholds", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "# One" }],
    now: NOW,
  });
  const early = await freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(early.ok, true, early.ok ? "" : early.reason);
  if (!early.ok) return;
  assert.equal(early.value.frozen, false);
  assert.equal(seeded.revisions.length, 0);
  assert.equal(storage.objects.size, 0, "nothing is written before a snapshot is due");
});

test("freezeIfDue snapshots at the operation threshold and moves both pointers in one step", async () => {
  assert.equal(FREEZE_OPERATION_THRESHOLD, 100);
  assert.equal(FREEZE_INTERVAL_MS, 600_000);
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  for (let index = 1; index <= 99; index += 1) {
    const applied = await applyOperations({
      store: seeded.store,
      storage,
      artifactId: "a1",
      authorKind: "agent",
      authorId: "agent-1",
      baseSeq: index - 1,
      idempotencyKey: `key-${index}`,
      ops: [{ op: "append_blocks", text: `line ${index}` }],
      now: NOW,
    });
    assert.equal(applied.ok, true);
  }
  const below = await freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(below.ok && below.value.frozen, false, "99 operations are below the threshold");
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 99,
    idempotencyKey: "key-100",
    ops: [{ op: "append_blocks", text: "line 100" }],
    now: NOW,
  });
  assert.equal(applied.ok, true);
  const frozen = await freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.reason);
  if (!frozen.ok) return;
  assert.equal(frozen.value.frozen, true);
  assert.equal(frozen.value.revisionNumber, 1);
  assert.equal(seeded.revisions.length, 1);
  const revision = seeded.revisions[0] as FakeRevision;
  assert.deepEqual([revision.seqFrom, revision.seqTo, revision.formatVersion], [1, 100, 1]);
  assert.equal(Object.keys(revision.blockIndex as Record<string, unknown>).length > 0, true, "the block index travels");
  assert.equal(seeded.artifacts.get("a1")?.publishedSeq, 100, "publishedSeq moves with the snapshot");
  assert.equal(seeded.artifacts.get("a1")?.currentRevisionId, revision.id, "the pointer moves in the same step");
  const stored = storage.objects.get(revision.storageKey);
  assert.ok(stored, "the canonical text reaches storage");
  assert.equal(digitOf(stored), revision.sha256);
  assert.equal(new TextDecoder().decode(stored), textOf(seeded), "the stored object is the canonical markdown");
});

test("freezeIfDue is idempotent under two concurrent calls", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  for (let index = 1; index <= 100; index += 1) {
    await applyOperations({
      store: seeded.store,
      storage,
      artifactId: "a1",
      authorKind: "agent",
      authorId: "agent-1",
      baseSeq: index - 1,
      idempotencyKey: `key-${index}`,
      ops: [{ op: "append_blocks", text: `line ${index}` }],
      now: NOW,
    });
  }
  const [first, second] = await Promise.all([
    freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW }),
    freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual([first.value.frozen, second.value.frozen].sort(), [false, true], "exactly one call freezes");
  assert.equal(seeded.revisions.length, 1, "two concurrent calls produce one snapshot");
  assert.equal(seeded.artifacts.get("a1")?.publishedSeq, 100);
});

test("freezeIfDue snapshots after the ten minute window since the last snapshot", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 1 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED, new Date(NOW.getTime() - FREEZE_INTERVAL_MS - 1));
  await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "u1",
    baseSeq: 1,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "# One" }],
    now: NOW,
  });
  const frozen = await freezeIfDue({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok && frozen.value.frozen, true, "the elapsed window is enough");
});

test("publish freezes below the threshold", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "# Published now" }],
    now: NOW,
  });
  const frozen = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.reason);
  if (!frozen.ok) return;
  assert.equal(frozen.value.frozen, true);
  assert.equal(seeded.artifacts.get("a1")?.publishedSeq, 1);
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.equal(opened.ok && opened.value.seq, 1, "the draft sequence survives the freeze");
});

test("a duplicate idempotency key refused by the store is replayed, never applied twice", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const input = {
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent" as const,
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "racy-key",
    ops: [{ op: "append_blocks" as const, text: "# Racy" }],
    now: NOW,
  };
  const [first, second] = await Promise.all([applyOperations(input), applyOperations(input)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(seeded.operations.length, 1, "only one row is appended");
  assert.deepEqual([first.ok, second.ok], [true, true]);
});

test("textAt resolves the published sequence, an intermediate one and the live draft", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 3 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED);
  for (const index of [4, 5]) {
    const applied = await applyOperations({
      store: seeded.store,
      storage,
      artifactId: "a1",
      authorKind: "agent",
      authorId: "agent-1",
      baseSeq: index - 1,
      idempotencyKey: `key-${index}`,
      ops: [{ op: "append_blocks", text: `line ${index}` }],
      now: NOW,
    });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  }
  const atPublished = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 3 });
  assert.deepEqual(atPublished, {
    ok: true,
    value: { artifactId: "a1", seq: 3, formatVersion: 1, text: PUBLISHED },
  });
  const atFour = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 4 });
  assert.equal(atFour.ok, true);
  if (atFour.ok) assert.equal(atFour.value.text, `${PUBLISHED}\n\nline 4`);
  const atDraft = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 5 });
  assert.equal(atDraft.ok && atDraft.value.text, textOf(seeded), "the live draft is the current sequence");
  const ahead = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 6 });
  assert.equal(ahead.ok, false);
  if (ahead.ok) return;
  assert.equal(ahead.kind, "validation");
  assert.equal(ahead.reason, "sequence_ahead_of_the_draft");
  assert.equal(ahead.currentSeq, 5);
});

test("textAt replays from the nearest snapshot instead of rescanning the whole log", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const base = { store: seeded.store, storage, artifactId: "a1", authorKind: "agent" as const, authorId: "agent-1" };
  for (const index of [1, 2, 3]) {
    await applyOperations({
      ...base,
      baseSeq: index - 1,
      idempotencyKey: `key-${index}`,
      ops: [{ op: "append_blocks", text: `line ${index}` }],
      now: NOW,
    });
  }
  const frozen = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok && frozen.value.frozen, true, "the snapshot covers the first three operations");
  await applyOperations({
    ...base,
    baseSeq: 3,
    idempotencyKey: "key-4",
    ops: [{ op: "replace_text", find: "line 1", replace: "line one" }],
    now: NOW,
  });
  const afterFreeze = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 4 });
  assert.equal(
    afterFreeze.ok && afterFreeze.value.text,
    "line one\n\nline 2\n\nline 3",
    "the replay starts at the snapshot",
  );
  const atSnapshot = await textAt({ store: seeded.store, storage, artifactId: "a1", seq: 3 });
  assert.equal(atSnapshot.ok && atSnapshot.value.text, "line 1\n\nline 2\n\nline 3");
  assert.equal(seeded.revisions.length, 1, "resolving history writes no snapshot");
});

test("publish refuses with nothing_to_publish when the draft has no pending operations", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 1 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED);
  const empty = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(empty.kind, "nothing_to_publish");
  assert.equal(empty.reason, "no_pending_operations");
  assert.equal(seeded.revisions.length, 1, "a refused publish writes no snapshot");
  assert.equal(storage.objects.size, 1, "a refused publish writes no object");
  await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 1,
    idempotencyKey: "key-1",
    ops: [{ op: "append_blocks", text: "pending" }],
    now: NOW,
  });
  const frozen = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.reason);
  if (!frozen.ok) return;
  assert.deepEqual([frozen.value.frozen, frozen.value.seqFrom, frozen.value.publishedSeq], [true, 2, 2]);
  const again = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.kind, "nothing_to_publish");
  assert.equal(seeded.revisions.length, 2, "the second publish writes no snapshot");
  assert.equal(storage.objects.size, 2, "the second publish writes no object");
});

test("a replace_document restore lands and publishes even with nothing pending", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const restored = "# Restored\n\noriginal bytes";
  seeded.seedSnapshot(storage, restored);
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.equal(opened.ok && opened.value.text, restored, "the draft starts on the revision being restored");
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "u1",
    baseSeq: 0,
    idempotencyKey: "restore-1",
    ops: [{ op: "replace_document", text: restored }],
    now: NOW,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  if (!applied.ok) return;
  assert.deepEqual([applied.value.seq, applied.value.applied], [1, 1], "the whole-text replacement lands");
  const frozen = await publish({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  assert.equal(frozen.ok && frozen.value.frozen, true, frozen.ok ? "" : frozen.reason);
  if (!frozen.ok) return;
  const revision = seeded.revisions[1] as FakeRevision;
  assert.deepEqual([revision.seqFrom, revision.seqTo], [1, 1]);
  assert.equal(revision.sha256, digitOf(new TextEncoder().encode(restored)), "the snapshot is the restored text");
  assert.equal(revision.sha256, (seeded.revisions[0] as FakeRevision).sha256, "the bytes are the pinned revision's");
  assert.equal(
    new TextDecoder().decode(storage.objects.get(revision.storageKey) as Uint8Array),
    restored,
    "the published object is the restored markdown",
  );
  assert.deepEqual([seeded.artifacts.get("a1")?.publishedSeq, frozen.value.publishedSeq], [1, 1]);
});

test("applyOperationsAndFreeze publishes on the operation that crosses the threshold", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const base = {
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent" as const,
    authorId: "agent-1",
    now: NOW,
  };
  const published: boolean[] = [];
  for (let index = 1; index <= 100; index += 1) {
    const applied = await applyOperationsAndFreeze({
      ...base,
      baseSeq: index - 1,
      idempotencyKey: `key-${index}`,
      ops: [{ op: "append_blocks", text: `line ${index}` }],
    });
    assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
    if (!applied.ok) return;
    assert.equal(applied.value.seq, index);
    published.push(applied.value.published);
    if (!applied.value.published) assert.equal(applied.value.revisionId, null);
  }
  assert.deepEqual([...new Set(published.slice(0, 99))], [false], "nothing freezes below the threshold");
  assert.equal(published[99], true, "the hundredth operation freezes");
  assert.equal(seeded.revisions.length, 1, "one snapshot covers the hundred operations");
  assert.equal(seeded.operations.length, 100, "one row per operation and no extra write");
  assert.equal(storage.objects.size, 1, "one snapshot object");
  const revision = seeded.revisions[0] as FakeRevision;
  assert.deepEqual([revision.seqFrom, revision.seqTo], [1, 100]);
  assert.equal(seeded.artifacts.get("a1")?.publishedSeq, 100);
  assert.equal(seeded.artifacts.get("a1")?.currentRevisionId, revision.id);
});
