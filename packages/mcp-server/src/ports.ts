import type { AnyCommentAnchor } from "@artiflow/domain/comment-anchors";
import type { DocumentOperation } from "@artiflow/domain/document-operations";
import { UUID_RE, HEX_SHA256, BASE64 } from "./constants.ts";

export type McpExecutor = unknown;

export type McpCaps = {
  maxArtifactBytes: number;
  maxChunkBytes: number;
  maxCommentBody: number;
  maxCommentQuote: number;
};

export type McpResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: string;
      reason: string;
      currentRevisionId?: string | null;
      currentSeq?: number;
      opIndex?: number;
      artifactKind?: string;
      maxBytes?: number;
    };

export type McpUploadRow = {
  id: string;
  ownerId: string;
  status: string;
  declaredSizeBytes: number;
  declaredSha256: string;
  expiresAt: Date;
};
export type McpChunkRow = { uploadId: string; chunkIndex: number; sizeBytes: number; sha256: string };
export type McpChunkListing = { chunks: McpChunkRow[]; receivedBytes: number };

export type McpCreateUploadInput = {
  ownerId: string;
  uploadId: string;
  declaredSizeBytes: number;
  declaredSha256: string;
};
export type McpPutChunkInput = {
  ownerId: string;
  uploadId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
};

export type McpCommitInput = {
  ownerId: string;
  uploadId: string;
  bytes: Uint8Array;
  artifactId?: string;
  title?: string | null;
  expectedRevisionId?: string;
  kind?: string;
};
export type McpWriteInput = Omit<McpCommitInput, "uploadId">;
export type McpCommitted = {
  artifactId: string;
  revisionId: string;
  revisionNumber: number;
  observedSizeBytes: number;
  sizeBytes?: number;
};

export type McpRevisionInput = {
  revision: number;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  observedSizeBytes: number;
};
export type McpCasInput = {
  artifactId: string;
  ownerId: string;
  expectedRevisionId: string | null;
  next: McpRevisionInput;
};
export type McpCurrentState = {
  currentRevisionId: string | null;
  observedSizeBytes: number | null;
  deletedAt: Date | null;
  revisionCount: number;
  kind: string;
};
export type McpReadRevision = {
  id: string | null;
  revisionNumber: number | null;
  storageKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  deletedAt: Date | null;
  kind: string;
  title: string | null;
};

export type McpRenameInput = {
  artifactId: string;
  ownerId: string;
  title: string;
  expectedRevisionId: string | null;
};

export type McpCommentRow = {
  id: string;
  authorId: string;
  authorName: string | null;
  authorImage: string | null;
  anchor: unknown;
  body: string;
  parentId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
};
export type McpCommentDocument = {
  id: string;
  kind: string;
  ownerId: string;
  access: string;
  deletedAt: Date | null;
};
export type McpCommentInsert = {
  artifactId: string;
  authorId: string;
  parentId: string | null;
  anchor: AnyCommentAnchor | null;
  revisionId: string | null;
  body: string;
};

export type McpDocumentAuthorKind = "agent" | "person";
export type McpDocumentCreateInput = { ownerId: string; title: string; kind?: string; text?: string };
export type McpDocumentCreated = {
  artifactId: string;
  revisionId: string;
  revisionNumber: number;
  sizeBytes: number;
  observedSizeBytes: number;
  sha256: string;
  seq: number;
};
export type McpDocumentState = { artifactId: string; kind: string; seq: number; text: string };
export type McpDocumentText = { artifactId: string; seq: number; text: string };
export type McpDocumentApplyInput = {
  artifactId: string;
  ownerId: string;
  authorKind: McpDocumentAuthorKind;
  authorId: string;
  baseSeq: number;
  idempotencyKey: string;
  ops: DocumentOperation[];
};
export type McpDocumentApplied = {
  artifactId: string;
  seq: number;
  applied: number;
  replayed: boolean;
  published: boolean;
  revisionId: string | null;
};
export type McpDocumentPublished = {
  artifactId: string;
  revisionId: string;
  revisionNumber: number;
  seqFrom: number;
  seqTo: number;
};

