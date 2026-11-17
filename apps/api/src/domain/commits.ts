import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  artifacts,
  artifactRevisions,
  MAX_ARTIFACT_BYTES,
  ARTIFACT_KINDS,
  DEFAULT_ARTIFACT_KIND,
} from "../adapters/postgres/db/artifact-schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";

export type CommitErrorKind = "not_found" | "conflict" | "concurrent_commit" | "gone" | "validation" | "error";
export type CommitFailure = { ok: false; kind: CommitErrorKind; reason: string; currentRevisionId: string | null };
export type CommitResult<T> = { ok: true; value: T } | CommitFailure;
export type RevisionInput = {
  revision: number;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  observedSizeBytes: number;
};
export type CurrentState = {
  currentRevisionId: string | null;
  observedSizeBytes: number | null;
  deletedAt: Date | null;
  revisionCount: number;
  kind: string;
};
export type Committed = { revisionId: string; revisionNumber: number; observedSizeBytes: number };
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const ok = <T>(value: T): CommitResult<T> => ({ ok: true, value });
const fail = (kind: CommitErrorKind, reason: string, currentRevisionId: string | null = null): CommitFailure => ({
  ok: false,
  kind,
  reason,
  currentRevisionId,
});
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isSize = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_ARTIFACT_BYTES;
const errorCode = (error: unknown): string | undefined =>
  (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;

class FailureSignal extends Error {
  readonly failure: CommitFailure;
  constructor(failure: CommitFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

const insertRevision = (tx: AppTx, artifactId: string, revisionId: string, next: RevisionInput): Promise<unknown> =>
  tx.insert(artifactRevisions).values({
    id: revisionId,
    artifactId,
    revision: next.revision,
    sizeBytes: next.sizeBytes,
    sha256: next.sha256,
    storageKey: next.storageKey,
  });

function validateRevision(next: RevisionInput): CommitFailure | undefined {
  if (!Number.isInteger(next.revision) || next.revision < 1) return fail("validation", "revision_number_out_of_range");
  if (!isSize(next.sizeBytes) || !isSize(next.observedSizeBytes))
    return fail("validation", "revision_size_out_of_range");
  if (!HEX_SHA256.test(next.sha256)) return fail("validation", "revision_digest_not_lowercase_hex_sha256");
  return isId(next.storageKey) ? undefined : fail("validation", "revision_storage_key_required");
}

async function inTransaction<T>(db: AppDb, run: (tx: AppTx) => Promise<CommitResult<T>>): Promise<CommitResult<T>> {
  try {
    return await db.transaction(async (tx) => {
      const result = await run(tx);
      if (!result.ok) throw new FailureSignal(result);
      return result;
    });
  } catch (error) {
    if (error instanceof FailureSignal) return error.failure;
    const code = errorCode(error);
    if (code === "23505") return fail("conflict", "unique_constraint_violation");
    if (code === "23514") return fail("validation", "check_constraint_violation");
    if (code === "23503") return fail("not_found", "foreign_key_violation");
    return fail("error", "commit_transaction_failed");
  }
}

export async function getCurrentState(
  db: AppDb,
  artifactId: string,
  ownerId: string,
): Promise<CommitResult<CurrentState>> {
  if (!isId(artifactId) || !isId(ownerId)) return fail("validation", "artifact_and_owner_id_required");
  const rows = await db
    .select({
      currentRevisionId: artifacts.currentRevisionId,
      observedSizeBytes: artifacts.observedSizeBytes,
      deletedAt: artifacts.deletedAt,
      kind: artifacts.kind,
      revisionCount: sql<number>`count(${artifactRevisions.id})::int`,
    })
    .from(artifacts)
    .leftJoin(artifactRevisions, eq(artifactRevisions.artifactId, artifacts.id))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId)))
    .groupBy(artifacts.id);
  return rows[0] ? ok(rows[0]) : fail("not_found", "artifact_not_visible_to_owner");
}

export async function createArtifactWithRevision(
  db: AppDb,
  input: {
    ownerId: string;
    artifactId?: string;
    title: string | null;
    kind?: string;
    revision: RevisionInput;
  },
): Promise<CommitResult<Committed & { artifactId: string }>> {
  const { ownerId, title, revision } = input;
  if (!isId(ownerId)) return fail("validation", "owner_id_required");
  if (input.kind !== undefined && !(ARTIFACT_KINDS as readonly string[]).includes(input.kind))
    return fail("validation", "unknown_artifact_kind");
  const kind = input.kind ?? DEFAULT_ARTIFACT_KIND;
  const invalid = validateRevision(revision);
  if (invalid) return invalid;
  const artifactId = input.artifactId ?? randomUUID();
  return inTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(artifacts)
      .values({ id: artifactId, ownerId, title, kind })
      .onConflictDoNothing({ target: artifacts.id })
      .returning({ id: artifacts.id });
    if (inserted.length === 0) {
      const existing = await tx
        .select({ ownerId: artifacts.ownerId, currentRevisionId: artifacts.currentRevisionId })
        .from(artifacts)
        .where(eq(artifacts.id, artifactId))
        .limit(1);
      const row = existing[0];
      if (!row || row.ownerId !== ownerId) return fail("not_found", "artifact_not_visible_to_owner");
      return fail("conflict", "artifact_already_exists", row.currentRevisionId);
    }
    const revisionId = randomUUID();
    await insertRevision(tx, artifactId, revisionId, revision);
    await tx
      .update(artifacts)
      .set({ currentRevisionId: revisionId, observedSizeBytes: revision.observedSizeBytes, updatedAt: sql`now()` })
      .where(eq(artifacts.id, artifactId));
    return ok({
      artifactId,
      revisionId,
      revisionNumber: revision.revision,
      observedSizeBytes: revision.observedSizeBytes,
    });
  });
}

