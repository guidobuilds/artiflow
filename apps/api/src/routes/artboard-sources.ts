import { and, eq } from "drizzle-orm";

import { artifacts, artifactRevisions } from "../adapters/postgres/db/artifact-schema.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";
import { getRevisionBytes } from "../adapters/storage/s3.ts";
import type { Storage } from "../adapters/storage/client.ts";
import { readableArtifactPredicate } from "./sharing.ts";
import type { ArtboardReadDeps, SourceArtifactRow } from "../viewer/artboards.ts";

const ARTBOARD_COLUMNS = {
  artifactId: artifacts.id,
  kind: artifacts.kind,
  deletedAt: artifacts.deletedAt,
  revisionId: artifactRevisions.id,
  revisionNumber: artifactRevisions.revision,
  sizeBytes: artifactRevisions.sizeBytes,
  storageKey: artifactRevisions.storageKey,
  sha256: artifactRevisions.sha256,
} as const;

export async function sourceArtifactOf(
  db: AppDb,
  viewerId: string,
  artifactId: string,
  revisionId: string,
): Promise<SourceArtifactRow | null> {
  const row = (
    await db
      .select(ARTBOARD_COLUMNS)
      .from(artifacts)
      .leftJoin(
        artifactRevisions,
        and(eq(artifactRevisions.artifactId, artifacts.id), eq(artifactRevisions.id, revisionId)),
      )
      .where(and(eq(artifacts.id, artifactId), readableArtifactPredicate(viewerId)))
  )[0];
  return row ?? null;
}

export async function currentSourceRevisionOf(
  db: AppDb,
  viewerId: string,
  artifactId: string,
): Promise<{ revisionId: string; revisionNumber: number; kind: string } | null> {
  const row = (
    await db
      .select({
        revisionId: artifactRevisions.id,
        revisionNumber: artifactRevisions.revision,
        kind: artifacts.kind,
      })
      .from(artifacts)
      .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
      .where(and(eq(artifacts.id, artifactId), readableArtifactPredicate(viewerId)))
  )[0];
  if (row === undefined || row.revisionId === null || row.revisionNumber === null) return null;
  return { revisionId: row.revisionId, revisionNumber: row.revisionNumber, kind: row.kind };
}

export function artboardDepsOf(input: {
  readonly db: AppDb;
  readonly storage: Storage;
  readonly viewerId: string | null;
  readonly origin: string | null;
  readonly maxBytes: number;
}): ArtboardReadDeps {
  return {
    origin: input.origin,
    maxBytes: input.maxBytes,
    sourceOf: async (artifactId, revisionId) =>
      input.viewerId === null ? null : sourceArtifactOf(input.db, input.viewerId, artifactId, revisionId),
    bytesOf: async (row) => {
      if (row.storageKey === null || row.sha256 === null) return null;
      const read = await getRevisionBytes({
        storage: input.storage,
        storageKey: row.storageKey,
        sha256: row.sha256,
        maxBytes: input.maxBytes,
      });
      return read.ok ? read.value.bytes : null;
    },
  };
}
