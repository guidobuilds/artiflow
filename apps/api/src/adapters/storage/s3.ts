import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  ASSET_CONTENT_TYPES,
  MAX_ARTIFACT_BYTES,
  MAX_ASSET_BYTES,
  MAX_CHUNK_BYTES,
} from "../postgres/db/artifact-schema.ts";
import type { Storage } from "../storage/client.ts";

export const REVISION_KEY_PREFIX = "artifacts/";
export const STAGING_KEY_PREFIX = "staging/";
export const ASSET_KEY_PREFIX = "assets/";

const REVISION_KEY_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ASSET_KEY_ID = /^[0-9a-f]{64}$/;

export const stagingStorageKey = (sha256: string): string => `${STAGING_KEY_PREFIX}${sha256}`;

export const newRevisionStorageKey = (): string => `${REVISION_KEY_PREFIX}${randomUUID()}`;

export const assetStorageKey = (sha256: string): string => `${ASSET_KEY_PREFIX}${sha256}`;

export const isAssetStorageKey = (storageKey: unknown): storageKey is string =>
  typeof storageKey === "string" &&
  storageKey.startsWith(ASSET_KEY_PREFIX) &&
  ASSET_KEY_ID.test(storageKey.slice(ASSET_KEY_PREFIX.length));

export const isRevisionStorageKey = (storageKey: unknown): storageKey is string =>
  typeof storageKey === "string" &&
  storageKey.startsWith(REVISION_KEY_PREFIX) &&
  REVISION_KEY_ID.test(storageKey.slice(REVISION_KEY_PREFIX.length));

export type StorageErrorKind = "validation" | "too_large" | "digest_mismatch" | "conflict" | "not_found";
export type StorageFailure = { ok: false; kind: StorageErrorKind; reason: string };
export type StorageResult<T> = { ok: true; value: T } | StorageFailure;

const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });
const fail = (kind: StorageErrorKind, reason: string): StorageFailure => ({ ok: false, kind, reason });
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const isHexDigest = (value: unknown): value is string => typeof value === "string" && HEX_SHA256.test(value);
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const statusOf = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

export type RevisionRef = { storageKey: string; sizeBytes: number };
export type PutRevisionInput = { storage: Storage; storageKey: string; sha256: string; bytes: Uint8Array };

export async function putRevisionBytes(input: PutRevisionInput): Promise<StorageResult<RevisionRef>> {
  const { storage, storageKey, sha256, bytes } = input;
  if (!isRevisionStorageKey(storageKey)) return fail("validation", "storage_key_invalid");
  if (!isHexDigest(sha256)) return fail("validation", "digest_not_lowercase_hex_sha256");
  if (!(bytes instanceof Uint8Array)) return fail("validation", "bytes_required");
  if (bytes.length === 0) return fail("validation", "empty_payload");
  if (bytes.length > MAX_ARTIFACT_BYTES) return fail("too_large", "payload_exceeds_artifact_cap");
  if (digestOf(bytes) !== sha256) return fail("digest_mismatch", "payload_does_not_match_declared_digest");
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: storageKey,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: "text/html; charset=utf-8",
      }),
    );
  } catch {
    return fail("conflict", "storage_request_failed");
  }
  return ok({ storageKey, sizeBytes: bytes.length });
}

export type RevisionBytes = { storageKey: string; bytes: Uint8Array<ArrayBuffer>; sizeBytes: number };
export type GetRevisionInput = { storage: Storage; storageKey: string; sha256: string; maxBytes?: number };

type ReadStoredInput = {
  storage: Storage;
  storageKey: string;
  sha256: string;
  cap: number;
  missingReason: string;
};

async function readStoredBytes(input: ReadStoredInput): Promise<StorageResult<RevisionBytes>> {
  const { storage, storageKey, sha256, cap, missingReason } = input;
  try {
    const head = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    if ((head.ContentLength ?? 0) > cap) return fail("too_large", "stored_object_exceeds_read_cap");
  } catch (error) {
    return statusOf(error) === 404 ? fail("not_found", missingReason) : fail("conflict", "storage_request_failed");
  }
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    const response = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    if (!response.Body) return fail("conflict", "storage_response_without_body");
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      sizeBytes += chunk.length;
      if (sizeBytes > cap) return fail("too_large", "streamed_object_exceeds_read_cap");
      chunks.push(chunk);
    }
  } catch (error) {
    return statusOf(error) === 404 ? fail("not_found", missingReason) : fail("conflict", "storage_request_failed");
  }
  if (sizeBytes === 0) return fail("conflict", "stored_object_is_empty");
  const bytes = Buffer.concat(chunks, sizeBytes);
  if (digestOf(bytes) !== sha256) return fail("digest_mismatch", "stored_bytes_do_not_match_declared_digest");
  return ok({ storageKey, bytes, sizeBytes });
}

export async function getRevisionBytes(input: GetRevisionInput): Promise<StorageResult<RevisionBytes>> {
  const { storage, storageKey, sha256 } = input;
  if (!isRevisionStorageKey(storageKey)) return fail("validation", "storage_key_invalid");
  if (!isHexDigest(sha256)) return fail("validation", "digest_not_lowercase_hex_sha256");
  const cap = input.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_ARTIFACT_BYTES)
    return fail("validation", "max_bytes_out_of_range");
  return readStoredBytes({ storage, storageKey, sha256, cap, missingReason: "revision_not_stored" });
}

