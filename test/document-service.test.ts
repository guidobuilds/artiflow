import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { SCENE_FORMAT_VERSION, canonicalScene, sceneBlockIndex, sceneBytes, type Scene } from "@artiflow/domain/scene";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  FREEZE_INTERVAL_MS,
  FREEZE_OPERATION_THRESHOLD,
  applyOperations,
  applyOperationsAndFreeze,
  freezeIfDue,
  openDraft,
  publish,
  restoreDocument,
  textAt,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const PUBLISHED = "# Published\n\nbody";
const CANVAS_SCENE: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "f1",
      name: "Home",
      x: 100,
      y: 50,
      w: 200,
      h: 100,
      nodes: [{ id: "n1", type: "rect", x: 10, y: 20, w: 30, h: 40, fill: "#ffffff" }],
    },
  ],
};
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

function fakeStore(
  seed: { artifactId: string; publishedSeq?: number; snapshotText?: string; kind?: string } = { artifactId: "a1" },
) {
  const artifacts = new Map<string, { publishedSeq: number; currentRevisionId: string | null; kind: string }>();
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
        kind: artifact.kind,
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
          (drafts.get(input.revision.artifactId)?.seq ?? artifact.publishedSeq) !== input.expectedDraftSeq
        )
          return { committed: false, revisionId: null, revisionNumber: null };
        if (input.operation) {
          if (operations.some((row) => row.idempotencyKey === input.operation?.idempotencyKey))
            return { committed: false, revisionId: null, revisionNumber: null };
          operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        }
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisionNumber}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };
  artifacts.set(seed.artifactId, {
    publishedSeq: seed.publishedSeq ?? 0,
    currentRevisionId: null,
    kind: seed.kind ?? "markdown",
  });
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
      const artifact = artifacts.get(artifactId) as {
        publishedSeq: number;
        currentRevisionId: string | null;
        kind: string;
      };
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
  assert.deepEqual(opened.value, {
    artifactId: "a1",
    seq: 3,
    formatVersion: 1,
    kind: "markdown",
    text: PUBLISHED,
    scene: null,
  });
  assert.equal(draftOf(seeded).seq, 3, "the draft starts at the published sequence");
  const reopened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.equal(reopened.ok && reopened.value.text, PUBLISHED);
  assert.equal(seeded.drafts.size, 1, "the draft is materialised once");
});

test("openDraft on a document with no snapshot starts empty at sequence zero and refuses an unknown artifact", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "a1" });
  assert.deepEqual(opened, {
    ok: true,
    value: { artifactId: "a1", seq: 0, formatVersion: 1, kind: "markdown", text: "", scene: null },
  });
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
  assert.deepEqual(applied.value, { artifactId: "a1", seq: 1, applied: 1, replayed: false, boxes: [], violations: [] });
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
  assert.deepEqual(replay.value, { artifactId: "a1", seq: 1, applied: 1, replayed: true, boxes: [], violations: [] });
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

test("a lost commit race refuses with the current sequence and leaves the winner's draft alone", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const base = { storage, artifactId: "a1", authorKind: "person" as const, authorId: "u1", now: NOW };
  const winner = await applyOperations({
    ...base,
    store: seeded.store,
    baseSeq: 0,
    idempotencyKey: "winner",
    ops: [{ op: "append_blocks", text: "# Winner" }],
  });
  assert.equal(winner.ok, true);
  let reads = 0;
  const racy: DocumentStore = {
    ...seeded.store,
    commitOperation: async () => ({ committed: false }),
    readOperation: async (artifactId, idempotencyKey) => {
      reads += 1;
      return reads === 1 ? null : seeded.store.readOperation(artifactId, idempotencyKey);
    },
  };
  const lost = await applyOperations({
    ...base,
    store: racy,
    baseSeq: 1,
    idempotencyKey: "loser",
    ops: [{ op: "append_blocks", text: "# Loser" }],
  });
  assert.equal(lost.ok, false);
  if (lost.ok) return;
  assert.equal(lost.kind, "concurrent_edit");
  assert.equal(lost.reason, "sequence_taken");
  assert.equal(lost.currentSeq, 1, "the refusal names the sequence the winner reached");
  assert.equal(seeded.operations.length, 1, "the loser appends no row");
  assert.equal(textOf(seeded), "# Winner", "the winner's draft text is untouched");
});

