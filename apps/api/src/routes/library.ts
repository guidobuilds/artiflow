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
import { readableArtifactPredicate, sceneAssetDigests } from "../routes/sharing.ts";
import type { Storage } from "../adapters/storage/client.ts";
import type { McpBearerVerifier } from "../mcp/mount.ts";
import type {
  ArtifactDetail,
  ArtifactListResponse,
  ArtifactSummary,
  SharedArtifactListResponse,
} from "@artiflow/contracts/artifacts";
import {
  escapeAttribute,
  NOT_FOUND_HEADERS,
  NOT_FOUND_PAGE,
  originOf,
  refreshPlan,
  sceneHeaders,
  VIEWER_HEADERS,
  wrapperPage,
} from "../viewer/html.ts";
import { markdownViewerPage, renderMarkdownFragment } from "../viewer/markdown.ts";
import { viewerCommentsAssets } from "../viewer/assets.ts";
import { bridgeNonce, bridgePins, viewerCommentsConfig } from "../viewer/comments-data.ts";
import { htmlBridgeScript } from "../viewer/html-bridge-script.ts";
import { commentDocument, listComments } from "../adapters/postgres/comments-repo.ts";
import { loadViewerComments } from "../viewer/comments-degrade.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { readScene, type Scene } from "@artiflow/domain/scene";
import { acceptsSceneAnchors, isSceneAnchor } from "@artiflow/domain/comment-anchors";
import { acceptsTextOperations, rendersInlineMarkdown, viewerFor, wireNameFor } from "@artiflow/domain/kinds";
import { renderSceneDocument, type SceneImages } from "../viewer/scene.ts";
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

type ReadableArtifactRow = { storageKey: string | null; sha256: string | null; revisionNumber: number | null };

export type CommentsListGate<A extends ReadableArtifactRow> =
  | { kind: "ok"; ownerId: string; artifact: A; storageKey: string; sha256: string; revisionNumber: number }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "no_current_revision" };

