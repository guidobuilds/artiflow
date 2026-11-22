import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { MAX_COMMENT_BODY, MAX_COMMENT_QUOTE } from "@artiflow/contracts/comments";
import { ARTIFACT_KINDS, DEFAULT_ARTIFACT_KIND } from "@artiflow/domain/kinds";
import { user } from "./schema.ts";

export const MAX_ARTIFACT_BYTES = 16_777_216;
export const MAX_CHUNK_BYTES = 1_048_576;
export const MAX_ASSET_BYTES = 2_097_152;
export const ASSET_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const STAGING_TTL_MINUTES = 60;
export const DOCUMENT_FORMAT_VERSION = 1;
export const DOCUMENT_AUTHOR_KINDS = ["person", "agent"] as const;
export const DOCUMENT_OPERATION_RESULTS = ["applied", "rejected"] as const;

export { ARTIFACT_KINDS, DEFAULT_ARTIFACT_KIND };
export const SHARE_ROLES = ["reader", "editor", "commenter"] as const;
export const DEFAULT_SHARE_ROLE = "reader";

const date = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const ownerRef = (name: string) =>
  text(name)
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });
const hexSha256 = (column: string) => sql`${sql.identifier(column)} ~ '^[0-9a-f]{64}$'`;
const atMost = (column: string, cap: number) => sql`${sql.identifier(column)} <= ${sql.raw(String(cap))}`;

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: ownerRef("ownerId"),
    title: text("title"),
    currentRevisionId: text("currentRevisionId").references((): AnyPgColumn => artifactRevisions.id, {
      onDelete: "set null",
    }),
    observedSizeBytes: integer("observedSizeBytes"),
    publishedSeq: integer("publishedSeq").notNull().default(0),
    kind: text("kind").notNull().default(DEFAULT_ARTIFACT_KIND),
    deletedAt: date("deletedAt"),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    index("artifacts_ownerId_idx").on(table.ownerId),
    check("artifacts_observedSizeBytes_cap_check", atMost("observedSizeBytes", MAX_ARTIFACT_BYTES)),
    check("artifacts_kind_check", sql`${sql.identifier("kind")} in ('html', 'markdown', 'canvas', 'deck')`),
    check("artifacts_publishedSeq_check", sql`${sql.identifier("publishedSeq")} >= 0`),
  ],
);

export const artifactRevisions = pgTable(
  "artifactRevisions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    formatVersion: integer("formatVersion").notNull().default(DOCUMENT_FORMAT_VERSION),
    seqFrom: integer("seqFrom").notNull().default(0),
    seqTo: integer("seqTo").notNull().default(0),
    sizeBytes: integer("sizeBytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storageKey").notNull(),
    blockIndex: jsonb("blockIndex"),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("artifactRevisions_artifactId_revision_unique").on(table.artifactId, table.revision),
    index("artifactRevisions_storageKey_idx").on(table.storageKey),
    check("artifactRevisions_sizeBytes_cap_check", atMost("sizeBytes", MAX_ARTIFACT_BYTES)),
    check("artifactRevisions_sha256_hex_check", hexSha256("sha256")),
    check("artifactRevisions_formatVersion_check", sql`${sql.identifier("formatVersion")} >= 1`),
    check(
      "artifactRevisions_seqRange_check",
      sql`${sql.identifier("seqFrom")} >= 0 and ${sql.identifier("seqTo")} >= ${sql.identifier("seqFrom")}`,
    ),
  ],
);

export const artifactUploads = pgTable(
  "artifactUploads",
  {
    id: text("id").primaryKey(),
    ownerId: ownerRef("ownerId"),
    declaredSizeBytes: integer("declaredSizeBytes").notNull(),
    declaredSha256: text("declaredSha256").notNull(),
    expiresAt: date("expiresAt").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("artifactUploads_expiresAt_idx").on(table.expiresAt),
    index("artifactUploads_ownerId_idx").on(table.ownerId),
    check("artifactUploads_status_check", sql`${sql.identifier("status")} in ('open', 'complete', 'aborted')`),
    check("artifactUploads_declaredSha256_hex_check", hexSha256("declaredSha256")),
  ],
);

export const artifactChunks = pgTable(
  "artifactChunks",
  {
    id: text("id").primaryKey(),
    uploadId: text("uploadId")
      .notNull()
      .references(() => artifactUploads.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunkIndex").notNull(),
    sizeBytes: integer("sizeBytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("artifactChunks_uploadId_idx").on(table.uploadId),
    uniqueIndex("artifactChunks_uploadId_chunkIndex_unique").on(table.uploadId, table.chunkIndex),
    check("artifactChunks_sizeBytes_cap_check", atMost("sizeBytes", MAX_CHUNK_BYTES)),
    check("artifactChunks_sha256_hex_check", hexSha256("sha256")),
  ],
);

export const assets = pgTable(
  "assets",
  {
    sha256: text("sha256").primaryKey(),
    sizeBytes: integer("sizeBytes").notNull(),
    contentType: text("contentType").notNull(),
    storageKey: text("storageKey").notNull(),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  () => [
    check("assets_sizeBytes_cap_check", atMost("sizeBytes", MAX_ASSET_BYTES)),
    check("assets_sha256_hex_check", hexSha256("sha256")),
    check(
      "assets_contentType_check",
      sql`${sql.identifier("contentType")} in (${sql.raw(ASSET_CONTENT_TYPES.map((type) => `'${type}'`).join(", "))})`,
    ),
  ],
);

export const artifactAssets = pgTable(
  "artifactAssets",
  {
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    assetSha256: text("assetSha256")
      .notNull()
      .references(() => assets.sha256, { onDelete: "cascade" }),
    firstSeenAt: date("firstSeenAt").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.assetSha256] }),
    index("artifactAssets_assetSha256_idx").on(table.assetSha256),
  ],
);