test("restoreDocument records the pinned text as one operation and one snapshot", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const pinned = "# Restored\n\noriginal bytes";
  seeded.seedSnapshot(storage, pinned);
  const restored = await restoreDocument({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "restore-1",
    text: pinned,
    now: NOW,
  });
  assert.equal(restored.ok, true, restored.ok ? "" : restored.reason);
  if (!restored.ok) return;
  assert.deepEqual(
    [restored.value.seq, restored.value.publishedSeq, restored.value.seqFrom, restored.value.seqTo],
    [1, 1, 1, 1],
    "the restore is one operation published at once",
  );
  assert.equal(restored.value.revisionNumber, 2);
  assert.equal(seeded.operations.length, 1, "the restore appends one operation row");
  const operation = seeded.operations[0] as FakeOperation;
  assert.deepEqual([operation.seq, operation.baseSeq, operation.result], [1, 0, "applied"]);
  assert.deepEqual(operation.ops, [{ op: "replace_document", text: pinned }]);
  const revision = seeded.revisions[1] as FakeRevision;
  assert.equal(restored.value.revisionId, revision.id);
  assert.equal(revision.sha256, digitOf(new TextEncoder().encode(pinned)));
  assert.equal(revision.sha256, (seeded.revisions[0] as FakeRevision).sha256, "the pinned digest is preserved");
  assert.equal(
    new TextDecoder().decode(storage.objects.get(revision.storageKey) as Uint8Array),
    pinned,
    "the published object is the restored markdown",
  );
  assert.deepEqual(
    [seeded.artifacts.get("a1")?.publishedSeq, seeded.artifacts.get("a1")?.currentRevisionId],
    [1, revision.id],
  );
  assert.equal(textOf(seeded), pinned, "the draft moved with the snapshot");
  assert.equal(draftOf(seeded).seq, 1);
});

test("restoreDocument refuses an unpublished draft and names the sequence it would have destroyed", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED);
  const pending = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "someone-else",
    baseSeq: 0,
    idempotencyKey: "pending-1",
    ops: [{ op: "append_blocks", text: "their edit" }],
    now: NOW,
  });
  assert.equal(pending.ok, true);
  const text = textOf(seeded);
  const refused = await restoreDocument({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "restore-1",
    text: PUBLISHED,
    now: NOW,
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.kind, "concurrent_edit");
  assert.equal(refused.reason, "pending_changes");
  assert.equal(refused.currentSeq, 1);
  assert.equal(seeded.operations.length, 1, "the refusal appends no operation row");
  assert.equal(seeded.revisions.length, 1, "the refusal writes no snapshot");
  assert.equal(storage.objects.size, 1, "the refusal stores no object");
  assert.equal(textOf(seeded), text, "the unpublished edit survives");
});

test("a restore that loses the snapshot race moves no row, pointer or draft", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, PUBLISHED);
  const pinned = seeded.revisions[0] as FakeRevision;
  const refusing: DocumentStore = {
    ...seeded.store,
    commitSnapshot: async () => ({ committed: false, revisionId: null, revisionNumber: null }),
  };
  const lost = await restoreDocument({
    store: refusing,
    storage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "restore-lost",
    text: "# Competing",
    now: NOW,
  });
  assert.equal(lost.ok, false);
  if (lost.ok) return;
  assert.equal(lost.kind, "concurrent_edit");
  assert.equal(lost.reason, "snapshot_raced");
  assert.equal(lost.currentSeq, 0, "the refusal names the sequence the draft is still at");
  assert.equal(seeded.operations.length, 0, "no operation row without the snapshot");
  assert.equal(seeded.drafts.size, 0, "no draft row without the snapshot");
  assert.equal(seeded.revisions.length, 1, "no snapshot without the operation");
  assert.deepEqual(
    [seeded.artifacts.get("a1")?.publishedSeq, seeded.artifacts.get("a1")?.currentRevisionId],
    [0, pinned.id],
    "both pointers stayed on the pinned revision",
  );
  assert.equal(storage.objects.size, 2, "only the object bytes are orphaned for the sweep to collect");
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
    value: { artifactId: "a1", seq: 3, formatVersion: 1, kind: "markdown", text: PUBLISHED, scene: null },
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