export function commentsListGate<A extends ReadableArtifactRow>(input: {
  bearerPresent: boolean;
  sessionUserId: string | null;
  artifact: A | null | undefined;
}): CommentsListGate<A> {
  if (input.bearerPresent) return { kind: "unauthorized" };
  if (input.sessionUserId === null) return { kind: "unauthorized" };
  if (input.artifact === null || input.artifact === undefined) return { kind: "not_found" };
  const { storageKey, sha256, revisionNumber } = input.artifact;
  if (!storageKey || !sha256 || revisionNumber === null) return { kind: "no_current_revision" };
  return { kind: "ok", ownerId: input.sessionUserId, artifact: input.artifact, storageKey, sha256, revisionNumber };
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
  const app = new Hono();

  app.get("/api/artifacts", async (c) => {
    const ownerId = readPrincipal(c.req.raw.headers)?.userId ?? (await sessionUserId(auth, c.req.raw.headers));
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    const rows = await listOwnedArtifacts(db, ownerId);
    const artifacts: ArtifactSummary[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: wireNameFor(row.kind),
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
      kind: wireNameFor(row.kind),
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
      kind: wireNameFor(row.kind),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      observedSizeBytes: row.observedSizeBytes,
      revision,
    } satisfies ArtifactDetail);
  });

  const ownerCommentsConfig = async (
    artifactId: string,
    sha256: string,
    ownerId: string,
    source: string | null,
    publishedScene?: () => Promise<Scene | null>,
  ) => {
    const degraded = await loadViewerComments({
      document: () => commentDocument(db, ownerId, artifactId, "shared"),
      list: () => listComments(db, artifactId, true),
      onError: (error) => console.error(`[viewer] comments degraded for ${artifactId}`, error),
    });
    const scene =
      publishedScene === undefined || !degraded.rows.some((row) => isSceneAnchor(row.anchor))
        ? null
        : await publishedScene();
    return viewerCommentsConfig({
      artifactId,
      ...(source === null ? { mode: "element" as const, bridgeNonce: bridgeNonce(artifactId, sha256) } : {}),
      source: source ?? "",
      rows: degraded.rows,
      viewerId: ownerId,
      canComment: degraded.canComment,
      canDeleteOwn: true,
      deleteAny: degraded.deleteAny,
      ...(scene === null ? {} : { scene }),
      endpoints: {
        comments: `/api/artifacts/${artifactId}/comments`,
        resolve: `/api/artifacts/${artifactId}/comments`,
        deleteComment: `/api/artifacts/${artifactId}/comments`,
        list: `/artifact/${artifactId}/comments`,
      },
    });
  };

  const publishedSceneOf = (storageKey: string, sha256: string) => async (): Promise<Scene | null> => {
    const read = await getRevisionBytes({ storage, storageKey, sha256, maxBytes });
    if (!read.ok) return null;
    const parsed = readScene(new TextDecoder().decode(read.value.bytes));
    return parsed.ok ? parsed.value : null;
  };

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
    const refresh = {
      plan: refreshPlan(`/api/artifacts/${row.id}`),
      revisionNumber: row.revisionNumber,
      sha256: row.sha256,
    };
    if (rendersInlineMarkdown(row.kind)) {
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
      const comments = {
        config: await ownerCommentsConfig(row.id, row.sha256, ownerId, decoded.text),
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
    if (viewerFor(row.kind) === "scene") {
      const scene = readScene(new TextDecoder().decode(read.value.bytes));
      if (!scene.ok) return c.json({ error: "artifact_unavailable" }, 500);
      const frame = c.req.query("frame");
      const origin = originOf(c.req.url);
      const images: SceneImages | undefined =
        origin === null
          ? undefined
          : { origin, artifactId: row.id, digests: await sceneAssetDigests(db, row.id, scene.value) };
      const config = await ownerCommentsConfig(row.id, row.sha256, ownerId, null, async () => scene.value);
      return c.html(
        wrapperPage(
          escapeAttribute(renderSceneDocument(scene.value, frame, images, config.threads, row.kind)),
          embed ? undefined : "/",
          { title: row.title, version: row.revisionNumber },
          embed,
          refresh,
        ),
        200,
        sceneHeaders(origin),
      );
    }
    const escaped = escapeAttribute(new TextDecoder().decode(read.value.bytes));
    const htmlConfig = await ownerCommentsConfig(row.id, row.sha256, ownerId, null);
    const nonce = bridgeNonce(row.id, row.sha256);
    return c.html(
      wrapperPage(escaped, embed ? undefined : "/", { title: row.title, version: row.revisionNumber }, embed, refresh, {
        nonce,
        bridge: htmlBridgeScript({ nonce, pins: bridgePins(htmlConfig.threads) }),
        config: htmlConfig,
        assets: viewerCommentsAssets(),
      }),
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

  app.get("/artifact/:id/comments", async (c) => {
    const bearerPresent = c.req.raw.headers.has("authorization");
    const ownerId = bearerPresent ? null : await sessionUserId(auth, c.req.raw.headers);
    const row = ownerId === null ? null : await readableArtifact(db, c.req.param("id"), ownerId);
    const gate = commentsListGate({ bearerPresent, sessionUserId: ownerId, artifact: row });
    if (gate.kind === "unauthorized") return c.json({ error: "unauthorized" }, 401);
    if (gate.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (gate.kind === "no_current_revision") return c.json({ error: "no_current_revision" }, 409);
    if (gate.kind !== "ok") return c.json({ error: "not_found" }, 404);
    let source: string | null = null;
    if (acceptsTextOperations(gate.artifact.kind)) {
      const read = await getRevisionBytes({
        storage,
        storageKey: gate.storageKey,
        sha256: gate.sha256,
        maxBytes,
      });
      if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
      source = decoded.text;
    }
    const config = await ownerCommentsConfig(
      gate.artifact.id,
      gate.sha256,
      gate.ownerId,
      source,
      acceptsSceneAnchors(gate.artifact.kind) ? publishedSceneOf(gate.storageKey, gate.sha256) : undefined,
    );
    c.header("cache-control", "no-store");
    return c.json({ canComment: config.canComment, threads: config.threads });
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
