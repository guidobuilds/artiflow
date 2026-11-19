import { Hono, type Context } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { AppDb, Database } from "../adapters/postgres/db/client.ts";

import { getRevisionBytes } from "../adapters/storage/s3.ts";
import type { createAuth } from "../auth.ts";
import {
  artifacts,
  artifactRevisions,
  artifactShares,
  MAX_ARTIFACT_BYTES,
} from "../adapters/postgres/db/artifact-schema.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { deleteArtifact, type DeletionWiring } from "../domain/deletion.ts";
import { readableArtifactPredicate } from "../routes/sharing.ts";
import type { Storage } from "../adapters/storage/client.ts";
import type { McpBearerVerifier } from "../mcp/mount.ts";
import type {
  ArtifactDetail,
  ArtifactListResponse,
  ArtifactSummary,
  SharedArtifactListResponse,
} from "@artiflow/contracts/artifacts";
import { escapeAttribute, NOT_FOUND_HEADERS, NOT_FOUND_PAGE, VIEWER_HEADERS, wrapperPage } from "../viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../viewer/markdown.ts";
import { viewerCommentsAssets } from "../viewer/assets.ts";
import { bridgeNonce, bridgePins, viewerCommentsConfig } from "../viewer/comments-data.ts";
import { htmlBridgeScript } from "../viewer/html-bridge-script.ts";
import { commentDocument, listComments } from "../adapters/postgres/comments-repo.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { isJsonContentType, isUuid, jsonError, sessionUserId } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";

const LIST_LIMIT = 100;
const SHARED_LIMIT = 200;

type LibraryAuth = ReturnType<typeof createAuth>;
export type LibraryOptions = {
  database: Database;
  auth: LibraryAuth;
  storage: Storage;
  bearerVerifier?: McpBearerVerifier;
  maxArtifactBytes?: number;
  deletion?: DeletionWiring;
  principal?: true;
};
const columns = {
  id: artifacts.id,
  title: artifacts.title,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
  observedSizeBytes: artifacts.observedSizeBytes,
  currentRevisionId: artifacts.currentRevisionId,
  kind: artifacts.kind,
  revisionId: artifactRevisions.id,
  revisionNumber: artifactRevisions.revision,
  sha256: artifactRevisions.sha256,
  sizeBytes: artifactRevisions.sizeBytes,
  storageKey: artifactRevisions.storageKey,
};
const revisionCount = sql<number>`(select count(*)::int from ${artifactRevisions} where ${artifactRevisions.artifactId} = ${artifacts.id})`;
const ownedPredicate = (ownerId: string) => and(eq(artifacts.ownerId, ownerId), isNull(artifacts.deletedAt));

async function listOwnedArtifacts(db: AppDb, ownerId: string) {
  return db
    .select({ ...columns, revisionCount })
    .from(artifacts)
    .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
    .where(ownedPredicate(ownerId))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(LIST_LIMIT);
}

async function listSharedArtifacts(db: AppDb, userId: string) {
  return db
    .select({ ...columns, sharedBy: user.email, revisionCount })
    .from(artifacts)
    .innerJoin(artifactShares, eq(artifactShares.artifactId, artifacts.id))
    .innerJoin(user, eq(user.id, artifactShares.grantedByUserId))
    .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
    .where(and(eq(artifactShares.sharedWithUserId, userId), isNull(artifacts.deletedAt)))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(SHARED_LIMIT);
}

const methodNotAllowed = (c: Context) => jsonError(c, "method_not_allowed", 405);

async function readableArtifact(db: AppDb, artifactId: string, userId: string) {
  return (
    await db
      .select(columns)
      .from(artifacts)
      .leftJoin(artifactRevisions, eq(artifactRevisions.id, artifacts.currentRevisionId))
      .where(and(eq(artifacts.id, artifactId), readableArtifactPredicate(userId)))
  )[0];
}

