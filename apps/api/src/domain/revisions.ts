import { and, desc, eq } from "drizzle-orm";

import { artifactRevisions } from "../adapters/postgres/db/artifact-schema.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";

export const REVISION_HISTORY_LIMIT = 200;

export type RevisionRow = {
  id: string;
  revisionNumber: number;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
  createdAt: Date;
};

export type RevisionSummary = {
  id: string;
  revisionNumber: number;
  sizeBytes: number;
  createdAt: Date;
};

export async function revisionRow(
  db: AppDb,
  artifactId: string,
  revisionId: string,
): Promise<RevisionRow | undefined> {
  return (
    await db
      .select({
        id: artifactRevisions.id,
        revisionNumber: artifactRevisions.revision,
        sizeBytes: artifactRevisions.sizeBytes,
        storageKey: artifactRevisions.storageKey,
        sha256: artifactRevisions.sha256,
        createdAt: artifactRevisions.createdAt,
      })
      .from(artifactRevisions)
      .where(and(eq(artifactRevisions.id, revisionId), eq(artifactRevisions.artifactId, artifactId)))
  )[0];
}

export async function revisionHistory(
  db: AppDb,
  artifactId: string,
  limit = REVISION_HISTORY_LIMIT,
): Promise<RevisionSummary[]> {
  return db
    .select({
      id: artifactRevisions.id,
      revisionNumber: artifactRevisions.revision,
      sizeBytes: artifactRevisions.sizeBytes,
      createdAt: artifactRevisions.createdAt,
    })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, artifactId))
    .orderBy(desc(artifactRevisions.revision))
    .limit(limit);
}
