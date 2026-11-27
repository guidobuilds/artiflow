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
import { renameArtifact } from "../domain/commits.ts";
import { readableArtifactPredicate, sceneAssetDigests } from "../routes/sharing.ts";
import type { Storage } from "../adapters/storage/client.ts";
import type { McpBearerVerifier } from "../mcp/mount.ts";
import type {
  ArtifactDetail,
  ArtifactListResponse,
  ArtifactMetadataUpdateResponse,
  ArtifactSummary,
  SharedArtifactListResponse,
} from "@artiflow/contracts/artifacts";
import { originOf } from "../viewer/artifact.ts";
import { NOT_FOUND_HEADERS, NOT_FOUND_PAGE } from "../viewer/chrome/theme.ts";
import { commentConfig, commentThreads } from "../viewer/model.ts";
import { prepareViewer } from "../viewer/prepare.ts";
import { htmlView } from "../viewer/views/html.ts";
import { markdownView, renderMarkdownFragment } from "../viewer/views/markdown.ts";
import { sceneView, type SceneImages } from "../viewer/views/scene.ts";
import { decodeMarkdownText } from "@artiflow/domain/markdown";
import { readScene, type Scene } from "@artiflow/domain/scene";
import { acceptsSceneAnchors } from "@artiflow/domain/comment-anchors";
import { acceptsTextOperations, rendersInlineMarkdown, viewerFor, wireNameFor } from "@artiflow/domain/kinds";
import { cookieMutationGuard, isJsonContentType, isUuid, jsonError, sessionUserId } from "../http/index.ts";
import { readPrincipal } from "../http/principal.ts";

const LIST_LIMIT = 100;
const SHARED_LIMIT = 200;
const METADATA_BODY_LIMIT = 64 * 1024;

type LibraryAuth = ReturnType<typeof createAuth>;
export type LibraryOptions = {
  database: Database;
  auth: LibraryAuth;
  storage: Storage;
  bearerVerifier?: McpBearerVerifier;
  maxArtifactBytes?: number;
  deletion?: DeletionWiring;
  publicOrigin?: string;
  principal?: true;
};
const columns = {
  id: artifacts.id,
  ownerId: artifacts.ownerId,
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

  const publishedSceneOf = (storageKey: string, sha256: string) => async (): Promise<Scene | null> => {
    const read = await getRevisionBytes({ storage, storageKey, sha256, maxBytes });
    if (!read.ok) return null;
    const parsed = readScene(new TextDecoder().decode(read.value.bytes));
    return parsed.ok ? parsed.value : null;
  };

  const viewerPage = async (
    c: Context,
    artifactId: string,
    viewerId: string,
    embed: boolean,
    transport: "session" | "bearer",
  ) => {
    const row = await readableArtifact(db, artifactId, viewerId);
    if (!row) return c.html(NOT_FOUND_PAGE, 404, NOT_FOUND_HEADERS);
    if (!row.storageKey || !row.sha256 || row.revisionNumber === null)
      return c.json({ error: "no_current_revision" }, 409);
    const artifact = { ...row, revisionNumber: row.revisionNumber, sha256: row.sha256 };
    const request =
      transport === "bearer" ? ({ kind: "bearer", viewerId } as const) : ({ kind: "session", viewerId } as const);
    const read = await getRevisionBytes({
      storage,
      storageKey: row.storageKey,
      sha256: row.sha256,
      maxBytes,
    });
    if (!read.ok) return c.json({ error: "artifact_unavailable" }, 500);
    if (rendersInlineMarkdown(row.kind)) {
      const decoded = decodeMarkdownText(read.value.bytes);
      if (!decoded.ok) return c.json({ error: "artifact_unavailable" }, 500);
      const model = await prepareViewer({ db, artifact, request, embed, source: decoded.text });
      const page = markdownView(model, renderMarkdownFragment(decoded.text));
      return c.html(page.html, 200, page.headers);
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
      const model = await prepareViewer({
        db,
        artifact,
        request,
        embed,
        source: null,
        publishedScene: async () => scene.value,
      });
      const page = sceneView(model, {
        scene: scene.value,
        frameId: frame,
        images,
        threads: commentThreads(model.comments),
        kind: row.kind,
      });
      return c.html(page.html, 200, page.headers);
    }
    const model = await prepareViewer({ db, artifact, request, embed, source: null });
    const page = htmlView(model, new TextDecoder().decode(read.value.bytes));
    return c.html(page.html, 200, page.headers);
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
        return viewerPage(c, c.req.param("id"), claims.userId, c.req.query("embed") === "1", "bearer");
      });
    }
    const viewerId = await sessionUserId(auth, c.req.raw.headers);
    if (!viewerId) return c.json({ error: "unauthorized" }, 401);
    return viewerPage(c, c.req.param("id"), viewerId, c.req.query("embed") === "1", "session");
  });

  app.get("/artifact/:id/comments", async (c) => {
    const bearerPresent = c.req.raw.headers.has("authorization");
    const viewerId = bearerPresent ? null : await sessionUserId(auth, c.req.raw.headers);
    const row = viewerId === null ? null : await readableArtifact(db, c.req.param("id"), viewerId);
    const gate = commentsListGate({ bearerPresent, sessionUserId: viewerId, artifact: row });
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
    const model = await prepareViewer({
      db,
      artifact: { ...gate.artifact, revisionNumber: gate.revisionNumber, sha256: gate.sha256 },
      request: { kind: "session", viewerId: gate.ownerId },
      embed: false,
      source,
      ...(acceptsSceneAnchors(gate.artifact.kind)
        ? { publishedScene: publishedSceneOf(gate.storageKey, gate.sha256) }
        : {}),
    });
    const config = commentConfig(model.comments);
    if (config === null) return c.json({ error: "not_found" }, 404);
    c.header("cache-control", "no-store");
    return c.json({ canComment: config.canComment, threads: config.threads });
  });

  const mutationOrigin = options.publicOrigin ?? "";
  if (mutationOrigin !== "") {
    app.patch("/api/artifacts/:id/metadata", async (c) => {
      const rejected = cookieMutationGuard(c, mutationOrigin);
      if (rejected === "origin_not_allowed") return jsonError(c, rejected, 403);
      if (rejected === "json_content_type_required") return jsonError(c, rejected, 415);
      const ownerId = await sessionUserId(auth, c.req.raw.headers);
      if (!ownerId) return jsonError(c, "unauthorized", 401);
      const artifactId = c.req.param("id");
      if (!isUuid(artifactId)) return jsonError(c, "not_found", 404);
      const declared = c.req.header("content-length");
      if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > METADATA_BODY_LIMIT)
        return jsonError(c, "too_large", 413);
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > METADATA_BODY_LIMIT) return jsonError(c, "too_large", 413);
      const body = ((): { title?: unknown } | null => {
        try {
          return JSON.parse(raw) as { title?: unknown } | null;
        } catch {
          return null;
        }
      })();
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      const renamed = await renameArtifact(db, { artifactId, ownerId, title });
      if (renamed.ok) return c.json(renamed.value satisfies ArtifactMetadataUpdateResponse, 200);
      if (renamed.kind === "validation") return jsonError(c, renamed.reason, 400);
      if (renamed.kind === "not_found" || renamed.kind === "gone") return jsonError(c, "not_found", 404);
      return jsonError(c, "rename_failed", 500);
    });
  }

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
