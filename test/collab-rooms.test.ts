import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  applyOperations,
  openDraft,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";
import { readMarkdownFromFragment, replaceMarkdownInFragment } from "@artiflow/domain/markdown-doc";
import {
  COLLAB_MARKDOWN_FIELD,
  attachRoomsToDocumentWrites,
  createRooms,
  type Room,
  type RoomConnection,
} from "../apps/api/src/collab/rooms.ts";

const NOW = new Date("2026-11-22T09:00:00.000Z");
const START = "# Start\n\nopening";
const EDITED = "# Start\n\nopening edited by a human";
const AGENT = "# Start\n\nopening edited by an agent";

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

function fakeStore(seed: { artifactId: string; publishedSeq?: number } = { artifactId: "a1" }) {
  const artifacts = new Map<string, { publishedSeq: number; currentRevisionId: string | null; kind: string }>();
  const drafts = new Map<string, DraftRecord>();
  const operations: FakeOperation[] = [];
  const revisions: FakeRevision[] = [];
  let gate: Promise<void> | null = null;
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
        if (gate !== null) await gate;
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
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisionNumber}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
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
    drafts,
    operations,
    revisions,
    holdCommits: () => {
      let release = (): void => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
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

const roomText = (room: Room): string => readMarkdownFromFragment(room.doc.getXmlFragment(COLLAB_MARKDOWN_FIELD));

function editRoom(room: Room, text: string): void {
  room.doc.transact(() => replaceMarkdownInFragment(room.doc.getXmlFragment(COLLAB_MARKDOWN_FIELD), text), null);
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function client(userId: string): RoomConnection & { updates: Uint8Array[]; awareness: Uint8Array[] } {
  const updates: Uint8Array[] = [];
  const awareness: Uint8Array[] = [];
  return {
    userId,
    updates,
    awareness,
    sendUpdate: (update: Uint8Array): void => {
      updates.push(update);
    },
    sendAwareness: (update: Uint8Array): void => {
      awareness.push(update);
    },
  };
}

async function joined(
  seeded: Seeded,
  rooms: ReturnType<typeof createRooms>,
  userId: string,
): Promise<{ room: Room; socket: ReturnType<typeof client> }> {
  const socket = client(userId);
  const outcome = await rooms.join({ artifactId: "a1", connection: socket });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  if (!outcome.ok) throw new Error("unreachable");
  return { room: outcome.room, socket };
}

test("the first join loads the current draft and a second join shares the same room", async () => {
  const seeded = fakeStore({ artifactId: "a1", publishedSeq: 2 });
  const storage = fakeStorage();
  seeded.seedSnapshot(storage, START);
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 20, log: (): void => undefined });
  const first = await joined(seeded, rooms, "person-1");
  assert.equal(roomText(first.room), START, "the room loads the draft text into its fragment");
  const second = await joined(seeded, rooms, "person-2");
  assert.equal(second.room, first.room, "one room per artifact");
  assert.equal(rooms.size(), 1);
  assert.deepEqual(
    [...first.room.clients].map((entry) => entry.userId),
    ["person-1", "person-2"],
  );
  await rooms.closeAll();
});

test("opening and closing a document whose stored text is not canonical appends no operation", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  const raw = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  seeded.drafts.set("a1", {
    artifactId: "a1",
    seq: 0,
    formatVersion: 1,
    state: { formatVersion: 1, text: raw },
    updatedByUserId: null,
    updatedAt: NOW,
  });
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 20, log: (): void => undefined });
  const { room, socket } = await joined(seeded, rooms, "person-1");
  assert.notEqual(roomText(room), raw, "the fixture is a stored text the editor serialises differently");
  await rooms.leave({ room, connection: socket });
  assert.equal(seeded.operations.length, 0, "joining a document does not rewrite its stored bytes");
  assert.equal(seeded.revisions.length, 0);
});

test("an edit is flushed once at quiescence and appends no snapshot", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await openDraft({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 20, log: (): void => undefined });
  const { room } = await joined(seeded, rooms, "person-1");
  editRoom(room, EDITED);
  await waitFor(() => seeded.operations.length === 1, "the debounced flush");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seeded.operations.length, 1, "quiescence appends exactly one row");
  assert.equal(seeded.revisions.length, 0, "no snapshot below the threshold");
  assert.equal(textOf(seeded), EDITED);
  assert.equal(room.lastFlushed.text, EDITED);
  assert.equal(room.lastFlushed.seq, 1);
  await rooms.closeAll();
});

test("the last leave flushes the room, destroys it, and the store keeps the client text", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await openDraft({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 60_000, log: (): void => undefined });
  const { room, socket } = await joined(seeded, rooms, "person-1");
  editRoom(room, EDITED);
  await rooms.leave({ room, connection: socket });
  assert.equal(rooms.size(), 0, "the room is gone with its last client");
  assert.equal(rooms.room("a1"), undefined);
  assert.equal(seeded.operations.length, 1, "the final flush appends one row");
  assert.equal(textOf(seeded), EDITED, "the store keeps exactly what the clients had");
  assert.equal(seeded.operations[0]?.authorId, "person-1");
});

test("a room whose final flush is still in flight survives a rejoin", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await openDraft({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 60_000, log: (): void => undefined });
  const { room, socket } = await joined(seeded, rooms, "person-1");
  editRoom(room, EDITED);
  const release = seeded.holdCommits();
  const leaving = rooms.leave({ room, connection: socket });
  await waitFor(() => room.clients.size === 0, "the last client leaving");
  const rejoined = await rooms.join({ artifactId: "a1", connection: client("person-2") });
  assert.equal(rejoined.ok, true);
  if (!rejoined.ok) return;
  assert.equal(rejoined.room, room, "the closing room is reused instead of reloaded");
  release();
  await leaving;
  assert.equal(rooms.room("a1"), room, "the room survives because a client came back");
  assert.equal(roomText(room), EDITED);
  await rooms.closeAll();
  assert.equal(rooms.size(), 0);
});

test("an agent write invalidates the room, reaches its clients and is not flushed twice", async () => {
  const seeded = fakeStore({ artifactId: "a1" });
  const storage = fakeStorage();
  await openDraft({ store: seeded.store, storage, artifactId: "a1", now: NOW });
  const rooms = createRooms({ store: seeded.store, storage, debounceMs: 20, log: (): void => undefined });
  const detach = attachRoomsToDocumentWrites(rooms);
  const { room, socket } = await joined(seeded, rooms, "person-1");
  const applied = await applyOperations({
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
  assert.equal(applied.ok, true, applied.ok ? "" : applied.reason);
  await waitFor(() => roomText(room) === AGENT, "the invalidated room text");
  assert.ok(socket.updates.length > 0, "the invalidation is broadcast as an update");
  assert.deepEqual([room.lastFlushed.text, room.lastFlushed.seq], [AGENT, 1]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seeded.operations.length, 1, "the invalidation adopts the base instead of appending a row");
  assert.equal(textOf(seeded), AGENT);
  detach();
  await rooms.closeAll();
});