export type PutAssetInput = { storage: Storage; sha256: string; contentType: string; bytes: Uint8Array };

export async function putAssetBytes(input: PutAssetInput): Promise<StorageResult<RevisionRef>> {
  const { storage, sha256, contentType, bytes } = input;
  if (!isHexDigest(sha256)) return fail("validation", "digest_not_lowercase_hex_sha256");
  if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(contentType))
    return fail("validation", "content_type_not_raster");
  if (!(bytes instanceof Uint8Array)) return fail("validation", "bytes_required");
  if (bytes.length === 0) return fail("validation", "empty_payload");
  if (bytes.length > MAX_ASSET_BYTES) return fail("too_large", "payload_exceeds_asset_cap");
  if (digestOf(bytes) !== sha256) return fail("digest_mismatch", "payload_does_not_match_declared_digest");
  const storageKey = assetStorageKey(sha256);
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: storageKey,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: contentType,
      }),
    );
  } catch {
    return fail("conflict", "storage_request_failed");
  }
  return ok({ storageKey, sizeBytes: bytes.length });
}

export type GetAssetInput = { storage: Storage; storageKey: string; sha256: string };

export async function getAssetBytes(input: GetAssetInput): Promise<StorageResult<RevisionBytes>> {
  const { storage, storageKey, sha256 } = input;
  if (!isAssetStorageKey(storageKey)) return fail("validation", "storage_key_invalid");
  if (!isHexDigest(sha256)) return fail("validation", "digest_not_lowercase_hex_sha256");
  return readStoredBytes({ storage, storageKey, sha256, cap: MAX_ASSET_BYTES, missingReason: "asset_not_stored" });
}

export type ListedRevisionObject = { storageKey: string; lastModified: Date };
export type ListRevisionKeysInput = { storage: Storage; continuationToken?: string; maxKeys?: number };
export type ListedRevisionKeys = { objects: ListedRevisionObject[]; nextToken?: string };

export async function listRevisionKeys(input: ListRevisionKeysInput): Promise<StorageResult<ListedRevisionKeys>> {
  const { storage, continuationToken } = input;
  const maxKeys = input.maxKeys ?? 1000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) return fail("validation", "max_keys_out_of_range");
  try {
    const response = await storage.client.send(
      new ListObjectsV2Command({
        Bucket: storage.bucket,
        Prefix: REVISION_KEY_PREFIX,
        MaxKeys: maxKeys,
        ContinuationToken: continuationToken,
      }),
    );
    const objects: ListedRevisionObject[] = [];
    for (const entry of response.Contents ?? []) {
      const { Key: storageKey, LastModified: lastModified } = entry;
      if (!isRevisionStorageKey(storageKey)) continue;
      if (!(lastModified instanceof Date) || Number.isNaN(lastModified.getTime())) continue;
      objects.push({ storageKey, lastModified });
    }
    const nextToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    return ok({ objects, nextToken: nextToken === undefined || nextToken === "" ? undefined : nextToken });
  } catch {
    return fail("conflict", "storage_request_failed");
  }
}

export type DeleteRevisionInput = { storage: Storage; storageKey: string };
export type DeletedRevision = { storageKey: string };

export async function deleteRevisionBytes(input: DeleteRevisionInput): Promise<StorageResult<DeletedRevision>> {
  const { storage, storageKey } = input;
  if (!isRevisionStorageKey(storageKey)) return fail("validation", "storage_key_invalid");
  try {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    return ok({ storageKey });
  } catch (error) {
    return statusOf(error) === 404 ? ok({ storageKey }) : fail("conflict", "storage_request_failed");
  }
}

export async function putStagingChunk(storage: Storage, sha256: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: stagingStorageKey(sha256),
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: "application/octet-stream",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function getStagingChunk(storage: Storage, sha256: string): Promise<Uint8Array | undefined> {
  try {
    const response = await storage.client.send(
      new GetObjectCommand({ Bucket: storage.bucket, Key: stagingStorageKey(sha256) }),
    );
    if (!response.Body) return undefined;
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of response.Body as AsyncIterable<Uint8Array>) {
      total += part.length;
      if (total > MAX_CHUNK_BYTES) return undefined;
      parts.push(part);
    }
    const bytes = Buffer.concat(parts, total);
    return digestOf(bytes) === sha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export type DeleteStagingChunkInput = { storage: Storage; sha256: string };

export async function deleteStagingChunk(input: DeleteStagingChunkInput): Promise<StorageResult<DeletedRevision>> {
  const { storage, sha256 } = input;
  if (!isHexDigest(sha256)) return fail("validation", "digest_not_lowercase_hex_sha256");
  const storageKey = stagingStorageKey(sha256);
  try {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    return ok({ storageKey });
  } catch (error) {
    return statusOf(error) === 404 ? ok({ storageKey }) : fail("conflict", "storage_request_failed");
  }
}
