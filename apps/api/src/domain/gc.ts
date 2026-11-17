import { and, eq, gte, inArray, lt, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";
import { artifactChunks, artifactRevisions, artifactUploads } from "../adapters/postgres/db/artifact-schema.ts";

import type { Storage } from "../adapters/storage/client.ts";
import {
  deleteRevisionBytes,
  deleteStagingChunk,
  listRevisionKeys,
  type DeletedRevision,
  type DeleteRevisionInput,
  type DeleteStagingChunkInput,
  type ListedRevisionKeys,
  type ListRevisionKeysInput,
  type StorageResult,
} from "../adapters/storage/s3.ts";

export type StagingSweepResult = {
  expiredUploads: number;
  candidates: number;
  deleted: number;
  failed: number;
};

export type DeleteStagingChunkFn = (input: DeleteStagingChunkInput) => Promise<StorageResult<DeletedRevision>>;

export type SweepStagingInput = {
  db: AppDb;
  storage: Storage;
  now: Date;
  deleteStagingChunkFn?: DeleteStagingChunkFn;
};

export async function sweepStagingGarbage(input: SweepStagingInput): Promise<StagingSweepResult> {
  const { db, storage, now } = input;
  const deleteChunk = input.deleteStagingChunkFn ?? deleteStagingChunk;

  const expired = and(lt(artifactUploads.expiresAt, now), ne(artifactUploads.status, "complete"));
  const expiredUploads = await db.select({ id: artifactUploads.id }).from(artifactUploads).where(expired);
  const expiredDigests = await db
    .selectDistinct({ sha256: artifactChunks.sha256 })
    .from(artifactChunks)
    .innerJoin(artifactUploads, eq(artifactUploads.id, artifactChunks.uploadId))
    .where(expired);
  const openChunks = alias(artifactChunks, "openChunks");
  const terminalDigests = await db
    .selectDistinct({ sha256: artifactChunks.sha256 })
    .from(artifactChunks)
    .where(
      notExists(
        db
          .select({ id: openChunks.id })
          .from(openChunks)
          .innerJoin(artifactUploads, eq(artifactUploads.id, openChunks.uploadId))
          .where(
            and(
              eq(openChunks.sha256, artifactChunks.sha256),
              eq(artifactUploads.status, "open"),
              gte(artifactUploads.expiresAt, now),
            ),
          ),
      ),
    );

  const candidates = [
    ...new Set([...expiredDigests.map((row) => row.sha256), ...terminalDigests.map((row) => row.sha256)]),
  ].sort();
  let deleted = 0;
  let failed = 0;
  const collected = new Set<string>();
  for (const sha256 of candidates) {
    const result = await deleteChunk({ storage, sha256 });
    if (result.ok) {
      deleted += 1;
      collected.add(sha256);
    } else {
      failed += 1;
    }
  }

  let removedUploads = 0;
  for (const row of expiredUploads) {
    const claimed = await db
      .select({ sha256: artifactChunks.sha256 })
      .from(artifactChunks)
      .where(eq(artifactChunks.uploadId, row.id));
    const unresolved = claimed.some((chunk) => !collected.has(chunk.sha256));
    if (unresolved) continue;
    const removed = await db
      .delete(artifactUploads)
      .where(and(eq(artifactUploads.id, row.id), expired))
      .returning({ id: artifactUploads.id });
    removedUploads += removed.length;
  }
  if (collected.size > 0) {
    await db
      .delete(artifactChunks)
      .where(
        and(
          inArray(
            artifactChunks.uploadId,
            db.select({ id: artifactUploads.id }).from(artifactUploads).where(ne(artifactUploads.status, "open")),
          ),
          inArray(artifactChunks.sha256, [...collected]),
        ),
      );
  }
  return { expiredUploads: removedUploads, candidates: candidates.length, deleted, failed };
}

export const REVISION_GC_GRACE_MS = 24 * 60 * 60_000;
export const REVISION_GC_PAGE_SIZE = 200;
export const REVISION_GC_MAX_KEYS_PER_RUN = 2_000;

export type RevisionSweepResult = {
  examined: number;
  candidates: number;
  deleted: number;
  failed: number;
  listFailed: boolean;
};

export type ExistingRevisionKeysFn = (db: AppDb, storageKeys: readonly string[]) => Promise<string[]>;
export type ListRevisionKeysFn = (input: ListRevisionKeysInput) => Promise<StorageResult<ListedRevisionKeys>>;
export type DeleteRevisionBytesFn = (input: DeleteRevisionInput) => Promise<StorageResult<DeletedRevision>>;

export async function findExistingRevisionKeys(db: AppDb, storageKeys: readonly string[]): Promise<string[]> {
  if (storageKeys.length === 0) return [];
  const rows = await db
    .select({ storageKey: artifactRevisions.storageKey })
    .from(artifactRevisions)
    .where(inArray(artifactRevisions.storageKey, [...storageKeys]));
  return rows.map((row) => row.storageKey);
}

export type SweepRevisionsInput = {
  db: AppDb;
  storage: Storage;
  now: Date;
  graceMs?: number;
  maxKeysPerRun?: number;
  pageSize?: number;
  existingRevisionKeysFn?: ExistingRevisionKeysFn;
  listRevisionKeysFn?: ListRevisionKeysFn;
  deleteRevisionBytesFn?: DeleteRevisionBytesFn;
};

export async function sweepRevisionOrphans(input: SweepRevisionsInput): Promise<RevisionSweepResult> {
  const { db, storage, now } = input;
  const list = input.listRevisionKeysFn ?? listRevisionKeys;
  const lookup = input.existingRevisionKeysFn ?? findExistingRevisionKeys;
  const remove = input.deleteRevisionBytesFn ?? deleteRevisionBytes;
  const graceMs = input.graceMs ?? REVISION_GC_GRACE_MS;
  const maxKeys = input.maxKeysPerRun ?? REVISION_GC_MAX_KEYS_PER_RUN;
  const pageSize = Math.max(1, Math.min(input.pageSize ?? REVISION_GC_PAGE_SIZE, maxKeys));
  const cutoffMs = now.getTime() - graceMs;
  let examined = 0;
  let candidates = 0;
  let deleted = 0;
  let failed = 0;
  let listFailed = false;
  let continuationToken: string | undefined;
  while (examined < maxKeys) {
    const page = await list({
      storage,
      continuationToken,
      maxKeys: Math.min(pageSize, maxKeys - examined),
    });
    if (!page.ok) {
      listFailed = true;
      break;
    }
    const objects = page.value.objects.slice(0, maxKeys - examined);
    examined += objects.length;
    const aged = objects.filter((object) => object.lastModified.getTime() < cutoffMs);
    const agedKeys = aged.map((object) => object.storageKey);
    const named = new Set(agedKeys.length === 0 ? [] : await lookup(db, agedKeys));
    for (const object of aged) {
      if (named.has(object.storageKey)) continue;
      candidates += 1;
      const result = await remove({ storage, storageKey: object.storageKey });
      if (result.ok) deleted += 1;
      else failed += 1;
    }
    continuationToken = page.value.nextToken;
    if (continuationToken === undefined || objects.length === 0) break;
  }
  return { examined, candidates, deleted, failed, listFailed };
}

export const STAGING_GC_STARTUP_DELAY_MS = 15_000;
export const STAGING_GC_INTERVAL_MS = 15 * 60_000;
export const REVISION_GC_STARTUP_DELAY_MS = 60_000;
export const REVISION_GC_INTERVAL_MS = 24 * 60 * 60_000;

type SweepLoop = { stop: () => void };
export type StagingGcLoop = SweepLoop;
export type RevisionGcLoop = SweepLoop;

type SweepLoopInput<R> = {
  sweepFn: () => Promise<R>;
  log: (line: string) => void;
  tag: string;
  describe: (result: R) => string;
  intervalMs: number;
  startupDelayMs: number;
};

function startSweepLoop<R>(input: SweepLoopInput<R>): SweepLoop {
  const { sweepFn, log, tag, describe, intervalMs, startupDelayMs } = input;
  let running = false;
  let stopped = false;
  const runSweep = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await sweepFn();
      log(`[${tag}] ${describe(result)}`);
    } catch (error) {
      log(`[${tag}] sweep failed: ${error instanceof Error ? error.name : "unknown error"}`);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => {
    void runSweep();
  }, intervalMs);
  interval.unref?.();
  const startup = setTimeout(() => {
    void runSweep();
  }, startupDelayMs);
  startup.unref?.();
  return {
    stop: (): void => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(startup);
    },
  };
}