export type McpAssetUploadInput = {
  ownerId: string;
  artifactId: string;
  contentType: string;
  bytes: Uint8Array;
};
export type McpAssetStored = { sha256: string; sizeBytes: number; contentType: string };

export class McpRollback<T> extends Error {
  readonly carried: T;
  constructor(carried: T) {
    super("mcp transaction rolled back by a typed refusal");
    this.carried = carried;
  }
}

export type McpBackend = {
  caps: McpCaps;
  createUpload(input: McpCreateUploadInput): Promise<McpResult<McpUploadRow>>;
  putChunk(input: McpPutChunkInput): Promise<McpResult<McpChunkRow>>;
  getUpload(uploadId: string, ownerId: string): Promise<McpResult<McpUploadRow>>;
  listChunks(uploadId: string, ownerId: string): Promise<McpResult<McpChunkListing>>;
  commitUpload(input: McpCommitInput): Promise<McpResult<McpCommitted>>;
  writeArtifact(input: McpWriteInput): Promise<McpResult<McpCommitted>>;
  putRevisionBytes(input: { sha256: string; bytes: Uint8Array }): Promise<McpResult<{ storageKey: string }>>;
  getRevisionBytes(input: {
    storageKey: string;
    maxBytes: number;
  }): Promise<McpResult<{ bytes: Uint8Array; sizeBytes: number }>>;
  getStagingChunk(sha256: string): Promise<Uint8Array | undefined>;
  putStagingChunk(sha256: string, bytes: Uint8Array): Promise<boolean>;
  getCurrentState(artifactId: string, ownerId: string): Promise<McpResult<McpCurrentState>>;
  renameArtifact(
    input: McpRenameInput,
  ): Promise<McpResult<{ artifactId: string; title: string; currentRevisionId: string | null; revisionCount: number }>>;
  setRevisionCas(
    input: McpCasInput,
  ): Promise<McpResult<{ revisionId: string; revisionNumber: number; observedSizeBytes: number }>>;
  selectReadRevision(
    executor: McpExecutor,
    ownerId: string,
    artifactId: string,
    revisionId?: string,
  ): Promise<McpReadRevision | null>;
  commentDocument(
    executor: McpExecutor,
    userId: string,
    artifactId: string,
    access: string,
    lock?: boolean,
  ): Promise<McpCommentDocument | null>;
  findComment(executor: McpExecutor, artifactId: string, commentId: string): Promise<McpCommentRow | null>;
  insertComment(executor: McpExecutor, input: McpCommentInsert): Promise<{ id: string }>;
  listComments(executor: McpExecutor, artifactId: string, includeAuthors: boolean): Promise<McpCommentRow[]>;
  setCommentResolved(executor: McpExecutor, commentId: string, resolved: boolean, resolvedBy?: string): Promise<void>;
  currentRevision(
    executor: McpExecutor,
    artifactId: string,
    requireMatching: boolean,
  ): Promise<{ id: string; storageKey: string; sha256: string } | null>;
  commentTransaction<T>(run: (executor: McpExecutor) => Promise<T>): Promise<T>;
  documentCreate(input: McpDocumentCreateInput): Promise<McpResult<McpDocumentCreated>>;
  documentOpen(ownerId: string, artifactId: string): Promise<McpResult<McpDocumentState>>;
  documentTextAt(ownerId: string, artifactId: string, seq: number): Promise<McpResult<McpDocumentText>>;
  documentApply(input: McpDocumentApplyInput): Promise<McpResult<McpDocumentApplied>>;
  documentPublish(ownerId: string, artifactId: string): Promise<McpResult<McpDocumentPublished>>;
  uploadAsset(input: McpAssetUploadInput): Promise<McpResult<McpAssetStored>>;
};

export { UUID_RE, HEX_SHA256, BASE64 };
