import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";

import type { createAuth } from "../auth.ts";
import {
  ASSET_CONTENT_TYPES,
  MAX_ASSET_BYTES,
  artifactAssets,
  artifactPublicLinks,
  artifactShares,
  artifacts,
  assets,
} from "../adapters/postgres/db/artifact-schema.ts";
import { getAssetBytes, putAssetBytes } from "../adapters/storage/s3.ts";
import type { Storage } from "../adapters/storage/client.ts";
import { isUuid, jsonError, sessionUserId } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";
import { hashLinkToken, readableArtifactPredicate } from "./sharing.ts";

type AssetsAuth = ReturnType<typeof createAuth>;
export type AssetsOptions = {
  database: Database;
  auth: AssetsAuth;
  storage: Storage;
  publicOrigin: string;
  principal?: true;
};

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MISSING_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};
const IMMUTABLE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

const isRasterType = (value: string | undefined): value is string =>
  value !== undefined && (ASSET_CONTENT_TYPES as readonly string[]).includes(value);
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function editableArtifact(db: AppDb, userId: string, artifactId: string) {
  return (
    await db
      .select({
        id: artifacts.id,
        access: sql<string>`case when ${artifacts.ownerId} = ${userId} then 'owner' else coalesce(${artifactShares.role}, 'none') end`,
      })
      .from(artifacts)
      .leftJoin(
        artifactShares,
        and(eq(artifactShares.artifactId, artifacts.id), eq(artifactShares.sharedWithUserId, userId)),
      )
      .where(
        and(
          eq(artifacts.id, artifactId),
          isNull(artifacts.deletedAt),
          or(eq(artifacts.ownerId, userId), isNotNull(artifactShares.sharedWithUserId)),
        ),
      )
  )[0];
}

const canEdit = (access: string): boolean => access === "owner" || access === "editor";

async function storedAsset(db: AppDb, sha256: string) {
  return (
    await db
      .select({ sha256: assets.sha256, sizeBytes: assets.sizeBytes, contentType: assets.contentType })
      .from(assets)
      .where(eq(assets.sha256, sha256))
  )[0];
}

async function referenceAsset(db: AppDb, artifactId: string, sha256: string): Promise<boolean> {
  const inserted = await db
    .insert(artifactAssets)
    .values({ artifactId, assetSha256: sha256 })
    .onConflictDoNothing({ target: [artifactAssets.artifactId, artifactAssets.assetSha256] })
    .returning({ assetSha256: artifactAssets.assetSha256 });
  return inserted.length > 0;
}

async function recordAsset(
  db: AppDb,
  row: { sha256: string; sizeBytes: number; contentType: string; storageKey: string },
): Promise<void> {
  await db
    .insert(assets)
    .values(row)
    .onConflictDoNothing({ target: assets.sha256 })
    .returning({ sha256: assets.sha256 });
}

type ReadableAsset = { storageKey: string; contentType: string; sizeBytes: number };

async function deliverableAsset(
  db: AppDb,
  input: { artifactId: string; sha256: string; userId: string | null; tokenHash: string | null },
): Promise<ReadableAsset | undefined> {
  const access =
    input.userId !== null
      ? readableArtifactPredicate(input.userId)
      : input.tokenHash !== null
        ? sql`exists (select 1 from ${artifactPublicLinks} where ${artifactPublicLinks.artifactId} = ${artifacts.id} and ${artifactPublicLinks.tokenHash} = ${input.tokenHash} and ${artifactPublicLinks.revokedAt} is null)`
        : sql`false`;
  return (
    await db
      .select({
        storageKey: assets.storageKey,
        contentType: assets.contentType,
        sizeBytes: assets.sizeBytes,
      })
      .from(assets)
      .innerJoin(artifactAssets, eq(artifactAssets.assetSha256, assets.sha256))
      .innerJoin(artifacts, eq(artifacts.id, artifactAssets.artifactId))
      .where(and(eq(artifactAssets.artifactId, input.artifactId), eq(assets.sha256, input.sha256), access))
  )[0];
}

export type StoredAssetRef = { sha256: string; sizeBytes: number; contentType: string };
export type AssetStoreRefusal = {
  ok: false;
  code: "unsupported_content_type" | "too_large" | "empty_asset" | "artifact_unavailable";
  reason: string;
  status: 400 | 413 | 415 | 500;
  maxBytes?: number;
};
export type AssetStoreOutcome = { ok: true; value: StoredAssetRef } | AssetStoreRefusal;
export type AssetStoreInput = {
  db: AppDb;
  storage: Storage;
  artifactId: string;
  contentType: string;
  bytes: Uint8Array;
};