export type StartStagingGcLoopInput = {
  database: Database;
  storage: Storage;
  sweepFn?: () => Promise<StagingSweepResult>;
  log?: (line: string) => void;
  intervalMs?: number;
  startupDelayMs?: number;
};

export function startStagingGcLoop(input: StartStagingGcLoopInput): StagingGcLoop {
  return startSweepLoop<StagingSweepResult>({
    sweepFn:
      input.sweepFn ??
      ((): Promise<StagingSweepResult> =>
        sweepStagingGarbage({ db: input.database.db, storage: input.storage, now: new Date() })),
    log: input.log ?? ((line: string): void => console.log(line)),
    tag: "staging-gc",
    describe: (result) =>
      `expiredUploads=${result.expiredUploads} candidates=${result.candidates} deleted=${result.deleted} failed=${result.failed}`,
    intervalMs: input.intervalMs ?? STAGING_GC_INTERVAL_MS,
    startupDelayMs: input.startupDelayMs ?? STAGING_GC_STARTUP_DELAY_MS,
  });
}

export type StartRevisionGcLoopInput = {
  database: Database;
  storage: Storage;
  sweepFn?: () => Promise<RevisionSweepResult>;
  log?: (line: string) => void;
  intervalMs?: number;
  startupDelayMs?: number;
};

export function startRevisionGcLoop(input: StartRevisionGcLoopInput): RevisionGcLoop {
  return startSweepLoop<RevisionSweepResult>({
    sweepFn:
      input.sweepFn ??
      ((): Promise<RevisionSweepResult> =>
        sweepRevisionOrphans({ db: input.database.db, storage: input.storage, now: new Date() })),
    log: input.log ?? ((line: string): void => console.log(line)),
    tag: "revision-gc",
    describe: (result) =>
      `examined=${result.examined} candidates=${result.candidates} deleted=${result.deleted} failed=${result.failed} listFailed=${result.listFailed}`,
    intervalMs: input.intervalMs ?? REVISION_GC_INTERVAL_MS,
    startupDelayMs: input.startupDelayMs ?? REVISION_GC_STARTUP_DELAY_MS,
  });
}
