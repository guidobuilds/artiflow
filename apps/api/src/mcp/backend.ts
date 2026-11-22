import {
  type McpAssetStored,
  type McpAssetUploadInput,
  type McpBackend,
  type McpCaps,
  type McpChunkListing,
  type McpCommentRow,
  type McpDocumentApplyInput,
  type McpDocumentCreateInput,
  type McpDocumentState,
  type McpExecutor,
  type McpResult,
  type McpUploadRow,
  McpRollback,
} from "@artiflow/mcp-server/ports";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { acceptsTextOperations } from "@artiflow/domain/kinds";
import {
  commentDocument,
  currentRevision,
  selectReadRevision,
  findComment,
  insertComment,
  listComments,
  setCommentResolved,
} from "../adapters/postgres/comments-repo.ts";
import {
  artifactRevisions,
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_COMMENT_BODY,
  MAX_COMMENT_QUOTE,
} from "../adapters/postgres/db/artifact-schema.ts";
import {
  getRevisionBytes,
  getStagingChunk,
  newRevisionStorageKey,
  putRevisionBytes,
  putStagingChunk,
} from "../adapters/storage/s3.ts";
import { commitUpload, writeArtifact } from "../domain/commit-flow.ts";
import { getCurrentState, renameArtifact, setRevisionCas } from "../domain/commits.ts";
import {
  applyOperationsAndFreeze,
  drizzleDocumentStore,
  openDraft,
  publish,
  textAt,
} from "../domain/documents/service.ts";
import { createUpload, getUpload, listChunks, putChunk } from "../domain/staging.ts";
import { storeArtifactAsset } from "../routes/assets.ts";
import type { AppDb, AppTx, Database } from "../adapters/postgres/db/client.ts";
import type { Storage } from "../adapters/storage/client.ts";