export const artifactShares = pgTable(
  "artifactShares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    sharedWithUserId: text("sharedWithUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedByUserId: text("grantedByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default(DEFAULT_SHARE_ROLE),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("artifactShares_artifactId_sharedWithUserId_unique").on(table.artifactId, table.sharedWithUserId),
    index("artifactShares_sharedWithUserId_idx").on(table.sharedWithUserId),
    index("artifactShares_artifactId_idx").on(table.artifactId),
    check("artifactShares_role_check", sql`${sql.identifier("role")} in ('reader', 'editor', 'commenter')`),
  ],
);

export { MAX_COMMENT_BODY, MAX_COMMENT_QUOTE };
export const COMMENT_ANCHOR_KINDS = ["text-range", "element", "page-point", "board-point", "slide-point"] as const;
export const artifactComments = pgTable(
  "artifactComments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    authorId: ownerRef("authorId"),
    parentId: uuid("parentId").references((): AnyPgColumn => artifactComments.id, { onDelete: "cascade" }),
    anchor: jsonb("anchor"),
    revisionId: text("revisionId").references((): AnyPgColumn => artifactRevisions.id, { onDelete: "set null" }),
    resolvedBy: text("resolvedBy").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    resolvedAt: date("resolvedAt"),
    createdAt: date("createdAt").notNull().defaultNow(),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    index("artifactComments_artifactId_idx").on(table.artifactId),
    index("artifactComments_parentId_idx").on(table.parentId),
    check(
      "artifactComments_root_anchor_check",
      sql`(${sql.identifier("parentId")} is null and ${sql.identifier("anchor")} is not null) or (${sql.identifier("parentId")} is not null and ${sql.identifier("anchor")} is null)`,
    ),
    check(
      "artifactComments_anchor_kind_check",
      sql`${sql.identifier("anchor")} is null or ${sql.identifier("anchor")} ->> 'kind' in ('text-range', 'element', 'page-point', 'board-point', 'slide-point')`,
    ),
    check(
      "artifactComments_body_cap_check",
      sql`char_length(${sql.identifier("body")}) <= ${sql.raw(String(MAX_COMMENT_BODY))}`,
    ),
    check(
      "artifactComments_quote_cap_check",
      sql`${sql.identifier("anchor")} is null or char_length(${sql.identifier("anchor")} ->> 'quotedText') <= ${sql.raw(String(MAX_COMMENT_QUOTE))}`,
    ),
  ],
);

export const artifactPublicLinks = pgTable(
  "artifactPublicLinks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull(),
    revokedAt: date("revokedAt"),
    rotatedFromId: uuid("rotatedFromId").references((): AnyPgColumn => artifactPublicLinks.id, {
      onDelete: "set null",
    }),
    showComments: boolean("showComments").notNull().default(false),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("artifactPublicLinks_tokenHash_unique").on(table.tokenHash),
    index("artifactPublicLinks_artifactId_idx").on(table.artifactId),
    check("artifactPublicLinks_tokenHash_hex_check", hexSha256("tokenHash")),
  ],
);

export const documentDrafts = pgTable(
  "documentDrafts",
  {
    artifactId: text("artifactId")
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(0),
    formatVersion: integer("formatVersion").notNull().default(DOCUMENT_FORMAT_VERSION),
    state: jsonb("state").notNull(),
    updatedByUserId: text("updatedByUserId").references(() => user.id, { onDelete: "set null" }),
    updatedAt: date("updatedAt").notNull().defaultNow(),
  },
  () => [
    check("documentDrafts_seq_check", sql`${sql.identifier("seq")} >= 0`),
    check("documentDrafts_formatVersion_check", sql`${sql.identifier("formatVersion")} >= 1`),
  ],
);

export const documentOperations = pgTable(
  "documentOperations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: text("artifactId")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    baseSeq: integer("baseSeq").notNull(),
    authorKind: text("authorKind").notNull(),
    authorId: text("authorId").notNull(),
    ops: jsonb("ops").notNull(),
    result: text("result").notNull(),
    idempotencyKey: text("idempotencyKey").notNull(),
    createdAt: date("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("documentOperations_artifactId_seq_unique")
      .on(table.artifactId, table.seq)
      .where(sql`${sql.identifier("result")} = 'applied'`),
    uniqueIndex("documentOperations_idempotencyKey_unique").on(table.idempotencyKey),
    check("documentOperations_seq_check", sql`${sql.identifier("seq")} >= 0`),
    check("documentOperations_baseSeq_check", sql`${sql.identifier("baseSeq")} >= 0`),
    check("documentOperations_authorKind_check", sql`${sql.identifier("authorKind")} in ('person', 'agent')`),
    check("documentOperations_result_check", sql`${sql.identifier("result")} in ('applied', 'rejected')`),
  ],
);

export const artifactSchema = {
  artifacts,
  artifactRevisions,
  artifactUploads,
  artifactChunks,
  assets,
  artifactAssets,
  artifactShares,
  artifactPublicLinks,
  artifactComments,
  documentOperations,
  documentDrafts,
};
