import { createHash, randomUUID } from "node:crypto";

import { eq, and, desc, gt, lte, sql } from "drizzle-orm";

import type { AppDb, Database } from "../../adapters/postgres/db/client.ts";
import {
  DOCUMENT_AUTHOR_KINDS,
  DOCUMENT_FORMAT_VERSION,
  artifacts,
  artifactRevisions,
  documentDrafts,
  documentOperations,
} from "../../adapters/postgres/db/artifact-schema.ts";
import type { Storage } from "../../adapters/storage/client.ts";
import {
  getRevisionBytes,
  newRevisionStorageKey,
  putRevisionBytes,
  type StorageErrorKind,
} from "../../adapters/storage/s3.ts";
import {
  applyDocumentOperations,
  canonicalBytes,
  indexBlocks,
  type DocumentOperation,
} from "@artiflow/domain/document-operations";
import { decodeMarkdownText } from "@artiflow/domain/markdown";

export const FREEZE_OPERATION_THRESHOLD = 100;
export const FREEZE_INTERVAL_MS = 600_000;

export type DocumentAuthorKind = (typeof DOCUMENT_AUTHOR_KINDS)[number];

export type DocumentErrorKind =
  "validation" | "not_found" | "concurrent_edit" | "operation_rejected" | "nothing_to_publish" | "storage" | "error";

export type DocumentFailure = {
  ok: false;
  kind: DocumentErrorKind;
  reason: string;
  currentSeq?: number;
  opIndex?: number;
};
export type DocumentResult<T> = { ok: true; value: T } | DocumentFailure;

export type ArtifactDocumentState = {
  artifactId: string;
  publishedSeq: number;
  currentRevisionId: string | null;
  revisionCount: number;
  latestSnapshot: {
    storageKey: string;
    sha256: string;
    formatVersion: number;
    createdAt: Date;
  } | null;
};

export type DraftRecord = {
  artifactId: string;
  seq: number;
  formatVersion: number;
  state: unknown;
  updatedByUserId: string | null;
  updatedAt: Date;
};

export type OperationRecord = {
  artifactId: string;
  seq: number;
  baseSeq: number;
  authorKind: DocumentAuthorKind;
  authorId: string;
  ops: DocumentOperation[];
  result: "applied" | "rejected";
  idempotencyKey: string;
  createdAt: Date;
};

export type SnapshotRecord = {
  artifactId: string;
  formatVersion: number;
  seqFrom: number;
  seqTo: number;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  blockIndex: unknown;
  createdAt: Date;
};

export type CommitSnapshotOutcome = {
  committed: boolean;
  revisionId: string | null;
  revisionNumber: number | null;
};

export type DocumentStore = {
  readArtifact(artifactId: string): Promise<ArtifactDocumentState | null>;
  readDraft(artifactId: string): Promise<DraftRecord | null>;
  insertDraftIfAbsent(record: DraftRecord): Promise<DraftRecord>;
  readOperation(artifactId: string, idempotencyKey: string): Promise<OperationRecord | null>;
  readSnapshotAtOrBefore(artifactId: string, seq: number): Promise<SnapshotAtSeq | null>;
  readAppliedOperations(artifactId: string, afterSeq: number, toSeq: number): Promise<OperationRecord[]>;
  commitOperation(input: { operation: OperationRecord; draft: DraftRecord | null }): Promise<{ committed: boolean }>;
  commitSnapshot(input: {
    revision: SnapshotRecord;
    expectedPublishedSeq: number;
    expectedDraftSeq: number;
  }): Promise<CommitSnapshotOutcome>;
};

export type OpenedDraft = { artifactId: string; seq: number; formatVersion: number; text: string };
export type SnapshotAtSeq = {
  seqTo: number;
  storageKey: string;
  sha256: string;
  formatVersion: number;
};
export type AppliedOperations = { artifactId: string; seq: number; applied: number; replayed: boolean };
export type AppliedAndFrozen = AppliedOperations & {
  published: boolean;
  revisionId: string | null;
  publishedSeq: number;
};
export type FreezeOutcome = {
  artifactId: string;
  frozen: boolean;
  publishedSeq: number;
  seq: number;
  seqFrom: number | null;
  revisionId: string | null;
  revisionNumber: number | null;
  storageKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
};

