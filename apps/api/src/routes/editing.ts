import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";

import { getRevisionBytes, putRevisionBytes, newRevisionStorageKey } from "../adapters/storage/s3.ts";
import { copyRevisionBytes } from "../domain/commit-flow.ts";
import { setRevisionCas, type RevisionInput } from "../domain/commits.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { isJsonContentType, isUuid } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";
import type { DocumentResponse, RevisionListResponse, SavedRevision } from "@artiflow/contracts/document";
import type { createAuth } from "../auth.ts";
import {
  artifacts,
  artifactRevisions,
  artifactShares,
  MAX_ARTIFACT_BYTES,
} from "../adapters/postgres/db/artifact-schema.ts";
import type { Storage } from "../adapters/storage/client.ts";

type EditingAuth = ReturnType<typeof createAuth>;
export type EditingOptions = {
  database: Database;
  auth: EditingAuth;
  storage: Storage;
  publicOrigin: string;
  principal?: true;
  maxArtifactBytes?: number;
};

const HISTORY_LIMIT = 200;
const maxBytes = (cap?: number): number => Math.min(cap ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);

type DocRow = {
  id: string;
  ownerId: string;
  kind: string;
  title: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
  storageKey: string | null;
  sha256: string | null;
  access: string;
};

async function documentFor(db: AppDb, userId: string, artifactId: string): Promise<DocRow | undefined> {
  return (
    await db
      .select({
        id: artifacts.id,
        ownerId: artifacts.ownerId,
        kind: artifacts.kind,
        title: artifacts.title,
        revisionId: artifactRevisions.id,
        revisionNumber: artifactRevisions.revision,
        storageKey: artifactRevisions.storageKey,
        sha256: artifactRevisions.sha256,
        access: sql<string>`case when ${artifacts.ownerId} = ${userId} then 'owner' else coalesce(${artifactShares.role}, 'none') end`,
      })
      .from(artifacts)
      .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
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

async function revisionCount(db: AppDb, artifactId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, artifactId));
  return rows[0]?.count ?? 0;
}

async function revisionHistory(db: AppDb, artifactId: string) {
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
    .limit(HISTORY_LIMIT);
}

async function pinnedRevision(db: AppDb, revisionId: string, artifactId: string) {
  return (
    await db
      .select({ storageKey: artifactRevisions.storageKey, sha256: artifactRevisions.sha256 })
      .from(artifactRevisions)
      .where(and(eq(artifactRevisions.id, revisionId), eq(artifactRevisions.artifactId, artifactId)))
  )[0];
}