const canvasSceneOf = (store: ReturnType<typeof fakeStore>, artifactId = "c1"): Scene => {
  const state = draftOf(store, artifactId).state as { scene: Scene };
  return state.scene;
};

test("a canvas draft opens from the published scene snapshot at the published sequence", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(
    [opened.value.seq, opened.value.kind, opened.value.formatVersion],
    [3, "canvas", SCENE_FORMAT_VERSION],
  );
  assert.deepEqual(opened.value.scene, CANVAS_SCENE, "the draft carries the scene, not the bytes");
  assert.equal(opened.value.text, canonicalScene(CANVAS_SCENE), "the draft text is the canonical scene text");
  assert.deepEqual(draftOf(seeded, "c1").state, { formatVersion: SCENE_FORMAT_VERSION, scene: CANVAS_SCENE });
  const again = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.deepEqual(again.ok && again.value.scene, CANVAS_SCENE, "the draft is materialised once");
});

test("a canvas draft with no snapshot starts from an empty scene", async () => {
  const seeded = fakeStore({ artifactId: "c1", kind: "canvas" });
  const storage = fakeStorage();
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.value.scene, { formatVersion: SCENE_FORMAT_VERSION, frames: [] });
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "u1",
    baseSeq: 0,
    idempotencyKey: "canvas-1",
    ops: [
      {
        op: "add_frame",
        frame: {
          id: "f1",
          name: "Home",
          x: 0,
          y: 0,
          w: 200,
          h: 100,
          nodes: [{ id: "n1", type: "rect", x: 10, y: 20, w: 30, h: 40, fill: "#ffffff" }],
        },
      },
    ],
    now: NOW,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  if (!applied.ok) return;
  assert.deepEqual(applied.value.boxes, [{ id: "n1", frameId: "f1", x: 10, y: 20, w: 30, h: 40 }]);
  assert.deepEqual(
    canvasSceneOf(seeded).frames.map((frame) => frame.id),
    ["f1"],
  );
});

test("one canvas batch appends one operation row and returns the touched boxes and violations", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const ops = [
    { op: "add_node", frameId: "f1", node: { id: "n2", type: "rect", x: 5, y: 6, w: 7, h: 8, fill: "#0af" } },
  ] as const;
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 3,
    idempotencyKey: "canvas-1",
    ops: [...ops],
    now: NOW,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  if (!applied.ok) return;
  assert.deepEqual(applied.value, {
    artifactId: "c1",
    seq: 4,
    applied: 1,
    replayed: false,
    boxes: [{ id: "n2", frameId: "f1", x: 105, y: 56, w: 7, h: 8 }],
    violations: [],
  });
  assert.equal(seeded.operations.length, 1, "one row per accepted write");
  assert.deepEqual(seeded.operations[0]?.ops, [...ops], "the typed operations are stored as sent");
  assert.deepEqual(
    canvasSceneOf(seeded).frames[0]?.nodes.map((node) => node.id),
    ["n1", "n2"],
  );
  assert.equal(draftOf(seeded, "c1").seq, 4);
});

test("a stale canvas base refuses with the current sequence and appends no row", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const base = {
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person" as const,
    authorId: "u1",
    now: NOW,
  };
  const first = await applyOperations({
    ...base,
    baseSeq: 3,
    idempotencyKey: "canvas-1",
    ops: [{ op: "move_node", id: "n1", x: 40, y: 30 }],
  });
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  const before = canonicalScene(canvasSceneOf(seeded));
  const stale = await applyOperations({
    ...base,
    baseSeq: 3,
    idempotencyKey: "canvas-2",
    ops: [{ op: "move_node", id: "n1", x: 0, y: 0 }],
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.kind, "concurrent_edit");
  assert.equal(stale.reason, "base_sequence_is_stale");
  assert.equal(stale.currentSeq, 4);
  assert.equal(seeded.operations.length, 1, "a refused write appends no row");
  assert.equal(canonicalScene(canvasSceneOf(seeded)), before, "the draft scene is untouched");
});

