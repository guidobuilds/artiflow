import { and, asc, eq, getTableColumns, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { AnyCommentAnchor } from "@artiflow/domain/comment-anchors";
import type { AppDb, AppTx } from "./db/client.ts";
import { artifactComments, artifactRevisions, artifacts, artifactShares } from "./db/artifact-schema.ts";
import { user } from "./db/schema.ts";

type Query = AppDb | AppTx;
export type CommentRow = typeof artifactComments.$inferSelect;
export type CommentDocument = { id: string; ownerId: string; kind: string; access: string; deletedAt: Date | null };

export async function commentDocument(
  db: Query,
  userId: string,
  artifactId: string,
  access: "owner" | "shared",
  lock = false,
): Promise<CommentDocument | undefined> {
  const query = db
    .select({
      id: artifacts.id,
      ownerId: artifacts.ownerId,
      kind: artifacts.kind,
      deletedAt: artifacts.deletedAt,
      access:
        access === "owner"
          ? sql<string>`'owner'`
          : sql<string>`case when ${artifacts.ownerId} = ${userId} then 'owner' else ${artifactShares.role} end`,
    })
    .from(artifacts)
    .$dynamic();
  if (access === "shared") {
    query.leftJoin(
      artifactShares,
      and(eq(artifactShares.artifactId, artifacts.id), eq(artifactShares.sharedWithUserId, userId)),
    );
  }
  query.where(
    and(
      eq(artifacts.id, artifactId),
      access === "owner"
        ? eq(artifacts.ownerId, userId)
        : and(
            isNull(artifacts.deletedAt),
            or(eq(artifacts.ownerId, userId), isNotNull(artifactShares.sharedWithUserId)),
          ),
    ),
  );
  return (await (lock ? query.for("update", { of: artifacts }) : query))[0];
}

export async function findComment(db: Query, artifactId: string, commentId: string) {
  return (
    await db
      .select()
      .from(artifactComments)
      .where(and(eq(artifactComments.id, commentId), eq(artifactComments.artifactId, artifactId)))
  )[0];
}

export async function insertComment(
  db: Query,
  input: {
    artifactId: string;
    authorId: string;
    parentId: string | null;
    anchor: AnyCommentAnchor | null;
    revisionId: string | null;
    body: string;
  },
) {
  return (
    await db
      .insert(artifactComments)
      .values({ ...input })
      .returning({ id: artifactComments.id })
  )[0]!;
}

export async function listComments(db: Query, artifactId: string, includeAuthors = false) {
  const query = db
    .select({
      ...getTableColumns(artifactComments),
      authorName: user.name,
      authorImage: user.image,
    })
    .from(artifactComments)
    .leftJoin(user, eq(user.id, artifactComments.authorId))
    .where(and(eq(artifactComments.artifactId, artifactId), includeAuthors ? isNotNull(user.id) : undefined))
    .orderBy(asc(artifactComments.createdAt), asc(artifactComments.id));
  return query;
}

export async function setCommentResolved(db: Query, commentId: string, resolved: boolean, resolvedBy?: string) {
  await db
    .update(artifactComments)
    .set({
      resolvedAt: resolved ? sql`now()` : null,
      resolvedBy: resolved ? (resolvedBy ?? null) : null,
      updatedAt: sql`now()`,
    })
    .where(eq(artifactComments.id, commentId));
}

export async function deleteComment(db: Query, commentId: string) {
  await db.delete(artifactComments).where(eq(artifactComments.id, commentId));
}

export async function currentRevision(db: Query, artifactId: string, requireMatchingArtifact = false) {
  return (
    await db
      .select({
        id: artifactRevisions.id,
        storageKey: artifactRevisions.storageKey,
        sha256: artifactRevisions.sha256,
      })
      .from(artifacts)
      .innerJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
      .where(
        and(
          eq(artifacts.id, artifactId),
          requireMatchingArtifact ? eq(artifactRevisions.artifactId, artifacts.id) : undefined,
        ),
      )
  )[0];
}

export async function selectReadRevision(db: Query, ownerId: string, artifactId: string, revisionId?: string) {
  return (
    await db
      .select({
        id: artifactRevisions.id,
        revisionNumber: artifactRevisions.revision,
        sha256: artifactRevisions.sha256,
        sizeBytes: artifactRevisions.sizeBytes,
        storageKey: artifactRevisions.storageKey,
        deletedAt: artifacts.deletedAt,
        kind: artifacts.kind,
        title: artifacts.title,
      })
      .from(artifacts)
      .leftJoin(
        artifactRevisions,
        and(
          eq(artifactRevisions.artifactId, artifacts.id),
          eq(artifactRevisions.id, sql`coalesce(${revisionId ?? null}::text, ${artifacts.currentRevisionId})`),
        ),
      )
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId)))
  )[0];
}
