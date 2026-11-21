import { createHash } from "node:crypto";

import type { Database } from "../adapters/postgres/db/client.ts";
import { MAX_ARTIFACT_BYTES, ARTIFACT_KINDS } from "../adapters/postgres/db/artifact-schema.ts";
import { acceptsTextOperations } from "@artiflow/domain/kinds";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import type { Storage } from "../adapters/storage/client.ts";
import { createArtifactWithRevision, getCurrentState, setRevisionCas, type RevisionInput } from "./commits.ts";
import {
  getRevisionBytes,
  newRevisionStorageKey,
  putRevisionBytes,
  type StorageErrorKind,
  type StorageResult,
} from "../adapters/storage/s3.ts";
import { completeUpload, getUpload, listChunks } from "./staging.ts";

export type CommitFlowErrorKind =
  "validation" | "not_found" | "conflict" | "expired" | "forbidden" | "gone" | "too_large" | "storage" | "error";
export type CommitFlowFailure = { ok: false; kind: CommitFlowErrorKind; reason: string };
export type ConcurrentCommit = {
  ok: false;
  kind: "concurrent_commit";
  reason: string;
  currentRevisionId: string | null;
};
export type CommitOutcome = {
  artifactId: string;
  revisionId: string;
  revisionNumber: number;
  storageKey: string;
  sizeBytes: number;
  observedSizeBytes: number;
};
export type CommitFlowResult = { ok: true; value: CommitOutcome } | CommitFlowFailure | ConcurrentCommit;
export type CommitUploadInput = {
  database: Database;
  storage: Storage;
  ownerId: string;
  uploadId: string;
  bytes: Uint8Array;
  artifactId?: string;
  title?: string | null;
  expectedRevisionId?: string;
  kind?: string;
  now?: Date;
};

export type WriteArtifactInput = Omit<CommitUploadInput, "uploadId" | "now">;

export type CopyRevisionInput = { storage: Storage; storageKey: string; sha256: string; maxBytes?: number };
export type CopiedRevision = { storageKey: string; sha256: string; sizeBytes: number };

const ok = (value: CommitOutcome): CommitFlowResult => ({ ok: true, value });
const fail = (kind: CommitFlowErrorKind, reason: string): CommitFlowFailure => ({ ok: false, kind, reason });
const concurrent = (reason: string, currentRevisionId: string | null): ConcurrentCommit => ({
  ok: false,
  kind: "concurrent_commit",
  reason,
  currentRevisionId,
});
const FLOW_KIND: Record<StorageErrorKind, CommitFlowErrorKind> = {
  validation: "validation",
  too_large: "too_large",
  digest_mismatch: "storage",
  conflict: "storage",
  not_found: "storage",
};

async function persistRevision(
  database: Database,
  input: {
    ownerId: string;
    sha256: string;
    storageKey: string;
    sizeBytes: number;
    observedSizeBytes: number;
    artifactId?: string;
    title?: string | null;
    expectedRevisionId?: string;
    kind?: string;
  },
): Promise<CommitFlowResult> {
  const { ownerId, sha256, storageKey, sizeBytes, observedSizeBytes, artifactId, title, expectedRevisionId, kind } =
    input;
  const next: RevisionInput = { revision: 1, sizeBytes, sha256, storageKey, observedSizeBytes };
  if (expectedRevisionId === undefined) {
    const created = await createArtifactWithRevision(database.db, {
      ownerId,
      artifactId,
      title: title ?? null,
      kind,
      revision: next,
    });
    if (created.ok) return ok({ ...created.value, storageKey, sizeBytes });
    if (created.reason === "artifact_already_exists") return concurrent(created.reason, created.currentRevisionId);
    return fail(created.kind === "concurrent_commit" ? "conflict" : created.kind, created.reason);
  }
  if (!artifactId) return fail("validation", "artifact_id_required_for_expected_revision");
  const state = await getCurrentState(database.db, artifactId, ownerId);
  if (!state.ok) return fail(state.kind === "concurrent_commit" ? "conflict" : state.kind, state.reason);
  if (kind !== undefined && state.value.kind !== kind) return fail("conflict", "kind_mismatch");
  const advanced = await setRevisionCas(database.db, {
    artifactId,
    ownerId,
    expectedRevisionId,
    next: { ...next, revision: state.value.revisionCount + 1 },
    title,
  });
  if (!advanced.ok)
    return advanced.kind === "concurrent_commit"
      ? concurrent(advanced.reason, advanced.currentRevisionId)
      : fail(advanced.kind, advanced.reason);
  return ok({ ...advanced.value, artifactId, storageKey, sizeBytes });
}