test("a canvas idempotency replay applies once and appends one row", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const input = {
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "agent" as const,
    authorId: "agent-1",
    baseSeq: 3,
    idempotencyKey: "canvas-same",
    ops: [{ op: "move_node" as const, id: "n1", x: 40, y: 30 }],
    now: NOW,
  };
  const first = await applyOperations(input);
  const replay = await applyOperations(input);
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  assert.equal(replay.ok, true, replay.ok ? "" : replay.reason);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.replayed, false);
  assert.deepEqual(replay.value, {
    artifactId: "c1",
    seq: 4,
    applied: 1,
    replayed: true,
    boxes: [],
    violations: [],
  });
  assert.equal(seeded.operations.length, 1, "the replay adds no row");
  assert.deepEqual(
    canvasSceneOf(seeded).frames[0]?.nodes[0],
    { id: "n1", type: "rect", x: 40, y: 30, w: 30, h: 40, fill: "#ffffff" },
    "the scene is applied exactly once",
  );
});

test("a rejected canvas batch names the failing index and leaves the scene byte-identical", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const opened = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.equal(opened.ok, true);
  const before = canonicalScene(canvasSceneOf(seeded));
  const rejected = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 3,
    idempotencyKey: "canvas-rejected",
    ops: [
      { op: "move_node", id: "n1", x: 40, y: 30 },
      { op: "move_node", id: "n1", x: 500, y: 0 },
    ],
    now: NOW,
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.kind, "operation_rejected");
  assert.equal(rejected.reason, "outside_frame_bounds");
  assert.equal(rejected.opIndex, 1);
  assert.equal(rejected.currentSeq, 3);
  assert.equal(seeded.operations.length, 1, "the refused batch is logged");
  assert.equal(seeded.operations[0]?.result, "rejected");
  assert.equal(draftOf(seeded, "c1").seq, 3, "the rejected batch does not advance the sequence");
  assert.equal(canonicalScene(canvasSceneOf(seeded)), before, "the rejected batch does not touch the scene");
  assert.equal(seeded.revisions.length, 1, "the rejected batch writes no snapshot");
  assert.equal(storage.objects.size, 1, "the rejected batch stores no object");
});

test("publishing a canvas writes the canonical scene bytes with the scene index as the block index", async () => {
  const seeded = fakeStore({ artifactId: "c1", publishedSeq: 3, kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const applied = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 3,
    idempotencyKey: "canvas-1",
    ops: [{ op: "add_node", frameId: "f1", node: { id: "n2", type: "text", x: 5, y: 6, w: 20, h: 10, text: "hi" } }],
    now: NOW,
  });
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  const frozen = await publish({ store: seeded.store, storage, artifactId: "c1", now: NOW });
  assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.reason);
  if (!frozen.ok) return;
  const scene = canvasSceneOf(seeded);
  const revision = seeded.revisions[1] as FakeRevision;
  assert.deepEqual([revision.seqFrom, revision.seqTo], [4, 4]);
  assert.equal(frozen.value.sha256, digitOf(sceneBytes(scene)), "the snapshot is the canonical scene");
  assert.equal(
    new TextDecoder().decode(storage.objects.get(revision.storageKey) as Uint8Array),
    canonicalScene(scene),
    "the published object is the scene JSON, not markdown",
  );
  assert.deepEqual(revision.blockIndex, sceneBlockIndex(scene), "the block index is the scene index");
  assert.deepEqual(Object.keys(revision.blockIndex as Record<string, unknown>).sort(), ["f1", "n1", "n2"]);
  assert.deepEqual(
    [seeded.artifacts.get("c1")?.publishedSeq, seeded.artifacts.get("c1")?.currentRevisionId],
    [4, revision.id],
  );
  const reopened = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.deepEqual(reopened.ok && reopened.value.scene, scene, "the published snapshot describes the same scene");
});

