import { randomUUID } from "node:crypto";

import { and, asc, eq, lt, ne, sql } from "drizzle-orm";

import {
  artifactChunks,
  artifactUploads,
  MAX_ARTIFACT_BYTES,
  MAX_CHUNK_BYTES,
  STAGING_TTL_MINUTES,
} from "../adapters/postgres/db/artifact-schema.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";

export type StagingErrorKind = "not_found" | "conflict" | "expired" | "validation" | "forbidden";
export type StagingFailure = { ok: false; kind: StagingErrorKind; reason: string };
export type StagingResult<T> = { ok: true; value: T } | StagingFailure;

export type UploadRow = {
  id: string;
  ownerId: string;
  declaredSizeBytes: number;
  declaredSha256: string;
  expiresAt: Date;
  status: string;
  createdAt: Date;
};

export type ChunkRow = {
  id: string;
  uploadId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
};

export type ChunkListing = { chunks: ChunkRow[]; nextIndex: number; missing: number[] };
export type Completion = { upload: UploadRow; chunkCount: number; totalSizeBytes: number };

export const MAX_UPLOAD_CHUNKS = MAX_ARTIFACT_BYTES / MAX_CHUNK_BYTES;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

const ok = <T>(value: T): StagingResult<T> => ({ ok: true, value });
const fail = (kind: StagingErrorKind, reason: string): StagingFailure => ({ ok: false, kind, reason });
const isHexDigest = (value: unknown): value is string => typeof value === "string" && HEX_SHA256.test(value);
const isBoundedByteCount = (value: unknown, cap: number): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= cap;
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const elapsed = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() <= now.getTime();

async function selectUpload(db: AppDb, uploadId: string): Promise<UploadRow | undefined> {
  const rows = await db.select().from(artifactUploads).where(eq(artifactUploads.id, uploadId)).limit(1);
  return rows[0];
}

async function loadOwned(db: AppDb, uploadId: string, ownerId: string): Promise<StagingResult<UploadRow>> {
  if (!isIdentifier(ownerId) || !isIdentifier(uploadId)) return fail("validation", "owner_and_upload_id_required");
  const found = await selectUpload(db, uploadId);
  if (!found || found.ownerId !== ownerId) return fail("not_found", "upload_not_visible_to_owner");
  return ok(found);
}

async function listOwnedChunks(db: AppDb, uploadId: string): Promise<ChunkRow[]> {
  return db
    .select()
    .from(artifactChunks)
    .where(eq(artifactChunks.uploadId, uploadId))
    .orderBy(asc(artifactChunks.chunkIndex));
}

export type CreateUploadInput = {
  ownerId: string;
  uploadId: string;
  declaredSizeBytes: number;
  declaredSha256: string;
};

export async function createUpload(db: AppDb, input: CreateUploadInput): Promise<StagingResult<UploadRow>> {
  const { ownerId, uploadId, declaredSizeBytes, declaredSha256 } = input;
  if (!isIdentifier(ownerId) || !isIdentifier(uploadId)) return fail("validation", "owner_and_upload_id_required");
  if (!isBoundedByteCount(declaredSizeBytes, MAX_ARTIFACT_BYTES))
    return fail("validation", "declared_size_out_of_range");
  if (!isHexDigest(declaredSha256)) return fail("validation", "declared_digest_not_lowercase_hex_sha256");
  await db
    .insert(artifactUploads)
    .values({
      id: uploadId,
      ownerId,
      declaredSizeBytes,
      declaredSha256,
      status: "open",
      expiresAt: sql`now() + make_interval(mins => ${STAGING_TTL_MINUTES})`,
    })
    .onConflictDoNothing({ target: artifactUploads.id });
  const stored = await selectUpload(db, uploadId);
  if (!stored || stored.ownerId !== ownerId) return fail("not_found", "upload_not_visible_to_owner");
  if (stored.declaredSizeBytes !== declaredSizeBytes || stored.declaredSha256 !== declaredSha256) {
    return fail("conflict", "upload_declaration_mismatch");
  }
  return ok(stored);
}

export type PutChunkInput = {
  ownerId: string;
  uploadId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  now?: Date;
};

