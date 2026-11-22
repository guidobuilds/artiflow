import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { diffDocumentOperations } from "@artiflow/domain/document-operations";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  applyOperations,
  publish,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";
import { collabFlushKey, flushDocumentText } from "../apps/api/src/collab/flush.ts";

const NOW = new Date("2026-11-22T09:00:00.000Z");
const LIVE = "# Live\n\nfirst line";
const AGENT = "# Live\n\nfirst line\n\nagent paragraph";

type FakeRevision = SnapshotRecord & { id: string; revision: number };
type FakeOperation = OperationRecord & { id: string };

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

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
  const artifacts = new Map<string, { publishedSeq: number; currentRevisionId: string | null; kind: string }>();
  const drafts = new Map<string, DraftRecord>();
  const operations: FakeOperation[] = [];
  const revisions: FakeRevision[] = [];
  const hooks: Array<() => Promise<void>> = [];
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
      }).then(async (result) => {
        if (result.committed) for (const hook of hooks) await hook();
        return result;
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
    kind: "markdown",
  });
  return {
    store,
    artifacts,
    drafts,
    operations,
    revisions,
    afterCommit: (hook: () => Promise<void>): void => {
      hooks.push(hook);
    },
    seedSnapshot: (storage: Storage & { objects: Map<string, Uint8Array> }, text: string): void => {
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
        sha256: digestOf(text),
        storageKey,
        blockIndex: null,
        createdAt: NOW,
      });
      artifact.currentRevisionId = id;
    },
  };
}

type Seeded = ReturnType<typeof fakeStore>;

const textOf = (seeded: Seeded, artifactId = "a1"): string => {
  const draft = seeded.drafts.get(artifactId);
  assert.ok(draft, "the draft exists");
  return (draft.state as { text: string }).text;
};

const seqOf = (seeded: Seeded, artifactId = "a1"): number => {
  const draft = seeded.drafts.get(artifactId);
  assert.ok(draft, "the draft exists");
  return draft.seq;
};

test("one flush appends exactly one operation row and freezes nothing below the threshold", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const outcome = await flushDocumentText({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: "", seq: 0 },
    now: NOW,
  });
  assert.deepEqual(outcome, { status: "applied", seq: 1, text: LIVE, frozen: false, attempts: 1 });
  assert.equal(seeded.operations.length, 1, "one row per flush");
  const row = seeded.operations[0] as FakeOperation;
  assert.deepEqual(
    [row.seq, row.baseSeq, row.result, row.authorKind, row.authorId],
    [1, 0, "applied", "person", "person-1"],
  );
  assert.deepEqual(row.ops, diffDocumentOperations("", LIVE), "the row carries the diff from the flushed base");
  assert.equal(row.idempotencyKey, collabFlushKey({ artifactId: "a1", baseSeq: 0, text: LIVE }));
  assert.equal(seeded.revisions.length, 0, "nothing is snapshotted below the freeze threshold");
  assert.equal(textOf(seeded), LIVE);
  assert.equal(seqOf(seeded), 1);
});

test("flushing the same text twice appends nothing the second time", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const first = await flushDocumentText({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: "", seq: 0 },
    now: NOW,
  });
  assert.equal(first.status, "applied");
  const second = await flushDocumentText({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: LIVE, seq: 1 },
    now: NOW,
  });
  assert.deepEqual(second, { status: "unchanged", seq: 1 });
  assert.equal(seeded.operations.length, 1, "an empty diff appends no row");
});

test("a flush retried after a crash replays its deterministic key instead of applying twice", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const input = {
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    now: NOW,
  };
  const first = await flushDocumentText({ ...input, base: { text: "", seq: 0 } });
  assert.equal(first.status, "applied");
  const retried = await flushDocumentText({ ...input, base: { text: "", seq: 0 } });
  assert.deepEqual(retried, { status: "applied", seq: 1, text: LIVE, frozen: false, attempts: 1 });
  assert.equal(seeded.operations.length, 1, "the replay appends no second row");
});