test("restoring a canvas applies one replace_scene and publishes the pinned scene bytes", async () => {
  const seeded = fakeStore({ artifactId: "c1", kind: "canvas" });
  const storage = fakeStorage();
  const pinned = canonicalScene(CANVAS_SCENE);
  seeded.seedSnapshot(storage, pinned);
  const pinnedRevision = seeded.revisions[0] as FakeRevision;
  const edited = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "u1",
    baseSeq: 0,
    idempotencyKey: "canvas-edit",
    ops: [{ op: "move_node", id: "n1", x: 40, y: 30 }],
    now: NOW,
  });
  assert.equal(edited.ok, true, edited.ok ? "" : edited.reason);
  const published = await publish({ store: seeded.store, storage, artifactId: "c1", now: NOW });
  assert.equal(published.ok && published.value.frozen, true, published.ok ? "" : published.reason);
  const rewound = await restoreDocument({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "canvas-restore",
    scene: CANVAS_SCENE,
    now: NOW,
  });
  assert.equal(rewound.ok, true, rewound.ok ? "" : rewound.reason);
  if (!rewound.ok) return;
  assert.deepEqual(
    [rewound.value.seq, rewound.value.publishedSeq, rewound.value.seqFrom, rewound.value.seqTo],
    [2, 2, 2, 2],
    "the restore is one operation published at once",
  );
  assert.equal(rewound.value.revisionNumber, 3);
  const operation = seeded.operations[1] as FakeOperation;
  assert.deepEqual([operation.seq, operation.baseSeq, operation.result], [2, 1, "applied"]);
  assert.deepEqual(operation.ops, [{ op: "replace_scene", scene: CANVAS_SCENE }], "one replace_scene lands");
  const revision = seeded.revisions[2] as FakeRevision;
  assert.equal(rewound.value.revisionId, revision.id);
  assert.equal(revision.sha256, pinnedRevision.sha256, "the restored bytes keep the pinned scene's digest");
  assert.equal(
    new TextDecoder().decode(storage.objects.get(revision.storageKey) as Uint8Array),
    pinned,
    "the published object is the pinned revision's scene",
  );
  assert.deepEqual(revision.blockIndex, sceneBlockIndex(CANVAS_SCENE), "the block index is the restored scene");
  assert.deepEqual(
    draftOf(seeded, "c1").state,
    { formatVersion: SCENE_FORMAT_VERSION, scene: CANVAS_SCENE },
    "the draft carries the restored scene, not bytes",
  );
  assert.equal(draftOf(seeded, "c1").seq, 2);
  assert.deepEqual(
    [seeded.artifacts.get("c1")?.publishedSeq, seeded.artifacts.get("c1")?.currentRevisionId],
    [2, revision.id],
  );
  const reopened = await openDraft({ store: seeded.store, storage, artifactId: "c1" });
  assert.deepEqual(reopened.ok && reopened.value.scene, CANVAS_SCENE, "the applier opens the restored draft");
});

test("a canvas restore refuses a text restore instead of writing a text draft", async () => {
  const seeded = fakeStore({ artifactId: "c1", kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const refusedRestore = await restoreDocument({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "canvas-restore",
    text: PUBLISHED,
    now: NOW,
  });
  assert.equal(refusedRestore.ok, false);
  if (refusedRestore.ok) return;
  assert.equal(refusedRestore.kind, "validation");
  assert.equal(refusedRestore.reason, "scene_required");
  assert.equal(seeded.operations.length, 0, "the refusal appends no operation row");
  assert.equal(seeded.revisions.length, 1, "the refusal writes no snapshot");
  assert.equal(seeded.drafts.size, 0, "the refusal writes no text draft the applier would reject");
  assert.equal(storage.objects.size, 1, "the refusal stores no object");
});

test("a canvas restore refuses an unpublished draft and leaves its scene alone", async () => {
  const seeded = fakeStore({ artifactId: "c1", kind: "canvas" });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, canonicalScene(CANVAS_SCENE));
  const edited = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "someone-else",
    baseSeq: 0,
    idempotencyKey: "canvas-edit",
    ops: [{ op: "move_node", id: "n1", x: 40, y: 30 }],
    now: NOW,
  });
  assert.equal(edited.ok, true, edited.ok ? "" : edited.reason);
  const scene = canonicalScene(canvasSceneOf(seeded));
  const refusedRestore = await restoreDocument({
    store: seeded.store,
    storage,
    artifactId: "c1",
    authorKind: "person",
    authorId: "u1",
    idempotencyKey: "canvas-restore",
    scene: CANVAS_SCENE,
    now: NOW,
  });
  assert.equal(refusedRestore.ok, false);
  if (refusedRestore.ok) return;
  assert.equal(refusedRestore.kind, "concurrent_edit");
  assert.equal(refusedRestore.reason, "pending_changes");
  assert.equal(refusedRestore.currentSeq, 1);
  assert.equal(seeded.operations.length, 1, "the refusal appends no operation row");
  assert.equal(seeded.revisions.length, 1, "the refusal writes no snapshot");
  assert.equal(canonicalScene(canvasSceneOf(seeded)), scene, "the unpublished scene survives");
});