export async function putChunk(db: AppDb, input: PutChunkInput): Promise<StagingResult<ChunkRow>> {
  const { ownerId, uploadId, chunkIndex, sizeBytes, sha256 } = input;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_UPLOAD_CHUNKS) {
    return fail("validation", "chunk_index_out_of_range");
  }
  if (!isBoundedByteCount(sizeBytes, MAX_CHUNK_BYTES)) return fail("validation", "chunk_size_out_of_range");
  if (!isHexDigest(sha256)) return fail("validation", "chunk_digest_not_lowercase_hex_sha256");
  const upload = await loadOwned(db, uploadId, ownerId);
  if (!upload.ok) return upload;
  if (upload.value.status !== "open") return fail("conflict", `upload_status_${upload.value.status}`);
  if (elapsed(upload.value.expiresAt, input.now ?? new Date())) return fail("expired", "upload_staging_ttl_elapsed");
  await db
    .insert(artifactChunks)
    .values({ id: randomUUID(), uploadId, chunkIndex, sizeBytes, sha256 })
    .onConflictDoNothing({ target: [artifactChunks.uploadId, artifactChunks.chunkIndex] });
  const rows = await db
    .select()
    .from(artifactChunks)
    .where(and(eq(artifactChunks.uploadId, uploadId), eq(artifactChunks.chunkIndex, chunkIndex)))
    .limit(1);
  const chunk = rows[0];
  if (!chunk) return fail("conflict", "chunk_missing_after_insert");
  if (chunk.sizeBytes !== sizeBytes || chunk.sha256 !== sha256) return fail("conflict", "chunk_payload_mismatch");
  return ok(chunk);
}

export async function listChunks(db: AppDb, uploadId: string, ownerId: string): Promise<StagingResult<ChunkListing>> {
  const upload = await loadOwned(db, uploadId, ownerId);
  if (!upload.ok) return upload;
  const chunks = await listOwnedChunks(db, uploadId);
  const present = new Set(chunks.map((chunk) => chunk.chunkIndex));
  const highest = chunks.at(-1)?.chunkIndex ?? -1;
  const missing: number[] = [];
  for (let index = 0; index <= highest; index += 1) if (!present.has(index)) missing.push(index);
  return ok({ chunks, nextIndex: missing[0] ?? chunks.length, missing });
}

export async function getUpload(db: AppDb, uploadId: string, ownerId: string): Promise<StagingResult<UploadRow>> {
  return loadOwned(db, uploadId, ownerId);
}

export async function abortUpload(db: AppDb, uploadId: string, ownerId: string): Promise<StagingResult<UploadRow>> {
  const upload = await loadOwned(db, uploadId, ownerId);
  if (!upload.ok) return upload;
  if (upload.value.status === "aborted") return upload;
  if (upload.value.status !== "open") return fail("conflict", `upload_status_${upload.value.status}`);
  const rows = await db
    .update(artifactUploads)
    .set({ status: "aborted" })
    .where(
      and(eq(artifactUploads.id, uploadId), eq(artifactUploads.ownerId, ownerId), eq(artifactUploads.status, "open")),
    )
    .returning();
  const row = rows[0];
  return row ? ok(row) : fail("conflict", "upload_state_changed");
}

export type CompleteUploadInput = { ownerId: string; uploadId: string; now?: Date };

export async function completeUpload(db: AppDb, input: CompleteUploadInput): Promise<StagingResult<Completion>> {
  const { uploadId, ownerId } = input;
  const upload = await loadOwned(db, uploadId, ownerId);
  if (!upload.ok) return upload;
  if (upload.value.status !== "open") return fail("conflict", `upload_status_${upload.value.status}`);
  if (elapsed(upload.value.expiresAt, input.now ?? new Date())) return fail("expired", "upload_staging_ttl_elapsed");
  const chunks = await listOwnedChunks(db, uploadId);
  if (chunks.length === 0) return fail("conflict", "no_staged_chunks");
  const contiguous = chunks.every((chunk, position) => chunk.chunkIndex === position);
  if (!contiguous) return fail("conflict", "staged_chunk_range_not_contiguous");
  const totalSizeBytes = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  if (totalSizeBytes !== upload.value.declaredSizeBytes) return fail("conflict", "staged_size_mismatch");
  const rows = await db
    .update(artifactUploads)
    .set({ status: "complete" })
    .where(
      and(eq(artifactUploads.id, uploadId), eq(artifactUploads.ownerId, ownerId), eq(artifactUploads.status, "open")),
    )
    .returning();
  const row = rows[0];
  if (!row) return fail("conflict", "upload_state_changed");
  return ok({ upload: row, chunkCount: chunks.length, totalSizeBytes });
}

export async function deleteExpiredUploads(db: AppDb, now: Date): Promise<number> {
  const removed = await db
    .delete(artifactUploads)
    .where(and(lt(artifactUploads.expiresAt, now), ne(artifactUploads.status, "complete")))
    .returning({ id: artifactUploads.id });
  return removed.length;
}