export async function copyRevisionBytes(input: CopyRevisionInput): Promise<StorageResult<CopiedRevision>> {
  const { storage, storageKey, sha256, maxBytes } = input;
  const read = await getRevisionBytes({ storage, storageKey, sha256, maxBytes });
  if (!read.ok) return read;
  const stored = await putRevisionBytes({
    storage,
    storageKey: newRevisionStorageKey(),
    sha256,
    bytes: read.value.bytes,
  });
  if (!stored.ok) return stored;
  return { ok: true, value: { storageKey: stored.value.storageKey, sha256, sizeBytes: stored.value.sizeBytes } };
}

const storesText = (kind: string | undefined): boolean => kind !== undefined && acceptsTextOperations(kind);

export async function commitUpload(input: CommitUploadInput): Promise<CommitFlowResult> {
  const { database, storage, ownerId, uploadId, bytes, artifactId, title, expectedRevisionId, kind } = input;
  const now = input.now ?? new Date();
  if (kind !== undefined && !(ARTIFACT_KINDS as readonly string[]).includes(kind))
    return fail("validation", "unknown_artifact_kind");
  if (storesText(kind) && !decodeMarkdownText(bytes).ok) return fail("validation", "not_valid_utf8_markdown");
  const upload = await getUpload(database.db, uploadId, ownerId);
  if (!upload.ok) return fail(upload.kind, upload.reason);
  if (upload.value.status !== "open") return fail("conflict", `upload_status_${upload.value.status}`);
  if (upload.value.expiresAt.getTime() <= now.getTime()) return fail("expired", "upload_staging_ttl_elapsed");
  const listing = await listChunks(database.db, uploadId, ownerId);
  if (!listing.ok) return fail(listing.kind, listing.reason);
  const chunks = listing.value.chunks;
  if (chunks.length === 0) return fail("conflict", "no_staged_chunks");
  if (!chunks.every((chunk, position) => chunk.chunkIndex === position))
    return fail("conflict", "staged_chunk_range_not_contiguous");
  const stagedSizeBytes = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  if (stagedSizeBytes !== upload.value.declaredSizeBytes) return fail("conflict", "staged_size_mismatch");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return fail("validation", "bytes_required");
  if (bytes.length > MAX_ARTIFACT_BYTES) return fail("too_large", "payload_exceeds_artifact_cap");
  if (bytes.length !== stagedSizeBytes) return fail("validation", "body_length_disagrees_with_staged_bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = newRevisionStorageKey();
  const stored = await putRevisionBytes({ storage, storageKey, sha256, bytes });
  if (!stored.ok) return fail(FLOW_KIND[stored.kind], stored.reason);
  const completed = await completeUpload(database.db, { ownerId, uploadId, now });
  if (!completed.ok) return fail(completed.kind, completed.reason);
  return persistRevision(database, {
    ownerId,
    sha256,
    storageKey: stored.value.storageKey,
    sizeBytes: bytes.length,
    observedSizeBytes: completed.value.totalSizeBytes,
    artifactId,
    title,
    expectedRevisionId,
    kind,
  });
}

export async function writeArtifact(input: WriteArtifactInput): Promise<CommitFlowResult> {
  const { database, storage, ownerId, bytes, artifactId, title, expectedRevisionId, kind } = input;
  if (kind !== undefined && !(ARTIFACT_KINDS as readonly string[]).includes(kind))
    return fail("validation", "unknown_artifact_kind");
  if (storesText(kind) && !decodeMarkdownText(bytes).ok) return fail("validation", "not_valid_utf8_markdown");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return fail("validation", "bytes_required");
  if (bytes.length > MAX_ARTIFACT_BYTES) return fail("too_large", "payload_exceeds_artifact_cap");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = newRevisionStorageKey();
  const stored = await putRevisionBytes({ storage, storageKey, sha256, bytes });
  if (!stored.ok) return fail(FLOW_KIND[stored.kind], stored.reason);
  return persistRevision(database, {
    ownerId,
    sha256,
    storageKey: stored.value.storageKey,
    sizeBytes: bytes.length,
    observedSizeBytes: bytes.length,
    artifactId,
    title,
    expectedRevisionId,
    kind,
  });
}