test("a flush that loses the sequence race reloads the new base and lands once", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const agent = await applyOperations({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorKind: "agent",
    authorId: "agent-1",
    baseSeq: 0,
    idempotencyKey: "agent-key-1",
    ops: [{ op: "replace_document", text: AGENT }],
    now: NOW,
  });
  assert.equal(agent.ok, true, agent.ok ? "" : agent.reason);
  const outcome = await flushDocumentText({
    store: seeded.store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: "", seq: 0 },
    now: NOW,
  });
  assert.deepEqual(outcome, { status: "applied", seq: 2, text: LIVE, frozen: false, attempts: 2 });
  assert.equal(seeded.operations.length, 2);
  const retried = seeded.operations[1] as FakeOperation;
  assert.equal(retried.baseSeq, 1, "the retry diffs against the reloaded base");
  assert.deepEqual(retried.ops, diffDocumentOperations(AGENT, LIVE));
  assert.equal(textOf(seeded), LIVE, "the room's text survives the race");
  assert.equal(seqOf(seeded), 2);
});

test("a flush that loses the sequence race twice is reported instead of dropped", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  let nudges = 0;
  const store = {
    ...seeded.store,
    commitOperation: async (input: Parameters<typeof seeded.store.commitOperation>[0]) => {
      if (nudges < 2) {
        nudges += 1;
        const draft = seeded.drafts.get("a1");
        const nudged = await applyOperations({
          store: seeded.store,
          storage,
          artifactId: "a1",
          authorKind: "agent",
          authorId: "agent-1",
          baseSeq: draft?.seq ?? 0,
          idempotencyKey: `agent-nudge-${nudges}`,
          ops: [{ op: "append_blocks", text: `agent nudge ${nudges}` }],
          now: NOW,
        });
        assert.equal(nudged.ok, true, nudged.ok ? "" : nudged.reason);
      }
      return seeded.store.commitOperation(input);
    },
  };
  const outcome = await flushDocumentText({
    store,
    storage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: "", seq: 0 },
    now: NOW,
  });
  assert.deepEqual(outcome, { status: "failed", reason: "sequence_race_lost_twice", attempts: 2 });
  assert.equal(
    seeded.operations.filter((row) => row.authorKind === "person").length,
    0,
    "no row was appended for the losing flush",
  );
  assert.notEqual(textOf(seeded), LIVE, "the store keeps the agent's text; the room keeps its own");
});

test("the snapshot after a freeze is byte-identical to the HTTP save path for the same text", async () => {
  const viaHttp = fakeStore({ artifactId: "a1" });
  const httpStorage = fakeStorage();
  const httpApplied = await applyOperations({
    store: viaHttp.store,
    storage: httpStorage,
    artifactId: "a1",
    authorKind: "person",
    authorId: "person-1",
    baseSeq: 0,
    idempotencyKey: "http-key-1",
    ops: diffDocumentOperations("", LIVE),
    now: NOW,
  });
  assert.equal(httpApplied.ok, true, httpApplied.ok ? "" : httpApplied.reason);
  const httpPublished = await publish({ store: viaHttp.store, storage: httpStorage, artifactId: "a1", now: NOW });
  assert.equal(httpPublished.ok, true);

  const viaCollab = fakeStore({ artifactId: "a1" });
  const collabStorage = fakeStorage();
  const flushed = await flushDocumentText({
    store: viaCollab.store,
    storage: collabStorage,
    artifactId: "a1",
    authorId: "person-1",
    text: LIVE,
    base: { text: "", seq: 0 },
    now: NOW,
  });
  assert.equal(flushed.status, "applied");
  const collabPublished = await publish({ store: viaCollab.store, storage: collabStorage, artifactId: "a1", now: NOW });
  assert.equal(collabPublished.ok, true);
  if (!httpPublished.ok || !collabPublished.ok) return;
  assert.equal(collabPublished.value.sha256, httpPublished.value.sha256, "same canonical bytes");
  assert.equal(collabPublished.value.sizeBytes, httpPublished.value.sizeBytes);
  const httpBytes = httpStorage.objects.get(httpPublished.value.storageKey as string);
  const collabBytes = collabStorage.objects.get(collabPublished.value.storageKey as string);
  assert.deepEqual(
    [...(collabBytes ?? new Uint8Array())],
    [...(httpBytes ?? new Uint8Array())],
    "the published bytes match the draft bytes",
  );
});
