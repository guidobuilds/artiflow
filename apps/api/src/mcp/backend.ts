import {
  type McpBackend,
  type McpCaps,
  type McpChunkListing,
  type McpCommentRow,
  type McpExecutor,
  type McpResult,
  type McpUploadRow,
  McpRollback,
} from "@artiflow/mcp-server/ports";
import { eq } from "drizzle-orm";
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
import { createUpload, getUpload, listChunks, putChunk } from "../domain/staging.ts";
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
  const executorOf = (executor: McpExecutor): AppDb | AppTx => (executor ?? db) as AppDb;
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
  };
}