export type OpenDraftInput = { store: DocumentStore; storage: Storage; artifactId: string; now?: Date };

export type ApplyOperationsInput = OpenDraftInput & {
  authorKind: DocumentAuthorKind;
  authorId: string;
  baseSeq: number;
  idempotencyKey: string;
  ops: DocumentOperation[];
};

export type FreezeInput = OpenDraftInput & { force?: boolean };

export type TextAtInput = OpenDraftInput & { seq: number };

const ok = <T>(value: T): DocumentResult<T> => ({ ok: true, value });
const fail = (
  kind: DocumentErrorKind,
  reason: string,
  extra: { currentSeq?: number; opIndex?: number } = {},
): DocumentFailure => ({ ok: false, kind, reason, ...extra });
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const storageKind = (kind: StorageErrorKind): DocumentErrorKind =>
  kind === "not_found" ? "not_found" : kind === "validation" ? "validation" : "storage";

const textOf = (record: DraftRecord): DocumentResult<{ formatVersion: number; text: string }> => {
  const state = record.state as { text?: unknown } | null;
  if (typeof state !== "object" || state === null || typeof state.text !== "string")
    return fail("error", "draft_state_invalid");
  return ok({ formatVersion: record.formatVersion, text: state.text });
};

async function materialise(input: {
  store: DocumentStore;
  storage: Storage;
  artifact: ArtifactDocumentState;
  now: Date;
}): Promise<DocumentResult<OpenedDraft>> {
  const { store, storage, artifact, now } = input;
  let text = "";
  let formatVersion = DOCUMENT_FORMAT_VERSION;
  if (artifact.latestSnapshot) {
    const read = await getRevisionBytes({
      storage,
      storageKey: artifact.latestSnapshot.storageKey,
      sha256: artifact.latestSnapshot.sha256,
    });
    if (!read.ok) return fail(storageKind(read.kind), read.reason);
    const decoded = decodeMarkdownText(read.value.bytes);
    if (!decoded.ok) return fail("error", "snapshot_is_not_valid_utf8");
    text = decoded.text;
    formatVersion = artifact.latestSnapshot.formatVersion;
  }
  const record: DraftRecord = {
    artifactId: artifact.artifactId,
    seq: artifact.publishedSeq,
    formatVersion,
    state: { formatVersion, text },
    updatedByUserId: null,
    updatedAt: now,
  };
  const stored = await store.insertDraftIfAbsent(record);
  const state = textOf(stored);
  if (!state.ok) return state;
  return ok({
    artifactId: stored.artifactId,
    seq: stored.seq,
    formatVersion: state.value.formatVersion,
    text: state.value.text,
  });
}

export async function openDraft(input: OpenDraftInput): Promise<DocumentResult<OpenedDraft>> {
  const { store, storage, artifactId } = input;
  if (!isIdentifier(artifactId)) return fail("validation", "artifact_id_required");
  const artifact = await store.readArtifact(artifactId);
  if (!artifact) return fail("not_found", "artifact_not_found");
  const draft = await store.readDraft(artifactId);
  if (!draft) return materialise({ store, storage, artifact, now: input.now ?? new Date() });
  const state = textOf(draft);
  if (!state.ok) return state;
  return ok({ artifactId, seq: draft.seq, formatVersion: state.value.formatVersion, text: state.value.text });
}