const canEdit = (row: DocRow): boolean => row.access === "owner" || row.access === "editor";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function createEditingApp(options: EditingOptions) {
  const { database, auth, storage, publicOrigin } = options;
  const db = database.db;
  const cap = maxBytes(options.maxArtifactBytes);
  const app = new Hono();

  const sessionUserId = async (c: Context): Promise<string | null> => {
    const bearerUserId = options.principal ? readPrincipal(c.req.raw.headers)?.userId : undefined;
    if (bearerUserId) return bearerUserId;
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const id = session?.user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  const guard = (c: Context): Response | null => {
    if (options.principal) return null;
    if (c.req.header("origin") !== publicOrigin) return c.json({ error: "origin_not_allowed" }, 403);
    if (!isJsonContentType(c.req.header("content-type"))) return c.json({ error: "json_content_type_required" }, 415);
    return null;
  };
  const docGate = async (c: Context): Promise<{ userId: string; row: DocRow } | Response> => {
    const artifactId = c.req.param("id") ?? "";
    if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
    const userId = await sessionUserId(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const row = await documentFor(db, userId, artifactId);
    if (!row) return c.json({ error: "not_found" }, 404);
    return { userId, row };
  };
  const requireMarkdown = (c: Context, row: DocRow): Response | null =>
    row.kind === "markdown" ? null : c.json({ error: "wrong_kind" }, 409);
  const requireCurrent = (c: Context, row: DocRow): Response | null =>
    row.revisionId && row.storageKey && row.sha256 ? null : c.json({ error: "no_current_revision" }, 409);
  const requireEditor = (c: Context, row: DocRow): Response | null =>
    canEdit(row) ? null : c.json({ error: "forbidden" }, 403);

  app.get("/api/artifacts/:id/document", async (c) => {
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const { row } = gate;
    const wrongKind = requireMarkdown(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const read = await getRevisionBytes({
      storage,
      storageKey: row.storageKey as string,
      sha256: row.sha256 as string,
      maxBytes: cap,
    });
    if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
    const decoded = decodeMarkdownText(read.value.bytes);
    if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
    return c.json({
      artifactId: row.id,
      title: row.title,
      kind: "markdown",
      revisionId: row.revisionId as string,
      revisionNumber: row.revisionNumber as number,
      text: decoded.text,
    } satisfies DocumentResponse);
  });

  app.put("/api/artifacts/:id/document", async (c) => {
    const rejected = guard(c);
    if (rejected) return rejected;
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const { row } = gate;
    const wrongKind = requireMarkdown(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const notEditor = requireEditor(c, row);
    if (notEditor) return notEditor;
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; expectedRevisionId?: unknown } | null;
    if (typeof body?.text !== "string" || body.text.length === 0) return c.json({ error: "text_required" }, 400);
    if (typeof body.expectedRevisionId !== "string" || body.expectedRevisionId.length === 0)
      return c.json({ error: "expected_revision_id_required" }, 400);
    if (body.expectedRevisionId !== row.revisionId) {
      return c.json({ error: "concurrent_edit", currentRevisionId: row.revisionId }, 409);
    }
    const bytes = Buffer.from(body.text, "utf8");
    if (bytes.length > cap) return c.json({ error: "too_large", maxBytes: cap }, 413);
    const sha256 = sha256Of(bytes);
    const stored = await putRevisionBytes({ storage, storageKey: newRevisionStorageKey(), sha256, bytes });
    if (!stored.ok) return c.json({ error: "artifact_unavailable" }, 500);
    const count = await revisionCount(db, row.id);
    const next: RevisionInput = {
      revision: count + 1,
      sizeBytes: bytes.length,
      sha256,
      storageKey: stored.value.storageKey,
      observedSizeBytes: bytes.length,
    };
    const advanced = await setRevisionCas(database.db, {
      artifactId: row.id,
      ownerId: row.ownerId,
      expectedRevisionId: row.revisionId,
      next,
    });
    if (!advanced.ok) {
      if (advanced.kind === "error") return c.json({ error: "internal_error", reason: advanced.reason }, 500);
      return c.json(
        {
          error: advanced.kind === "concurrent_commit" ? "concurrent_edit" : advanced.kind,
          reason: advanced.reason,
          currentRevisionId: advanced.currentRevisionId,
        },
        409,
      );
    }
    return c.json({
      artifactId: row.id,
      revisionId: advanced.value.revisionId,
      revisionNumber: advanced.value.revisionNumber,
      sizeBytes: bytes.length,
      sha256,
    } satisfies SavedRevision);
  });

  app.get("/api/artifacts/:id/revisions", async (c) => {
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const history = await revisionHistory(db, gate.row.id);
    return c.json({
      revisions: history.map((row) => ({
        id: row.id,
        revisionNumber: row.revisionNumber,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt.toISOString(),
      })),
    } satisfies RevisionListResponse);
  });

  app.post("/api/artifacts/:id/revisions/:revisionId/restore", async (c) => {
    const rejected = guard(c);
    if (rejected) return rejected;
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const { row } = gate;
    const wrongKind = requireMarkdown(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const notEditor = requireEditor(c, row);
    if (notEditor) return notEditor;
    const revisionId = c.req.param("revisionId");
    if (!isUuid(revisionId)) return c.json({ error: "revision_not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { expectedRevisionId?: unknown } | null;
    if (typeof body?.expectedRevisionId !== "string" || body.expectedRevisionId.length === 0)
      return c.json({ error: "expected_revision_id_required" }, 400);
    if (body.expectedRevisionId !== row.revisionId) {
      return c.json({ error: "concurrent_edit", currentRevisionId: row.revisionId }, 409);
    }
    const pinned = await pinnedRevision(db, revisionId, row.id);
    if (!pinned?.sha256) return c.json({ error: "revision_not_found" }, 404);
    const copied = await copyRevisionBytes({
      storage,
      storageKey: pinned.storageKey,
      sha256: pinned.sha256,
      maxBytes: cap,
    });
    if (!copied.ok) return c.json({ error: "artifact_unavailable" }, 500);
    const count = await revisionCount(db, row.id);
    const next: RevisionInput = {
      revision: count + 1,
      sizeBytes: copied.value.sizeBytes,
      sha256: copied.value.sha256,
      storageKey: copied.value.storageKey,
      observedSizeBytes: copied.value.sizeBytes,
    };
    const advanced = await setRevisionCas(database.db, {
      artifactId: row.id,
      ownerId: row.ownerId,
      expectedRevisionId: row.revisionId,
      next,
    });
    if (!advanced.ok) {
      if (advanced.kind === "error") return c.json({ error: "internal_error", reason: advanced.reason }, 500);
      return c.json(
        {
          error: advanced.kind === "concurrent_commit" ? "concurrent_edit" : advanced.kind,
          reason: advanced.reason,
          currentRevisionId: advanced.currentRevisionId,
        },
        409,
      );
    }
    return c.json({
      artifactId: row.id,
      revisionId: advanced.value.revisionId,
      revisionNumber: advanced.value.revisionNumber,
      restoredFrom: revisionId,
      sha256: next.sha256,
    } satisfies SavedRevision);
  });

  return app;
}
