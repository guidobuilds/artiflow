import { createHash, randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";

import { getRevisionBytes, putRevisionBytes, newRevisionStorageKey } from "../adapters/storage/s3.ts";
import { setRevisionCas, type RevisionInput } from "../domain/commits.ts";
import { revisionHistory, revisionRow } from "../domain/revisions.ts";
import { editsDocumentInApp, rendersScene } from "@artiflow/domain/kinds";
import { readScene, type Scene } from "@artiflow/domain/scene";
import { diffDocumentOperations } from "@artiflow/domain/document-operations";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { isJsonContentType, isUuid } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";
import {
  applyOperations,
  drizzleDocumentStore,
  freezeIfDue,
  openDraft,
  restoreDocument,
  textAt,
  type DocumentStore,
} from "../domain/documents/service.ts";
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
  documentStore?: DocumentStore;
};

export const maxBytes = (cap?: number): number => Math.min(cap ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);

export type DocRow = {
  id: string;
  ownerId: string;
  kind: string;
  title: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
  storageKey: string | null;
  sha256: string | null;
  publishedSeq: number;
  access: string;
};

export async function documentFor(db: AppDb, userId: string, artifactId: string): Promise<DocRow | undefined> {
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
        publishedSeq: artifacts.publishedSeq,
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



export type DocGate = { userId: string; row: DocRow };

export type EditingSession = {
  sessionUserId: (c: Context) => Promise<string | null>;
  guard: (c: Context) => Response | null;
};

export function editingSession(options: Pick<EditingOptions, "auth" | "publicOrigin" | "principal">): EditingSession {
  const { auth, publicOrigin } = options;
  return {
    sessionUserId: async (c: Context): Promise<string | null> => {
      const bearerUserId = options.principal ? readPrincipal(c.req.raw.headers)?.userId : undefined;
      if (bearerUserId) return bearerUserId;
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const id = session?.user?.id;
      return typeof id === "string" && id.length > 0 ? id : null;
    },
    guard: (c: Context): Response | null => {
      if (options.principal) return null;
      if (c.req.header("origin") !== publicOrigin) return c.json({ error: "origin_not_allowed" }, 403);
      if (!isJsonContentType(c.req.header("content-type"))) return c.json({ error: "json_content_type_required" }, 415);
      return null;
    },
  };
}

export async function docGateFor(
  c: Context,
  db: AppDb,
  sessionUserId: EditingSession["sessionUserId"],
): Promise<DocGate | Response> {
  const artifactId = c.req.param("id") ?? "";
  if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
  const userId = await sessionUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const row = await documentFor(db, userId, artifactId);
  if (!row) return c.json({ error: "not_found" }, 404);
  return { userId, row };
}

export const canEdit = (row: { access: string }): boolean => row.access === "owner" || row.access === "editor";

export const requireEditor = (c: Context, row: DocRow): Response | null =>
  canEdit(row) ? null : c.json({ error: "forbidden" }, 403);

export const requireCurrent = (c: Context, row: DocRow): Response | null =>
  row.revisionId && row.storageKey && row.sha256 ? null : c.json({ error: "no_current_revision" }, 409);

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function createEditingApp(options: EditingOptions) {
  const { database, storage } = options;
  const db = database.db;
  const cap = maxBytes(options.maxArtifactBytes);
  const documents = options.documentStore ?? drizzleDocumentStore(database);
  const app = new Hono();

  const { sessionUserId, guard } = editingSession(options);
  const docGate = (c: Context): Promise<DocGate | Response> => docGateFor(c, db, sessionUserId);
  const requireMarkdown = (c: Context, row: DocRow): Response | null =>
    editsDocumentInApp(row.kind) ? null : c.json({ error: "wrong_kind" }, 409);
  const requireRestorable = (c: Context, row: DocRow): Response | null =>
    editsDocumentInApp(row.kind) || rendersScene(row.kind) ? null : c.json({ error: "wrong_kind" }, 409);
  const revisionContent = (kind: string, bytes: Uint8Array): { text: string } | { scene: Scene } | null => {
    if (rendersScene(kind)) {
      const parsed = readScene(new TextDecoder().decode(bytes));
      return parsed.ok ? { scene: parsed.value } : null;
    }
    const decoded = decodeMarkdownText(bytes);
    return decoded.ok ? { text: decoded.text } : null;
  };

  app.get("/api/artifacts/:id/document", async (c) => {
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const { row } = gate;
    const wrongKind = requireMarkdown(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const draft = await documents.readDraft(row.id);
    if (draft) {
      const resolved = await textAt({ store: documents, storage, artifactId: row.id, seq: draft.seq });
      if (!resolved.ok) return c.json({ error: "artifact_unavailable" }, 500);
      return c.json({
        artifactId: row.id,
        title: row.title,
        kind: row.kind as DocumentResponse["kind"],
        revisionId: row.revisionId as string,
        revisionNumber: row.revisionNumber as number,
        text: resolved.value.text,
        seq: draft.seq,
        publishedSeq: row.publishedSeq,
      } satisfies DocumentResponse);
    }
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
      kind: row.kind as DocumentResponse["kind"],
      revisionId: row.revisionId as string,
      revisionNumber: row.revisionNumber as number,
      text: decoded.text,
      seq: row.publishedSeq,
      publishedSeq: row.publishedSeq,
    } satisfies DocumentResponse);
  });

  app.put("/api/artifacts/:id/document", async (c) => {
    const rejected = guard(c);
    if (rejected) return rejected;
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const { userId, row } = gate;
    const wrongKind = requireMarkdown(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const notEditor = requireEditor(c, row);
    if (notEditor) return notEditor;
    const body = (await c.req.json().catch(() => null)) as {
      text?: unknown;
      expectedRevisionId?: unknown;
      expectedSeq?: unknown;
    } | null;
    if (typeof body?.text !== "string" || body.text.length === 0) return c.json({ error: "text_required" }, 400);
    const expectedSeq = body.expectedSeq;
    if (expectedSeq !== undefined && (!Number.isSafeInteger(expectedSeq) || (expectedSeq as number) < 0))
      return c.json({ error: "expected_seq_invalid" }, 400);
    const expectedRevisionId = body.expectedRevisionId;
    if (expectedRevisionId !== undefined && (typeof expectedRevisionId !== "string" || expectedRevisionId.length === 0))
      return c.json({ error: "expected_revision_id_required" }, 400);
    if (expectedSeq !== undefined && expectedRevisionId !== undefined)
      return c.json({ error: "unexpected_revision_token" }, 400);
    const draft = await documents.readDraft(row.id);
    let baseSeqInput: number | undefined = expectedSeq as number | undefined;
    if (expectedSeq === undefined && draft !== null && draft.seq !== row.publishedSeq)
      return c.json({ error: "sequence_required", currentSeq: draft.seq, currentRevisionId: row.revisionId }, 409);
    if (expectedSeq === undefined && draft !== null) baseSeqInput = draft.seq;
    if (expectedSeq === undefined) {
      if (draft === null && expectedRevisionId === undefined)
        return c.json({ error: "expected_revision_id_required" }, 400);
      if (expectedRevisionId !== row.revisionId)
        return c.json(
          { error: "concurrent_edit", currentSeq: row.publishedSeq, currentRevisionId: row.revisionId },
          409,
        );
    }
    const bytes = Buffer.from(body.text, "utf8");
    if (bytes.length > cap) return c.json({ error: "too_large", maxBytes: cap }, 413);
    if (baseSeqInput === undefined) {
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
        if (advanced.kind === "concurrent_commit")
          return c.json(
            { error: "concurrent_edit", currentSeq: row.publishedSeq, currentRevisionId: advanced.currentRevisionId },
            409,
          );
        return c.json(
          { error: advanced.kind, reason: advanced.reason, currentRevisionId: advanced.currentRevisionId },
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
    }
    const opened = await openDraft({ store: documents, storage, artifactId: row.id });
    if (!opened.ok)
      return opened.kind === "not_found"
        ? c.json({ error: "not_found" }, 404)
        : c.json({ error: "artifact_unavailable" }, 500);
    const baseSeq = baseSeqInput as number;
    if (baseSeq !== opened.value.seq)
      return c.json({ error: "concurrent_edit", currentSeq: opened.value.seq, currentRevisionId: row.revisionId }, 409);
    const operations = diffDocumentOperations(opened.value.text, body.text);
    if (operations.length === 0)
      return c.json({
        artifactId: row.id,
        revisionId: row.revisionId as string,
        revisionNumber: row.revisionNumber as number,
        seq: opened.value.seq,
        publishedSeq: row.publishedSeq,
      } satisfies SavedRevision);
    const applied = await applyOperations({
      store: documents,
      storage,
      artifactId: row.id,
      authorKind: "person",
      authorId: userId,
      baseSeq,
      idempotencyKey: randomUUID(),
      ops: operations,
    });
    if (!applied.ok) {
      if (applied.kind === "concurrent_edit")
        return c.json(
          { error: "concurrent_edit", currentSeq: applied.currentSeq, currentRevisionId: row.revisionId },
          409,
        );
      if (applied.kind === "not_found") return c.json({ error: "not_found" }, 404);
      return c.json({ error: "operation_rejected", kind: applied.kind, reason: applied.reason }, 409);
    }
    const frozen = await freezeIfDue({ store: documents, storage, artifactId: row.id });
    if (
      frozen.ok &&
      frozen.value.frozen &&
      frozen.value.revisionId !== null &&
      frozen.value.revisionNumber !== null &&
      frozen.value.sizeBytes !== null &&
      frozen.value.sha256 !== null
    )
      return c.json({
        artifactId: row.id,
        revisionId: frozen.value.revisionId,
        revisionNumber: frozen.value.revisionNumber,
        sizeBytes: frozen.value.sizeBytes,
        sha256: frozen.value.sha256,
        seq: applied.value.seq,
        publishedSeq: frozen.value.publishedSeq,
      } satisfies SavedRevision);
    return c.json({
      artifactId: row.id,
      revisionId: row.revisionId as string,
      revisionNumber: row.revisionNumber as number,
      seq: applied.value.seq,
      publishedSeq: frozen.ok ? frozen.value.publishedSeq : row.publishedSeq,
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
    const { userId, row } = gate;
    const wrongKind = requireRestorable(c, row);
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
      const current = await documents.readDraft(row.id);
      return c.json(
        {
          error: "concurrent_edit",
          currentSeq: current?.seq ?? row.publishedSeq,
          currentRevisionId: row.revisionId,
        },
        409,
      );
    }
    const pinned = await revisionRow(db, row.id, revisionId);
    if (!pinned?.sha256) return c.json({ error: "revision_not_found" }, 404);
    const read = await getRevisionBytes({
      storage,
      storageKey: pinned.storageKey,
      sha256: pinned.sha256,
      maxBytes: cap,
    });
    if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
    const content = revisionContent(row.kind, read.value.bytes);
    if (content === null) return c.json({ error: "artifact_unavailable" }, 500);
    const rewound = await restoreDocument({
      store: documents,
      storage,
      artifactId: row.id,
      authorKind: "person",
      authorId: userId,
      idempotencyKey: randomUUID(),
      ...content,
    });
    if (!rewound.ok) {
      if (rewound.kind === "concurrent_edit")
        return c.json(
          {
            error: rewound.reason === "pending_changes" ? "restore_pending_changes" : "concurrent_edit",
            currentSeq: rewound.currentSeq,
            currentRevisionId: row.revisionId,
          },
          409,
        );
      if (rewound.kind === "not_found") return c.json({ error: "not_found" }, 404);
      if (rewound.kind === "operation_rejected")
        return c.json({ error: "operation_rejected", kind: rewound.kind, reason: rewound.reason }, 409);
      return c.json({ error: "artifact_unavailable" }, 500);
    }
    return c.json({
      artifactId: row.id,
      revisionId: rewound.value.revisionId,
      revisionNumber: rewound.value.revisionNumber,
      restoredFrom: revisionId,
      sha256: rewound.value.sha256,
      seq: rewound.value.seq,
      publishedSeq: rewound.value.publishedSeq,
    } satisfies SavedRevision);
  });

  return app;
}