export function createLibraryApp(options: LibraryOptions): Hono {
  const { database, auth, storage } = options;
  const db = database.db;
  const maxBytes = Math.min(options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
  const wireKind = (kind: string): ArtifactSummary["kind"] =>
    kind === "html" || kind === "markdown" ? kind : "unknown";
  const app = new Hono();

  app.get("/api/artifacts", async (c) => {
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    const rows = await listOwnedArtifacts(db, ownerId);
    const artifacts: ArtifactSummary[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: wireKind(row.kind),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      observedSizeBytes: row.observedSizeBytes,
      revisionCount: row.revisionCount,
      currentRevisionId: row.currentRevisionId,
      sha256: row.sha256,
    }));
    return c.json({ artifacts } satisfies ArtifactListResponse);
  });

  app.get("/api/artifacts/shared", async (c) => {
    const userId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const rows = await listSharedArtifacts(db, userId);
    const artifacts = rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      observedSizeBytes: row.observedSizeBytes,
      revisionCount: row.revisionCount,
      currentRevisionId: row.currentRevisionId,
      sha256: row.sha256,
      kind: wireKind(row.kind),
      sharedBy: { email: row.sharedBy },
    }));
    return c.json({ artifacts } satisfies SharedArtifactListResponse);
  });

  app.get("/api/artifacts/:id", async (c) => {
    const principal = options.principal ? readPrincipal(c.req.raw.headers) : null;
    const userId = principal?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const row = await readableArtifact(db, c.req.param("id"), userId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const revision =
      row.revisionId !== null && row.revisionNumber !== null && row.sha256 !== null && row.sizeBytes !== null
        ? { id: row.revisionId, revisionNumber: row.revisionNumber, sha256: row.sha256, sizeBytes: row.sizeBytes }
        : null;
    return c.json({
      id: row.id,
      title: row.title,
      kind: wireKind(row.kind),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      observedSizeBytes: row.observedSizeBytes,
      revision,
    } satisfies ArtifactDetail);
  });

  const viewerPage = async (c: Context, artifactId: string, ownerId: string, embed: boolean) => {
    const row = await readableArtifact(db, artifactId, ownerId);
    if (!row) return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    if (!row.storageKey || !row.sha256 || row.revisionNumber === null)
      return c.json({ error: "no_current_revision" }, 409);
    const read = await getRevisionBytes({
      storage,
      storageKey: row.storageKey,
      sha256: row.sha256,
      maxBytes,
    });
    if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
    const refresh = { metaUrl: `/api/artifacts/${row.id}`, revisionNumber: row.revisionNumber, sha256: row.sha256 };
    if (row.kind === "markdown") {
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
      const shared = await commentDocument(db, ownerId, row.id, "shared");
      const rows = shared === undefined ? [] : await listComments(db, row.id, true);
      const comments = {
        config: viewerCommentsConfig({
          artifactId: row.id,
          source: decoded.text,
          rows,
          viewerId: ownerId,
          canComment: shared !== undefined && shared.access !== "reader",
          canDeleteOwn: true,
          endpoints: {
            comments: `/api/artifacts/${row.id}/comments`,
            resolve: `/api/artifacts/${row.id}/comments`,
            deleteComment: `/api/artifacts/${row.id}/comments`,
          },
        }),
        assets: viewerCommentsAssets(),
      };
      return c.html(
        markdownViewerPage(
          renderMarkdownFragment(decoded.text),
          embed ? undefined : "/",
          { title: row.title, version: row.revisionNumber },
          embed,
          refresh,
          comments,
        ),
        200,
        VIEWER_HEADERS,
      );
    }
    const escaped = escapeAttribute(new TextDecoder().decode(read.value.bytes));
    const htmlShared = await commentDocument(db, ownerId, row.id, "shared");
    const htmlRows = htmlShared === undefined ? [] : await listComments(db, row.id, true);
    const nonce = bridgeNonce(row.id, row.sha256);
    const htmlConfig = viewerCommentsConfig({
      artifactId: row.id,
      mode: "element",
      bridgeNonce: nonce,
      source: "",
      rows: htmlRows,
      viewerId: ownerId,
      canComment: htmlShared !== undefined && htmlShared.access !== "reader",
      canDeleteOwn: true,
      endpoints: {
        comments: `/api/artifacts/${row.id}/comments`,
        resolve: `/api/artifacts/${row.id}/comments`,
        deleteComment: `/api/artifacts/${row.id}/comments`,
      },
    });
    return c.html(
      wrapperPage(
        escaped,
        embed ? undefined : "/",
        { title: row.title, version: row.revisionNumber },
        embed,
        { ...refresh, srcdocUrl: `/artifact/${row.id}` },
        {
          nonce,
          bridge: htmlBridgeScript({ nonce, pins: bridgePins(htmlConfig.threads) }),
          config: htmlConfig,
          assets: viewerCommentsAssets(),
        },
      ),
      200,
      VIEWER_HEADERS,
    );
  };

  app.get("/artifact/:id", async (c) => {
    if (c.req.raw.headers.has("authorization")) {
      if (!options.bearerVerifier) return c.json({ error: "unauthorized" }, 401);
      return options.bearerVerifier(c.req.raw, (_request, claims) => {
        if (!claims.userId) {
          c.header("www-authenticate", 'Bearer error="invalid_token"');
          return c.json({ error: "unauthorized" }, 401);
        }
        if (!claims.scopes.includes("artifacts:read")) {
          c.header("www-authenticate", 'Bearer error="insufficient_scope", scope="artifacts:read"');
          return c.json({ error: "insufficient_scope" }, 401);
        }
        return viewerPage(c, c.req.param("id"), claims.userId, c.req.query("embed") === "1");
      });
    }
    const ownerId = await sessionUserId(auth, c.req.raw.headers);
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    return viewerPage(c, c.req.param("id"), ownerId, c.req.query("embed") === "1");
  });

  if (options.deletion) {
    const { publicOrigin, deleteRevisionBytes } = options.deletion;
    app.delete("/api/artifacts/:id", async (c) => {
      const principal = options.principal ? readPrincipal(c.req.raw.headers) : null;
      if (!principal) {
        if (c.req.header("origin") !== publicOrigin) return c.json({ error: "origin_not_allowed" }, 403);
        if (!isJsonContentType(c.req.header("content-type")))
          return c.json({ error: "json_content_type_required" }, 415);
      }
      const ownerId = principal?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
      if (!ownerId) return c.json({ error: "unauthorized" }, 401);
      const artifactId = c.req.param("id");
      if (!isUuid(artifactId)) return c.json({ error: "not_found" }, 404);
      const deleted = await deleteArtifact({ database, storage, deleteRevisionBytes }, artifactId, ownerId);
      return deleted.ok ? c.json({ ok: true }, 200) : c.json({ error: "not_found" }, 404);
    });
  }

  app.all("/api/artifacts/*", methodNotAllowed);
  app.all("/artifact/*", methodNotAllowed);
  return app;
}