export async function textAt(input: TextAtInput): Promise<DocumentResult<OpenedDraft>> {
  const { store, storage, artifactId, seq } = input;
  if (!isIdentifier(artifactId)) return fail("validation", "artifact_id_required");
  if (!Number.isSafeInteger(seq) || seq < 0) return fail("validation", "sequence_out_of_range");
  const artifact = await store.readArtifact(artifactId);
  if (!artifact) return fail("not_found", "artifact_not_found");
  const draft = await store.readDraft(artifactId);
  const current = draft?.seq ?? artifact.publishedSeq;
  if (seq > current) return fail("validation", "sequence_ahead_of_the_draft", { currentSeq: current });
  if (draft && draft.seq === seq) {
    const state = textOf(draft);
    if (!state.ok) return state;
    return ok({ artifactId, seq, formatVersion: state.value.formatVersion, text: state.value.text });
  }
  const snapshot = await store.readSnapshotAtOrBefore(artifactId, seq);
  let text = "";
  let formatVersion = DOCUMENT_FORMAT_VERSION;
  if (snapshot) {
    const read = await getRevisionBytes({ storage, storageKey: snapshot.storageKey, sha256: snapshot.sha256 });
    if (!read.ok) return fail(storageKind(read.kind), read.reason);
    const decoded = decodeMarkdownText(read.value.bytes);
    if (!decoded.ok) return fail("error", "snapshot_is_not_valid_utf8");
    text = decoded.text;
    formatVersion = snapshot.formatVersion;
  }
  let cursor = snapshot?.seqTo ?? 0;
  if (cursor === seq) return ok({ artifactId, seq, formatVersion, text });
  for (const row of await store.readAppliedOperations(artifactId, cursor, seq)) {
    if (row.seq !== cursor + 1) return fail("validation", "sequence_not_recorded", { currentSeq: current });
    const applied = applyDocumentOperations({ formatVersion, text }, row.ops);
    if (!applied.ok) return fail("error", "recorded_operation_no_longer_applies");
    text = applied.value.text;
    cursor = row.seq;
  }
  if (cursor !== seq) return fail("validation", "sequence_not_recorded", { currentSeq: current });
  return ok({ artifactId, seq, formatVersion, text });
}

const replayOf = (record: OperationRecord): AppliedOperations => ({
  artifactId: record.artifactId,
  seq: record.seq,
  applied: Array.isArray(record.ops) ? record.ops.length : 0,
  replayed: true,
});

export async function applyOperations(input: ApplyOperationsInput): Promise<DocumentResult<AppliedOperations>> {
  const { store, storage, artifactId, authorKind, authorId, baseSeq, idempotencyKey, ops } = input;
  if (!isIdentifier(artifactId)) return fail("validation", "artifact_id_required");
  if (!isIdentifier(authorId)) return fail("validation", "author_id_required");
  if (!(DOCUMENT_AUTHOR_KINDS as readonly string[]).includes(authorKind))
    return fail("validation", "unknown_author_kind");
  if (!Number.isSafeInteger(baseSeq) || baseSeq < 0) return fail("validation", "base_sequence_out_of_range");
  if (!isIdentifier(idempotencyKey)) return fail("validation", "idempotency_key_required");
  if (!Array.isArray(ops) || ops.length === 0) return fail("validation", "operations_required");
  const existing = await store.readOperation(artifactId, idempotencyKey);
  if (existing)
    return existing.result === "applied"
      ? ok(replayOf(existing))
      : fail("operation_rejected", "replayed_rejection", { currentSeq: existing.baseSeq });
  const opened = await openDraft({ store, storage, artifactId, now: input.now });
  if (!opened.ok) return opened;
  const draft = opened.value;
  if (baseSeq !== draft.seq) return fail("concurrent_edit", "base_sequence_is_stale", { currentSeq: draft.seq });
  const applied = applyDocumentOperations({ formatVersion: draft.formatVersion, text: draft.text }, ops);
  const now = input.now ?? new Date();
  const seq = draft.seq + 1;
  const operation: OperationRecord = {
    artifactId,
    seq,
    baseSeq,
    authorKind,
    authorId,
    ops,
    result: applied.ok ? "applied" : "rejected",
    idempotencyKey,
    createdAt: now,
  };
  const nextDraft: DraftRecord | null = applied.ok
    ? {
        artifactId,
        seq,
        formatVersion: applied.value.formatVersion,
        state: { formatVersion: applied.value.formatVersion, text: applied.value.text },
        updatedByUserId: authorKind === "person" ? authorId : null,
        updatedAt: now,
      }
    : null;
  const committed = await store.commitOperation({ operation, draft: nextDraft });
  if (!committed.committed) {
    const raced = await store.readOperation(artifactId, idempotencyKey);
    if (raced)
      return raced.result === "applied"
        ? ok(replayOf(raced))
        : fail("operation_rejected", "replayed_rejection", { currentSeq: raced.baseSeq });
    const current = await store.readDraft(artifactId);
    return fail("concurrent_edit", "sequence_taken", { currentSeq: current?.seq ?? draft.seq });
  }
  if (!applied.ok)
    return fail("operation_rejected", applied.reason, { currentSeq: draft.seq, opIndex: applied.opIndex });
  return ok({ artifactId, seq, applied: applied.value.applied, replayed: false });
}