export async function storeArtifactAsset(input: AssetStoreInput): Promise<AssetStoreOutcome> {
  const contentType = input.contentType.trim().toLowerCase();
  if (!isRasterType(contentType))
    return { ok: false, code: "unsupported_content_type", reason: "content_type_not_raster", status: 415 };
  if (input.bytes.length === 0) return { ok: false, code: "empty_asset", reason: "empty_asset", status: 400 };
  if (input.bytes.length > MAX_ASSET_BYTES)
    return {
      ok: false,
      code: "too_large",
      reason: "payload_exceeds_asset_cap",
      status: 413,
      maxBytes: MAX_ASSET_BYTES,
    };
  const sha256 = sha256Of(input.bytes);
  const existing = await storedAsset(input.db, sha256);
  if (existing) {
    await referenceAsset(input.db, input.artifactId, sha256);
    return { ok: true, value: existing };
  }
  const stored = await putAssetBytes({ storage: input.storage, sha256, contentType, bytes: input.bytes });
  if (!stored.ok) return { ok: false, code: "artifact_unavailable", reason: "asset_storage_failed", status: 500 };
  await recordAsset(input.db, {
    sha256,
    sizeBytes: input.bytes.length,
    contentType,
    storageKey: stored.value.storageKey,
  });
  await referenceAsset(input.db, input.artifactId, sha256);
  return { ok: true, value: { sha256, sizeBytes: input.bytes.length, contentType } };
}

export function createAssetsApp(options: AssetsOptions): Hono {
  const { database, auth, storage, publicOrigin } = options;
  const db = database.db;
  const app = new Hono();

  const missing = (c: Context): Response => c.json({ error: "not_found" }, 404, MISSING_HEADERS);
  const tooLarge = (c: Context): Response => c.json({ error: "too_large", maxBytes: MAX_ASSET_BYTES }, 413);

  app.post("/api/artifacts/:id/assets", async (c) => {
    const artifactId = c.req.param("id") ?? "";
    if (!options.principal && c.req.header("origin") !== publicOrigin) return jsonError(c, "origin_not_allowed", 403);
    const contentType = c.req.header("content-type")?.trim().toLowerCase();
    if (!isRasterType(contentType)) return jsonError(c, "unsupported_content_type", 415);
    if (!isUuid(artifactId)) return jsonError(c, "not_found", 404);
    const userId = options.principal
      ? (readPrincipal(c.req.raw.headers)?.userId ?? null)
      : await sessionUserId(auth, c.req.raw.headers);
    if (!userId) return jsonError(c, "unauthorized", 401);
    const artifact = await editableArtifact(db, userId, artifactId);
    if (!artifact) return jsonError(c, "not_found", 404);
    if (!canEdit(artifact.access)) return jsonError(c, "forbidden", 403);
    const declared = c.req.header("content-length");
    if (declared === undefined) return c.json({ error: "content_length_required" }, 411);
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) return jsonError(c, "invalid_content_length", 400);
    if (declaredBytes > MAX_ASSET_BYTES) return tooLarge(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length !== declaredBytes) return jsonError(c, "size_mismatch", 400);
    const stored = await storeArtifactAsset({ db, storage, artifactId, contentType, bytes });
    if (!stored.ok)
      return c.json(
        { error: stored.code, ...(stored.maxBytes === undefined ? {} : { maxBytes: stored.maxBytes }) },
        stored.status,
      );
    return c.json(
      { id: stored.value.sha256, sizeBytes: stored.value.sizeBytes, contentType: stored.value.contentType },
      201,
    );
  });

  app.get("/artifact/:id/asset/:sha256", async (c) => {
    const artifactId = c.req.param("id");
    const sha256 = c.req.param("sha256");
    if (!isUuid(artifactId) || !HEX_SHA256.test(sha256)) return missing(c);
    const token = c.req.query("token");
    const tokenHash = token !== undefined && LINK_TOKEN_RE.test(token) ? hashLinkToken(token) : null;
    const userId = await sessionUserId(auth, c.req.raw.headers);
    if (userId === null && tokenHash === null) return jsonError(c, "unauthorized", 401);
    const row = await deliverableAsset(db, { artifactId, sha256, userId, tokenHash });
    if (!row) return missing(c);
    const read = await getAssetBytes({ storage, storageKey: row.storageKey, sha256 });
    if (!read.ok) return missing(c);
    return c.body(read.value.bytes, 200, { ...IMMUTABLE_HEADERS, "content-type": row.contentType });
  });

  return app;
}
