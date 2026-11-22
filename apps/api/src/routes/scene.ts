import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";

import { diffSceneOperations } from "@artiflow/domain/scene-operations";
import { rendersScene } from "@artiflow/domain/kinds";
import { validateScene } from "@artiflow/domain/scene";
import type { SceneDraftResponse, SavedScene } from "@artiflow/contracts/scene";
import {
  docGateFor,
  editingSession,
  maxBytes,
  requireCurrent,
  requireEditor,
  type DocGate,
  type DocRow,
  type EditingOptions,
} from "./editing.ts";
import {
  applyOperationsAndFreeze,
  drizzleDocumentStore,
  openDraft,
  type DocumentErrorKind,
} from "../domain/documents/service.ts";

const requireScene = (c: Context, row: DocRow): Response | null =>
  rendersScene(row.kind) ? null : c.json({ error: "wrong_kind" }, 409);

const unavailable = (c: Context, kind: DocumentErrorKind): Response =>
  kind === "not_found" ? c.json({ error: "not_found" }, 404) : c.json({ error: "artifact_unavailable" }, 500);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createSceneApp(options: EditingOptions) {
  const { database, storage } = options;
  const db = database.db;
  const cap = maxBytes(options.maxArtifactBytes);
  const store = options.documentStore ?? drizzleDocumentStore(database);
  const app = new Hono();
  const { sessionUserId, guard } = editingSession(options);
  const docGate = (c: Context): Promise<DocGate | Response> => docGateFor(c, db, sessionUserId);

  app.get("/api/artifacts/:id/scene", async (c) => {
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const row = gate.row;
    const wrongKind = requireScene(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const notEditor = requireEditor(c, row);
    if (notEditor) return notEditor;
    const opened = await openDraft({ store, storage, artifactId: row.id });
    if (!opened.ok) return unavailable(c, opened.kind);
    if (opened.value.scene === null) return c.json({ error: "artifact_unavailable" }, 500);
    return c.json({
      kind: "canvas",
      artifactId: row.id,
      seq: opened.value.seq,
      publishedSeq: row.publishedSeq,
      revisionId: row.revisionId as string,
      scene: opened.value.scene,
    } satisfies SceneDraftResponse);
  });

  app.put("/api/artifacts/:id/scene", async (c) => {
    const rejected = guard(c);
    if (rejected) return rejected;
    const gate = await docGate(c);
    if (gate instanceof Response) return gate;
    const row = gate.row;
    const wrongKind = requireScene(c, row);
    if (wrongKind) return wrongKind;
    const noCurrent = requireCurrent(c, row);
    if (noCurrent) return noCurrent;
    const notEditor = requireEditor(c, row);
    if (notEditor) return notEditor;
    const body = (await c.req.json().catch(() => null)) as { scene?: unknown; expectedSeq?: unknown } | null;
    const wanted = body?.scene;
    if (!isRecord(wanted)) return c.json({ error: "scene_required" }, 400);
    const expectedSeq = body?.expectedSeq;
    if (expectedSeq !== undefined && (!Number.isSafeInteger(expectedSeq) || (expectedSeq as number) < 0))
      return c.json({ error: "expected_seq_invalid" }, 400);
    if (Buffer.byteLength(JSON.stringify(wanted), "utf8") > cap)
      return c.json({ error: "too_large", maxBytes: cap }, 413);
    const opened = await openDraft({ store, storage, artifactId: row.id });
    if (!opened.ok) return unavailable(c, opened.kind);
    const current = opened.value;
    if (current.scene === null) return c.json({ error: "artifact_unavailable" }, 500);
    if (expectedSeq === undefined)
      return c.json({ error: "sequence_required", currentSeq: current.seq, currentRevisionId: row.revisionId }, 409);
    if (expectedSeq !== current.seq)
      return c.json({ error: "concurrent_edit", currentSeq: current.seq, currentRevisionId: row.revisionId }, 409);
    const checked = validateScene(wanted);
    if (!checked.ok)
      return c.json(
        { error: "operation_rejected", kind: "validation", reason: checked.reason, path: checked.path },
        409,
      );
    const operations = diffSceneOperations(current.scene, checked.value);
    const unchanged = (): Response =>
      c.json({
        artifactId: row.id,
        seq: current.seq,
        publishedSeq: row.publishedSeq,
        frozen: false,
        applied: 0,
        revisionId: row.revisionId as string,
      } satisfies SavedScene);
    if (operations.length === 0) return unchanged();
    const applied = await applyOperationsAndFreeze({
      store,
      storage,
      artifactId: row.id,
      authorKind: "person",
      authorId: gate.userId,
      baseSeq: current.seq,
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
    return c.json({
      artifactId: row.id,
      seq: applied.value.seq,
      publishedSeq: applied.value.publishedSeq,
      frozen: applied.value.published,
      applied: applied.value.applied,
      revisionId:
        applied.value.published && applied.value.revisionId !== null
          ? applied.value.revisionId
          : (row.revisionId as string),
    } satisfies SavedScene);
  });

  return app;
}
