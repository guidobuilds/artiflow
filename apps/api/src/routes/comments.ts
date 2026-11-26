import { Hono, type Context } from "hono";
import type { AppDb, AppTx, Database } from "../adapters/postgres/db/client.ts";
import {
  commentDocument,
  currentRevision,
  deleteComment,
  findComment,
  insertComment,
  listComments,
  setCommentResolved,
  type CommentDocument,
} from "../adapters/postgres/comments-repo.ts";
import type { createAuth } from "../auth.ts";
import { MAX_ARTIFACT_BYTES, MAX_COMMENT_BODY, MAX_COMMENT_QUOTE } from "../adapters/postgres/db/artifact-schema.ts";
import { getRevisionBytes } from "../adapters/storage/s3.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { artifactPermissions } from "@artiflow/domain/comment-permissions";
import { cookieMutationGuard, isUuid, Rollback } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";
import {
  commentAnchorSchema,
  type CommentAnchorWire,
  type CommentListResponse,
  type CommentMutationResponse,
} from "@artiflow/contracts/comments";
import type { Storage } from "../adapters/storage/client.ts";
import {
  acceptsSceneAnchors,
  anchorKindAllowed,
  anchorText,
  isSceneAnchor,
  sceneAnchorIsOrphaned,
  sceneAnchorRefusal,
} from "@artiflow/domain/comment-anchors";
import type { Scene } from "@artiflow/domain/scene";
import { drizzleDocumentStore, openDraft, type DocumentStore } from "../domain/documents/service.ts";

type Options = {
  database: Database;
  auth: ReturnType<typeof createAuth>;
  storage: Storage;
  publicOrigin: string;
  principal?: true;
  documentStore?: DocumentStore;
};

type Doc = CommentDocument;
type Row = Awaited<ReturnType<typeof listComments>>[number];

const canComment = (doc: Doc) => artifactPermissions(doc.access).comment;