export async function setRevisionCas(
  db: AppDb,
  input: {
    artifactId: string;
    ownerId: string;
    expectedRevisionId: string | null;
    next: RevisionInput;
    title?: string | null;
  },
): Promise<CommitResult<Committed>> {
  const { artifactId, ownerId, expectedRevisionId, next, title } = input;
  if (!isId(artifactId) || !isId(ownerId)) return fail("validation", "artifact_and_owner_id_required");
  if (expectedRevisionId !== null && !isId(expectedRevisionId))
    return fail("validation", "expected_revision_id_invalid");
  const invalid = validateRevision(next);
  if (invalid) return invalid;
  return inTransaction(db, async (tx) => {
    const owned = await tx
      .select({ currentRevisionId: artifacts.currentRevisionId, deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId)))
      .for("update");
    const artifact = owned[0];
    if (!artifact) return fail("not_found", "artifact_not_visible_to_owner");
    if (artifact.deletedAt) return fail("gone", "artifact_deleted");
    const revisionId = randomUUID();
    await insertRevision(tx, artifactId, revisionId, next);
    const cas = await tx
      .update(artifacts)
      .set({
        currentRevisionId: revisionId,
        observedSizeBytes: next.observedSizeBytes,
        updatedAt: sql`now()`,
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      })
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.ownerId, ownerId),
          sql`${artifacts.deletedAt} is null`,
          sql`${artifacts.currentRevisionId} is not distinct from ${expectedRevisionId}::text`,
        ),
      )
      .returning({ id: artifacts.id });
    if (cas.length === 0) return fail("concurrent_commit", "current_revision_changed", artifact.currentRevisionId);
    return ok({ revisionId, revisionNumber: next.revision, observedSizeBytes: next.observedSizeBytes });
  });
}

export async function renameArtifact(
  db: AppDb,
  input: {
    artifactId: string;
    ownerId: string;
    title: string;
    expectedRevisionId?: string | null;
  },
): Promise<
  CommitResult<{
    artifactId: string;
    title: string;
    currentRevisionId: string | null;
    revisionCount: number;
  }>
> {
  const { artifactId, ownerId, title, expectedRevisionId } = input;
  if (!isId(artifactId) || !isId(ownerId)) return fail("validation", "artifact_and_owner_id_required");
  if (title.trim().length === 0) return fail("validation", "title_required");
  if (title.length > 200) return fail("validation", "title_too_long");
  if (expectedRevisionId != null && !isId(expectedRevisionId))
    return fail("validation", "expected_revision_id_invalid");
  return inTransaction(db, async (tx) => {
    const owned = await tx
      .select({ currentRevisionId: artifacts.currentRevisionId, deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId)))
      .for("update");
    const artifact = owned[0];
    if (!artifact) return fail("not_found", "artifact_not_visible_to_owner");
    if (artifact.deletedAt) return fail("gone", "artifact_deleted");
    if (expectedRevisionId != null && artifact.currentRevisionId !== expectedRevisionId)
      return fail("concurrent_commit", "current_revision_changed", artifact.currentRevisionId);
    const updated = await tx
      .update(artifacts)
      .set({ title, updatedAt: sql`now()` })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId), sql`${artifacts.deletedAt} is null`))
      .returning({ title: artifacts.title });
    const row = updated[0];
    if (!row) return fail("not_found", "artifact_not_visible_to_owner");
    const counts = await tx
      .select({ revisionCount: sql<number>`count(${artifactRevisions.id})::int` })
      .from(artifactRevisions)
      .where(eq(artifactRevisions.artifactId, artifactId));
    return ok({
      artifactId,
      title: row.title as string,
      currentRevisionId: artifact.currentRevisionId,
      revisionCount: counts[0]?.revisionCount ?? 0,
    });
  });
}

export async function markArtifactDeleted(
  db: AppDb,
  artifactId: string,
  ownerId: string,
): Promise<CommitResult<{ deletedAt: Date }>> {
  if (!isId(artifactId) || !isId(ownerId)) return fail("validation", "artifact_and_owner_id_required");
  const rows = await db
    .update(artifacts)
    .set({ deletedAt: sql`coalesce(${artifacts.deletedAt}, now())`, updatedAt: sql`now()` })
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId)))
    .returning({ deletedAt: artifacts.deletedAt });
  const row = rows[0];
  return row?.deletedAt ? ok({ deletedAt: row.deletedAt }) : fail("not_found", "artifact_not_visible_to_owner");
}