export function createMcpBackend(database: Database, storage: Storage, caps?: Partial<McpCaps>): McpBackend {
  const resolvedCaps: McpCaps = {
    maxArtifactBytes: caps?.maxArtifactBytes ?? MAX_ARTIFACT_BYTES,
    maxChunkBytes: caps?.maxChunkBytes ?? MAX_CHUNK_BYTES,
    maxCommentBody: caps?.maxCommentBody ?? MAX_COMMENT_BODY,
    maxCommentQuote: caps?.maxCommentQuote ?? MAX_COMMENT_QUOTE,
  };
  const db = database.db;
  const documents = drizzleDocumentStore(database);
  const executorOf = (executor: McpExecutor): AppDb | AppTx => (executor ?? db) as AppDb;
  const documentOf = async (ownerId: string, artifactId: string): Promise<McpResult<{ kind: string }>> => {
    const state = await getCurrentState(db, artifactId, ownerId);
    if (!state.ok) return { ok: false, kind: state.kind, reason: state.reason };
    if (state.value.deletedAt) return { ok: false, kind: "gone", reason: "artifact_deleted" };
    if (!acceptsTextOperations(state.value.kind))
      return {
        ok: false,
        kind: "wrong_kind",
        reason: "artifact_is_not_a_markdown_document",
        artifactKind: state.value.kind,
      };
    return { ok: true, value: { kind: state.value.kind } };
  };
  const digestOfKey = async (storageKey: string): Promise<string | null> =>
    (
      await db
        .select({ sha256: artifactRevisions.sha256 })
        .from(artifactRevisions)
        .where(eq(artifactRevisions.storageKey, storageKey))
        .limit(1)
    )[0]?.sha256 ?? null;
  return {
    caps: resolvedCaps,
    createUpload: (input) => createUpload(db, input),
    putChunk: (input) => putChunk(db, input),
    getUpload: (uploadId, ownerId) => getUpload(db, uploadId, ownerId) as Promise<McpResult<McpUploadRow>>,
    listChunks: (uploadId, ownerId) => listChunks(db, uploadId, ownerId) as Promise<McpResult<McpChunkListing>>,
    commitUpload: (input) => commitUpload({ database, storage, ...input }),
    writeArtifact: (input) => writeArtifact({ database, storage, ...input }),
    putRevisionBytes: (input) =>
      putRevisionBytes({ storage, storageKey: newRevisionStorageKey(), sha256: input.sha256, bytes: input.bytes }),
    getRevisionBytes: async (input) => {
      const sha256 = await digestOfKey(input.storageKey);
      if (!sha256) return { ok: false, kind: "not_found", reason: "revision_not_stored" };
      return getRevisionBytes({ storage, storageKey: input.storageKey, sha256, maxBytes: input.maxBytes });
    },
    getStagingChunk: (sha256) => getStagingChunk(storage, sha256),
    putStagingChunk: (sha256, bytes) => putStagingChunk(storage, sha256, bytes),
    getCurrentState: (artifactId, ownerId) => getCurrentState(db, artifactId, ownerId),
    renameArtifact: (input) => renameArtifact(db, input),
    setRevisionCas: (input) => setRevisionCas(db, input),
    selectReadRevision: async (executor, ownerId, artifactId, revisionId) =>
      (await selectReadRevision(executorOf(executor), ownerId, artifactId, revisionId)) ?? null,
    commentDocument: async (executor, userId, artifactId, access, lock) =>
      (await commentDocument(executorOf(executor), userId, artifactId, access as "owner" | "shared", lock)) ?? null,
    findComment: async (executor, artifactId, commentId) =>
      ((await findComment(executorOf(executor), artifactId, commentId)) ?? null) as McpCommentRow | null,
    insertComment: (executor, input) => insertComment(executorOf(executor), input),
    listComments: (executor, artifactId, includeAuthors) =>
      listComments(executorOf(executor), artifactId, includeAuthors) as unknown as Promise<McpCommentRow[]>,
    setCommentResolved: (executor, commentId, resolved, resolvedBy) =>
      setCommentResolved(executorOf(executor), commentId, resolved, resolvedBy),
    currentRevision: async (executor, artifactId, requireMatching) =>
      (await currentRevision(executorOf(executor), artifactId, requireMatching)) ?? null,
    commentTransaction: async (run) => {
      try {
        return await db.transaction(async (tx) => run(tx));
      } catch (error) {
        if (error instanceof McpRollback) return error.carried;
        throw error;
      }
    },
    documentCreate: async ({ ownerId, title, kind, text }: McpDocumentCreateInput) => {
      const body = text !== undefined && text.trim().length > 0 ? text : `# ${title}\n`;
      const bytes = new TextEncoder().encode(body);
      const written = await writeArtifact({
        database,
        storage,
        ownerId,
        bytes,
        title,
        kind: kind ?? "markdown",
      });
      if (!written.ok) return { ok: false, kind: written.kind, reason: written.reason };
      const opened = await openDraft({ store: documents, storage, artifactId: written.value.artifactId });
      if (!opened.ok) return { ok: false, kind: opened.kind, reason: opened.reason };
      return {
        ok: true,
        value: {
          artifactId: written.value.artifactId,
          revisionId: written.value.revisionId,
          revisionNumber: written.value.revisionNumber,
          sizeBytes: written.value.sizeBytes,
          observedSizeBytes: written.value.observedSizeBytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          seq: opened.value.seq,
        },
      };
    },
    documentOpen: async (ownerId: string, artifactId: string): Promise<McpResult<McpDocumentState>> => {
      const described = await documentOf(ownerId, artifactId);
      if (!described.ok) return described;
      const opened = await openDraft({ store: documents, storage, artifactId });
      if (!opened.ok) return { ok: false, kind: opened.kind, reason: opened.reason };
      return {
        ok: true,
        value: {
          artifactId,
          kind: described.value.kind,
          seq: opened.value.seq,
          text: opened.value.text,
        },
      };
    },
    documentTextAt: async (ownerId: string, artifactId: string, seq: number) => {
      const described = await documentOf(ownerId, artifactId);
      if (!described.ok) return described;
      const resolved = await textAt({ store: documents, storage, artifactId, seq });
      if (!resolved.ok) return { ok: false, kind: resolved.kind, reason: resolved.reason };
      return { ok: true, value: { artifactId, seq: resolved.value.seq, text: resolved.value.text } };
    },
    documentApply: async (input: McpDocumentApplyInput) => {
      const described = await documentOf(input.ownerId, input.artifactId);
      if (!described.ok) return described;
      const applied = await applyOperationsAndFreeze({
        store: documents,
        storage,
        artifactId: input.artifactId,
        authorKind: input.authorKind,
        authorId: input.authorId,
        baseSeq: input.baseSeq,
        idempotencyKey: input.idempotencyKey,
        ops: input.ops,
      });
      if (!applied.ok)
        return {
          ok: false,
          kind: applied.kind,
          reason: applied.reason,
          currentSeq: applied.currentSeq,
          opIndex: applied.opIndex,
        };
      return {
        ok: true,
        value: {
          artifactId: input.artifactId,
          seq: applied.value.seq,
          applied: applied.value.applied,
          replayed: applied.value.replayed,
          published: applied.value.published,
          revisionId: applied.value.revisionId,
        },
      };
    },
    documentPublish: async (ownerId: string, artifactId: string) => {
      const described = await documentOf(ownerId, artifactId);
      if (!described.ok) return described;
      const frozen = await publish({ store: documents, storage, artifactId });
      if (!frozen.ok) return { ok: false, kind: frozen.kind, reason: frozen.reason };
      const value = frozen.value;
      if (value.revisionId === null || value.revisionNumber === null || value.seqFrom === null)
        return { ok: false, kind: "nothing_to_publish", reason: "no_pending_operations" };
      return {
        ok: true,
        value: {
          artifactId,
          revisionId: value.revisionId,
          revisionNumber: value.revisionNumber,
          seqFrom: value.seqFrom,
          seqTo: value.publishedSeq,
        },
      };
    },
    uploadAsset: async (input: McpAssetUploadInput): Promise<McpResult<McpAssetStored>> => {
      const state = await getCurrentState(db, input.artifactId, input.ownerId);
      if (!state.ok) return { ok: false, kind: state.kind, reason: state.reason };
      if (state.value.deletedAt) return { ok: false, kind: "gone", reason: "artifact_deleted" };
      const stored = await storeArtifactAsset({
        db,
        storage,
        artifactId: input.artifactId,
        contentType: input.contentType,
        bytes: input.bytes,
      });
      if (stored.ok) return stored;
      return {
        ok: false,
        kind: stored.code,
        reason: stored.reason,
        ...(stored.maxBytes === undefined ? {} : { maxBytes: stored.maxBytes }),
      };
    },
  };
}