export function createCommentsApp({ database, auth, storage, publicOrigin, principal, documentStore }: Options) {
  const db = database.db;
  const documents = documentStore ?? drizzleDocumentStore(database);
  const app = new Hono();
  const currentScene = async (artifactId: string): Promise<Scene | null> => {
    const opened = await openDraft({ store: documents, storage, artifactId });
    return opened.ok ? opened.value.scene : null;
  };
  const guard = (c: Context): Response | null => {
    if (principal) return null;
    const rejected = cookieMutationGuard(c, publicOrigin);
    return rejected === null
      ? null
      : rejected === "origin_not_allowed"
        ? c.json({ error: rejected }, 403)
        : c.json({ error: rejected }, 415);
  };
  const gate = async (c: Context, query: AppDb | AppTx, lock = false) => {
    const id = c.req.param("id") ?? "";
    const commentId = c.req.param("commentId");
    if (!isUuid(id) || (commentId !== undefined && !isUuid(commentId))) return c.json({ error: "not_found" }, 404);
    const bearerUserId = principal ? readPrincipal(c.req.raw.headers)?.userId : undefined;
    const userId = bearerUserId ?? (await auth.api.getSession({ headers: c.req.raw.headers }))?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const doc = await commentDocument(query, userId, id, "shared", lock);
    if (!doc) return c.json({ error: "not_found" }, 404);
    return { doc, userId };
  };
  app.get("/api/artifacts/:id/comments", async (c) => {
    const result = await gate(c, db);
    if (result instanceof Response) return result;
    const { doc, userId } = result;
    const rows = await listComments(db, doc.id, true);
    const scene = acceptsSceneAnchors(doc.kind) ? await currentScene(doc.id) : null;
    const serialize = (row: Row) => ({
      id: row.id,
      authorId: row.authorId,
      author: { id: row.authorId, name: row.authorName ?? "", image: row.authorImage ?? null },
      anchor: (row.anchor ?? null) as CommentAnchorWire | null,
      body: row.body,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      canDelete: doc.ownerId === userId || row.authorId === userId,
    });
    return c.json({
      canComment: canComment(doc),
      comments: rows
        .filter((row) => row.parentId === null)
        .map((row) => ({
          ...serialize(row),
          ...(scene === null ? {} : { orphaned: sceneAnchorIsOrphaned(scene, row.anchor) }),
          replies: rows.filter((reply) => reply.parentId === row.id).map(serialize),
        })),
    } satisfies CommentListResponse);
  });
  type Gate = { doc: Doc; userId: string };
  const mutate = async (c: Context, action: (client: AppTx, result: Gate) => Promise<Response>) => {
    const rejected = guard(c);
    if (rejected) return rejected;
    try {
      return await db.transaction(async (tx) => {
        const result = await gate(c, tx, true);
        const response = result instanceof Response ? result : await action(tx, result);
        if (response.status >= 400) throw new Rollback(response);
        return response;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.carried;
      throw error;
    }
  };
  app.post("/api/artifacts/:id/comments", (c) =>
    mutate(c, async (client, { doc, userId }) => {
      if (!canComment(doc)) return c.json({ error: "forbidden" }, 403);
      const body = (await c.req.json().catch(() => null)) as {
        anchor?: unknown;
        body?: unknown;
        parentId?: string | null;
        expectedRevisionId?: unknown;
      } | null;
      if (typeof body?.body !== "string" || !body.body.trim()) return c.json({ error: "body_required" }, 400);
      if (Array.from(body.body).length > MAX_COMMENT_BODY) return c.json({ error: "too_large" }, 413);
      const parentId = body.parentId ?? null;
      if (parentId !== null && !isUuid(parentId)) return c.json({ error: "comment_not_found" }, 404);
      if (parentId === null && body.anchor === undefined) return c.json({ error: "root_requires_anchor" }, 400);
      if (parentId !== null && body.anchor !== undefined) return c.json({ error: "reply_has_no_anchor" }, 400);
      const rawAnchor = body.anchor;
      const parsedAnchor = rawAnchor === undefined ? null : commentAnchorSchema.safeParse(rawAnchor);
      if (parsedAnchor && !parsedAnchor.success) {
        const rawQuote =
          typeof rawAnchor === "object" && rawAnchor !== null
            ? (rawAnchor as { quotedText?: unknown }).quotedText
            : undefined;
        if (typeof rawQuote === "string" && Array.from(rawQuote).length > MAX_COMMENT_QUOTE)
          return c.json({ error: "too_large" }, 413);
        return c.json({ error: "invalid_anchor" }, 400);
      }
      if (parsedAnchor && !anchorKindAllowed(doc.kind, parsedAnchor.data.kind))
        return c.json({ error: "unsupported_anchor_kind" }, 400);
      if (parentId !== null) {
        const parent = await findComment(client, doc.id, parentId);
        if (!parent) return c.json({ error: "comment_not_found" }, 404);
        if (parent.parentId !== null) return c.json({ error: "nested_reply" }, 400);
      }
      const revision = await currentRevision(client, doc.id);
      if (!revision) return c.json({ error: "no_current_revision" }, 409);
      const anchor = parsedAnchor ? parsedAnchor.data : null;
      if (anchor?.kind === "text-range") {
        const read = await getRevisionBytes({
          storage,
          storageKey: revision.storageKey,
          sha256: revision.sha256,
          maxBytes: MAX_ARTIFACT_BYTES,
        });
        if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
        const decoded = decodeMarkdownText(read.value.bytes);
        if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
        const selected = anchorText(decoded.text, anchor);
        if (selected === null) return c.json({ error: "invalid_anchor" }, 400);
        if (Array.from(anchor.quotedText).length > MAX_COMMENT_QUOTE) return c.json({ error: "too_large" }, 413);
        if (selected !== anchor.quotedText) return c.json({ error: "anchor_mismatch" }, 400);
      }
      if (anchor !== null && isSceneAnchor(anchor)) {
        const scene = await currentScene(doc.id);
        if (scene === null) return c.json({ error: "artifact_unavailable" }, 500);
        if (sceneAnchorRefusal(scene, anchor) !== null) return c.json({ error: "unknown_node" }, 400);
      }
      if (parentId === null) {
        const expectedRevisionId = body.expectedRevisionId;
        if (typeof expectedRevisionId !== "string" || expectedRevisionId.trim() === "")
          return c.json({ error: "expected_revision_required" }, 400);
        if (expectedRevisionId !== revision.id) return c.json({ error: "revision_conflict" }, 409);
      }
      const inserted = await insertComment(client, {
        artifactId: doc.id,
        authorId: userId,
        parentId,
        anchor,
        revisionId: parentId === null ? revision.id : null,
        body: body.body,
      });
      return c.json({ id: inserted.id } satisfies CommentMutationResponse, 201);
    }),
  );
  for (const operation of ["resolve", "unresolve"] as const) {
    app.post(`/api/artifacts/:id/comments/:commentId/${operation}`, (c) =>
      mutate(c, async (client, { doc, userId }) => {
        if (!artifactPermissions(doc.access).resolve) return c.json({ error: "forbidden" }, 403);
        const id = c.req.param("commentId");
        const row = await findComment(client, doc.id, id);
        if (!row) return c.json({ error: "comment_not_found" }, 404);
        if (row.parentId !== null) return c.json({ error: "root_required" }, 400);
        await setCommentResolved(client, id, operation === "resolve", userId);
        return c.json({ id } satisfies CommentMutationResponse);
      }),
    );
  }
  app.delete("/api/artifacts/:id/comments/:commentId", (c) =>
    mutate(c, async (client, { doc, userId }) => {
      const id = c.req.param("commentId");
      const row = await findComment(client, doc.id, id);
      if (!row) return c.json({ error: "comment_not_found" }, 404);
      if (!artifactPermissions(doc.access).deleteAny && row.authorId !== userId)
        return c.json({ error: "forbidden" }, 403);
      await deleteComment(client, id);
      return c.json({ id } satisfies CommentMutationResponse);
    }),
  );
  return app;
}