export async function applyOperationsAndFreeze(input: ApplyOperationsInput): Promise<DocumentResult<AppliedAndFrozen>> {
  const applied = await applyOperations(input);
  if (!applied.ok) return applied;
  const frozen = await freezeIfDue({
    store: input.store,
    storage: input.storage,
    artifactId: input.artifactId,
    now: input.now,
  });
  if (!frozen.ok) return frozen;
  return ok({
    ...applied.value,
    published: frozen.value.frozen,
    revisionId: frozen.value.revisionId,
    publishedSeq: frozen.value.publishedSeq,
  });
}

const unfrozen = (artifactId: string, artifact: ArtifactDocumentState, seq: number): DocumentResult<FreezeOutcome> =>
  ok({
    artifactId,
    frozen: false,
    publishedSeq: artifact.publishedSeq,
    seq,
    seqFrom: null,
    revisionId: null,
    revisionNumber: null,
    storageKey: null,
    sha256: null,
    sizeBytes: null,
  });

async function freeze(input: FreezeInput): Promise<DocumentResult<FreezeOutcome>> {
  const { store, storage, artifactId } = input;
  if (!isIdentifier(artifactId)) return fail("validation", "artifact_id_required");
  const now = input.now ?? new Date();
  const artifact = await store.readArtifact(artifactId);
  if (!artifact) return fail("not_found", "artifact_not_found");
  const draft = await store.readDraft(artifactId);
  const draftSeq = draft?.seq ?? artifact.publishedSeq;
  if (!draft || draftSeq <= artifact.publishedSeq) {
    if (input.force === true) return fail("nothing_to_publish", "no_pending_operations");
    return unfrozen(artifactId, artifact, draftSeq);
  }
  const elapsed = artifact.latestSnapshot ? now.getTime() - artifact.latestSnapshot.createdAt.getTime() : 0;
  const pending = draftSeq - artifact.publishedSeq;
  if (input.force !== true && pending < FREEZE_OPERATION_THRESHOLD && elapsed < FREEZE_INTERVAL_MS)
    return unfrozen(artifactId, artifact, draftSeq);
  const state = textOf(draft);
  if (!state.ok) return state;
  const document = { formatVersion: state.value.formatVersion, text: state.value.text };
  const bytes = canonicalBytes(document);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = newRevisionStorageKey();
  const stored = await putRevisionBytes({ storage, storageKey, sha256, bytes });
  if (!stored.ok) return fail(storageKind(stored.kind), stored.reason);
  const revision: SnapshotRecord = {
    artifactId,
    formatVersion: document.formatVersion,
    seqFrom: artifact.publishedSeq + 1,
    seqTo: draftSeq,
    sizeBytes: stored.value.sizeBytes,
    sha256,
    storageKey: stored.value.storageKey,
    blockIndex: indexBlocks(document.text),
    createdAt: now,
  };
  const committed = await store.commitSnapshot({
    revision,
    expectedPublishedSeq: artifact.publishedSeq,
    expectedDraftSeq: draftSeq,
  });
  if (!committed.committed) {
    if (input.force === true) return fail("nothing_to_publish", "no_pending_operations");
    return unfrozen(artifactId, artifact, draftSeq);
  }
  return ok({
    artifactId,
    frozen: true,
    publishedSeq: revision.seqTo,
    seq: revision.seqTo,
    seqFrom: revision.seqFrom,
    revisionId: committed.revisionId,
    revisionNumber: committed.revisionNumber,
    storageKey: revision.storageKey,
    sha256,
    sizeBytes: revision.sizeBytes,
  });
}

export async function freezeIfDue(input: FreezeInput): Promise<DocumentResult<FreezeOutcome>> {
  return freeze({ ...input, force: false });
}

