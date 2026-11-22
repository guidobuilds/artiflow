import { and, eq, isNull } from "drizzle-orm";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";
import { artifacts, artifactRevisions } from "../adapters/postgres/db/artifact-schema.ts";

import { markArtifactDeleted } from "./commits.ts";
import { deleteRevisionBytes, type DeletedRevision, type StorageResult } from "../adapters/storage/s3.ts";
import type { Storage } from "../adapters/storage/client.ts";

async function revisionKeys(db: AppDb, artifactId: string): Promise<string[]> {
  return (
    await db
      .select({ storageKey: artifactRevisions.storageKey })
      .from(artifactRevisions)
      .where(eq(artifactRevisions.artifactId, artifactId))
  ).map((row) => row.storageKey);
}

async function isLiveOwnedArtifact(db: AppDb, artifactId: string, ownerId: string): Promise<boolean> {
  return (
    (
      await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId), isNull(artifacts.deletedAt)))
    ).length > 0
  );
}
export type DeleteRevisionFn = (input: {
  storage: Storage;
  storageKey: string;
}) => Promise<StorageResult<DeletedRevision>>;
export type DeletionDeps = { database: Database; storage: Storage; deleteRevisionBytes?: DeleteRevisionFn };
export type DeletionWiring = { publicOrigin: string; deleteRevisionBytes?: DeleteRevisionFn };
export type DeletionOutcome = { ok: true; deletedAt: Date } | { ok: false };

export async function cleanupArtifactBlobs(deps: DeletionDeps, deletedArtifactId: string): Promise<string[]> {
  const remove: DeleteRevisionFn = deps.deleteRevisionBytes ?? deleteRevisionBytes;
  const removed: string[] = [];
  for (const storageKey of await revisionKeys(deps.database.db, deletedArtifactId)) {
    if ((await remove({ storage: deps.storage, storageKey })).ok) removed.push(storageKey);
  }
  return removed;
}

export async function deleteArtifact(
  deps: DeletionDeps,
  artifactId: string,
  ownerId: string,
): Promise<DeletionOutcome> {
  if (!(await isLiveOwnedArtifact(deps.database.db, artifactId, ownerId))) return { ok: false };
  const marked = await markArtifactDeleted(deps.database.db, artifactId, ownerId);
  if (!marked.ok) return { ok: false };
  try {
    await cleanupArtifactBlobs(deps, artifactId);
  } catch {}
  return { ok: true, deletedAt: marked.value.deletedAt };
}