export async function publish(input: FreezeInput): Promise<DocumentResult<FreezeOutcome>> {
  return freeze({ ...input, force: true });
}

export function drizzleDocumentStore(database: Database): DocumentStore {
  const db: AppDb = database.db;
  return {
    async readArtifact(artifactId) {
      const rows = await db
        .select({
          publishedSeq: artifacts.publishedSeq,
          currentRevisionId: artifacts.currentRevisionId,
        })
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1);
      const artifact = rows[0];
      if (!artifact) return null;
      const counts = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(artifactRevisions)
        .where(eq(artifactRevisions.artifactId, artifactId));
      const snapshot = artifact.currentRevisionId
        ? ((
            await db
              .select({
                storageKey: artifactRevisions.storageKey,
                sha256: artifactRevisions.sha256,
                formatVersion: artifactRevisions.formatVersion,
                createdAt: artifactRevisions.createdAt,
              })
              .from(artifactRevisions)
              .where(eq(artifactRevisions.id, artifact.currentRevisionId))
              .limit(1)
          )[0] ?? null)
        : null;
      return {
        artifactId,
        publishedSeq: artifact.publishedSeq,
        currentRevisionId: artifact.currentRevisionId,
        revisionCount: counts[0]?.count ?? 0,
        latestSnapshot: snapshot,
      };
    },
    async readDraft(artifactId) {
      const rows = await db
        .select({
          artifactId: documentDrafts.artifactId,
          seq: documentDrafts.seq,
          formatVersion: documentDrafts.formatVersion,
          state: documentDrafts.state,
          updatedByUserId: documentDrafts.updatedByUserId,
          updatedAt: documentDrafts.updatedAt,
        })
        .from(documentDrafts)
        .where(eq(documentDrafts.artifactId, artifactId))
        .limit(1);
      return rows[0] ?? null;
    },
    async insertDraftIfAbsent(record) {
      const inserted = await db
        .insert(documentDrafts)
        .values({
          artifactId: record.artifactId,
          seq: record.seq,
          formatVersion: record.formatVersion,
          state: record.state,
          updatedByUserId: record.updatedByUserId,
          updatedAt: record.updatedAt,
        })
        .onConflictDoNothing({ target: documentDrafts.artifactId })
        .returning({
          artifactId: documentDrafts.artifactId,
          seq: documentDrafts.seq,
          formatVersion: documentDrafts.formatVersion,
          state: documentDrafts.state,
          updatedByUserId: documentDrafts.updatedByUserId,
          updatedAt: documentDrafts.updatedAt,
        });
      if (inserted[0]) return inserted[0];
      const existing = await db
        .select({
          artifactId: documentDrafts.artifactId,
          seq: documentDrafts.seq,
          formatVersion: documentDrafts.formatVersion,
          state: documentDrafts.state,
          updatedByUserId: documentDrafts.updatedByUserId,
          updatedAt: documentDrafts.updatedAt,
        })
        .from(documentDrafts)
        .where(eq(documentDrafts.artifactId, record.artifactId))
        .limit(1);
      return existing[0] ?? record;
    },
    async readOperation(artifactId, idempotencyKey) {
      const rows = await db
        .select({
          artifactId: documentOperations.artifactId,
          seq: documentOperations.seq,
          baseSeq: documentOperations.baseSeq,
          authorKind: documentOperations.authorKind,
          authorId: documentOperations.authorId,
          ops: documentOperations.ops,
          result: documentOperations.result,
          idempotencyKey: documentOperations.idempotencyKey,
          createdAt: documentOperations.createdAt,
        })
        .from(documentOperations)
        .where(
          sql`${documentOperations.artifactId} = ${artifactId} and ${documentOperations.idempotencyKey} = ${idempotencyKey}`,
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        authorKind: row.authorKind as DocumentAuthorKind,
        result: row.result as "applied" | "rejected",
        ops: Array.isArray(row.ops) ? (row.ops as DocumentOperation[]) : [],
      };
    },
    async readSnapshotAtOrBefore(artifactId, seq) {
      const rows = await db
        .select({
          seqTo: artifactRevisions.seqTo,
          storageKey: artifactRevisions.storageKey,
          sha256: artifactRevisions.sha256,
          formatVersion: artifactRevisions.formatVersion,
        })
        .from(artifactRevisions)
        .where(and(eq(artifactRevisions.artifactId, artifactId), lte(artifactRevisions.seqTo, seq)))
        .orderBy(desc(artifactRevisions.seqTo), desc(artifactRevisions.revision))
        .limit(1);
      return rows[0] ?? null;
    },
    async readAppliedOperations(artifactId, afterSeq, toSeq) {
      const rows = await db
        .select({
          artifactId: documentOperations.artifactId,
          seq: documentOperations.seq,
          baseSeq: documentOperations.baseSeq,
          authorKind: documentOperations.authorKind,
          authorId: documentOperations.authorId,
          ops: documentOperations.ops,
          result: documentOperations.result,
          idempotencyKey: documentOperations.idempotencyKey,
          createdAt: documentOperations.createdAt,
        })
        .from(documentOperations)
        .where(
          and(
            eq(documentOperations.artifactId, artifactId),
            eq(documentOperations.result, "applied"),
            gt(documentOperations.seq, afterSeq),
            lte(documentOperations.seq, toSeq),
          ),
        )
        .orderBy(documentOperations.seq);
      return rows.map((row) => ({
        ...row,
        authorKind: row.authorKind as DocumentAuthorKind,
        result: row.result as "applied" | "rejected",
        ops: Array.isArray(row.ops) ? (row.ops as DocumentOperation[]) : [],
      }));
    },
    commitOperation: ({ operation, draft }) =>
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(documentOperations)
          .values({
            artifactId: operation.artifactId,
            seq: operation.seq,
            baseSeq: operation.baseSeq,
            authorKind: operation.authorKind,
            authorId: operation.authorId,
            ops: operation.ops,
            result: operation.result,
            idempotencyKey: operation.idempotencyKey,
            createdAt: operation.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: documentOperations.id });
        if (inserted.length === 0) return { committed: false };
        if (draft) {
          await tx
            .update(documentDrafts)
            .set({
              seq: draft.seq,
              formatVersion: draft.formatVersion,
              state: draft.state,
              updatedByUserId: draft.updatedByUserId,
              updatedAt: draft.updatedAt,
            })
            .where(eq(documentDrafts.artifactId, draft.artifactId));
        }
        return { committed: true };
      }),
    commitSnapshot: ({ revision, expectedPublishedSeq, expectedDraftSeq }) =>
      db.transaction(async (tx) => {
        const locked = await tx
          .select({ publishedSeq: artifacts.publishedSeq })
          .from(artifacts)
          .where(eq(artifacts.id, revision.artifactId))
          .for("update");
        const artifact = locked[0];
        if (!artifact) return { committed: false, revisionId: null, revisionNumber: null };
        const draftRows = await tx
          .select({ seq: documentDrafts.seq })
          .from(documentDrafts)
          .where(eq(documentDrafts.artifactId, revision.artifactId))
          .for("update");
        if (artifact.publishedSeq !== expectedPublishedSeq || (draftRows[0]?.seq ?? 0) !== expectedDraftSeq)
          return { committed: false, revisionId: null, revisionNumber: null };
        const counts = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(artifactRevisions)
          .where(eq(artifactRevisions.artifactId, revision.artifactId));
        const revisionNumber = (counts[0]?.count ?? 0) + 1;
        const revisionId = randomUUID();
        await tx.insert(artifactRevisions).values({
          id: revisionId,
          artifactId: revision.artifactId,
          revision: revisionNumber,
          formatVersion: revision.formatVersion,
          seqFrom: revision.seqFrom,
          seqTo: revision.seqTo,
          sizeBytes: revision.sizeBytes,
          sha256: revision.sha256,
          storageKey: revision.storageKey,
          blockIndex: revision.blockIndex,
          createdAt: revision.createdAt,
        });
        await tx
          .update(artifacts)
          .set({ currentRevisionId: revisionId, publishedSeq: revision.seqTo, updatedAt: sql`now()` })
          .where(eq(artifacts.id, revision.artifactId));
        return { committed: true, revisionId, revisionNumber };
      }),
  };
}
