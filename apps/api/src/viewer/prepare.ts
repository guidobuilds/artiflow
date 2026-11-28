import {
  artboardAnchorNeedsRedaction,
  artboardAnchorSourceId,
  artboardSourceIsReadable,
  isArtboardAnchor,
  isSceneAnchor,
  redactArtboardAnchor,
  type ArtboardPointAnchor,
} from "@artiflow/domain/comment-anchors";
import { viewerFor } from "@artiflow/domain/kinds";
import type { Scene } from "@artiflow/domain/scene";

import { commentDocument, listComments } from "../adapters/postgres/comments-repo.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";
import { viewerActionsAssets, viewerCommentsAssets } from "./assets.ts";
import {
  bridgeNonce,
  bridgePins,
  designRequestNonce,
  viewerCommentsConfig,
  type ViewerCommentsConfig,
} from "./comments-data.ts";
import { loadViewerComments, type ViewerCommentLoad } from "./comments-degrade.ts";
import { htmlBridgeScript } from "./html-bridge-script.ts";
import {
  refreshPlan,
  type DesignRequestShellConfig,
  type ViewerActions,
  type ViewerAudience,
  type ViewerChrome,
  type ViewerCommentsPlan,
  type ViewerManagementPlan,
  type ViewerModel,
  type ViewerRefresh,
} from "./model.ts";

export type ViewerArtifactRow = {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly title: string | null;
  readonly revisionId: string | null;
  readonly revisionNumber: number;
  readonly sha256: string;
};

export type ViewerRequest =
  | { readonly kind: "session"; readonly viewerId: string }
  | { readonly kind: "bearer"; readonly viewerId: string }
  | { readonly kind: "public"; readonly token: string; readonly showComments: boolean };

type SessionRequest = Exclude<ViewerRequest, { kind: "public" }>;
type PublicRequest = Extract<ViewerRequest, { kind: "public" }>;

export type ViewerPreparation = {
  readonly db: AppDb;
  readonly artifact: ViewerArtifactRow;
  readonly request: ViewerRequest;
  readonly embed: boolean;
  readonly source: string | null;
  readonly publishedScene?: () => Promise<Scene | null>;
};

const DENIED: ViewerActions = { comment: false, resolve: false, deleteOwn: false, deleteAny: false };

const chromeOf = (request: ViewerRequest, embed: boolean): ViewerChrome =>
  embed ? "none" : request.kind === "public" ? "anonymous" : "full";

const audienceOf = (request: ViewerRequest, access: string | null): ViewerAudience =>
  request.kind === "public"
    ? { kind: "public", showComments: request.showComments }
    : request.kind === "bearer"
      ? { kind: "bearer", viewerId: request.viewerId }
      : { kind: "session", viewerId: request.viewerId, access };

const actionsOf = (loaded: { readonly canComment: boolean; readonly deleteAny: boolean }): ViewerActions => ({
  comment: loaded.canComment,
  resolve: loaded.canComment,
  deleteOwn: true,
  deleteAny: loaded.deleteAny,
});

const pagePlan = (config: ViewerCommentsConfig, source: string | null, nonce: string): ViewerCommentsPlan => ({
  kind: "page",
  config,
  assets: viewerCommentsAssets(),
  bridge: source === null ? { nonce, script: htmlBridgeScript({ nonce, pins: bridgePins(config.threads) }) } : null,
});

const managementOf = (input: ViewerPreparation, request: ViewerRequest, access: string | null): ViewerManagementPlan =>
  request.kind !== "session" || input.embed || access !== "owner"
    ? { kind: "none" }
    : {
        kind: "menu",
        actions: { share: true, delete: true, rename: true },
        config: { id: input.artifact.id, title: input.artifact.title, kind: input.artifact.kind },
        assets: viewerActionsAssets(),
      };

type ViewerCommentRow = Awaited<ReturnType<typeof listComments>>[number];

async function sessionLoad(
  db: AppDb,
  viewerId: string,
  artifact: ViewerArtifactRow,
  threads: boolean,
): Promise<{ loaded: ViewerCommentLoad<ViewerCommentRow>; access: string | null }> {
  const { id: artifactId } = artifact;
  const seen: { access: string | null } = { access: null };
  const loaded = await loadViewerComments({
    document: async () => {
      const shared = await commentDocument(db, viewerId, artifactId, "shared");
      seen.access = shared === undefined ? null : (shared.access ?? null);
      return shared;
    },
    list: threads ? () => listComments(db, artifactId, true) : async () => [],
    onError: (error) => console.error(`[viewer] comments degraded for ${artifactId}`, error),
  });
  return { loaded, access: seen.access };
}

async function redactUnreadableArtboardAnchors(
  input: ViewerPreparation,
  request: SessionRequest,
  config: ViewerCommentsConfig,
): Promise<ViewerCommentsConfig> {
  const anchored = config.threads.filter((thread) => isArtboardAnchor(thread.anchor));
  if (anchored.length === 0) return config;
  const scene = input.publishedScene === undefined ? null : await input.publishedScene();
  const readable = new Map<string, boolean>();
  if (scene !== null) {
    const sources = new Set(
      anchored.flatMap((thread) => {
        const sourceId = artboardAnchorSourceId(scene, thread.anchor as ArtboardPointAnchor);
        return sourceId === null ? [] : [sourceId];
      }),
    );
    await Promise.all(
      [...sources].map(async (sourceId) => {
        const found = artboardSourceIsReadable(await commentDocument(input.db, request.viewerId, sourceId, "shared"));
        readable.set(sourceId, found);
      }),
    );
  }
  const readableSource = (sourceId: string): boolean => readable.get(sourceId) === true;
  const hiddenIds = new Set(
    anchored
      .filter((thread) => artboardAnchorNeedsRedaction(scene, thread.anchor as ArtboardPointAnchor, readableSource))
      .map((thread) => thread.id),
  );
  if (hiddenIds.size === 0) return config;
  return {
    ...config,
    threads: config.threads.map((thread) =>
      hiddenIds.has(thread.id)
        ? { ...thread, anchor: redactArtboardAnchor(thread.anchor as ArtboardPointAnchor) }
        : thread,
    ),
  };
}

async function sessionCommentsPlan(
  input: ViewerPreparation,
  request: SessionRequest,
  loaded: ViewerCommentLoad<ViewerCommentRow>,
): Promise<ViewerCommentsPlan> {
  const { artifact, source } = input;
  const { id: artifactId, sha256 } = artifact;
  const nonce = bridgeNonce(artifactId, sha256);
  const scene =
    input.publishedScene === undefined || !loaded.rows.some((row) => isSceneAnchor(row.anchor))
      ? null
      : await input.publishedScene();
  const config = viewerCommentsConfig({
    artifactId,
    ...(source === null ? { mode: "element" as const, bridgeNonce: nonce } : {}),
    ...(artifact.revisionId === null || artifact.revisionId === "" ? {} : { revisionId: artifact.revisionId }),
    source: source ?? "",
    rows: loaded.rows,
    viewerId: request.viewerId,
    canComment: loaded.canComment,
    canDeleteOwn: true,
    deleteAny: loaded.deleteAny,
    ...(scene === null ? {} : { scene }),
    endpoints: {
      comments: `/api/artifacts/${artifactId}/comments`,
      resolve: `/api/artifacts/${artifactId}/comments`,
      deleteComment: `/api/artifacts/${artifactId}/comments`,
      list: `/artifact/${artifactId}/comments`,
    },
  });
  const redacted = await redactUnreadableArtboardAnchors(input, request, config);
  if (viewerFor(artifact.kind) === "scene") return { kind: "document", config: redacted };
  return pagePlan(redacted, source, nonce);
}

async function publicCommentsPlan(input: ViewerPreparation, request: PublicRequest): Promise<ViewerCommentsPlan> {
  const { artifact, source } = input;
  if (!request.showComments || viewerFor(artifact.kind) === "scene") return { kind: "none" };
  const { id: artifactId, sha256 } = artifact;
  const { token } = request;
  const nonce = bridgeNonce(artifactId, sha256);
  const rows = await listComments(input.db, artifactId, true);
  const config = viewerCommentsConfig({
    artifactId,
    ...(source === null ? { mode: "element" as const, bridgeNonce: nonce } : {}),
    source: source ?? "",
    rows,
    viewerId: null,
    canComment: false,
    canDeleteOwn: false,
    deleteAny: false,
    endpoints: { comments: `/share/${token}/comments`, resolve: "", deleteComment: "" },
  });
  return pagePlan(config, source, nonce);
}

const refreshOf = (input: ViewerPreparation, commentsShown: boolean): ViewerRefresh => {
  const { artifact, request } = input;
  const revisionNumber = artifact.revisionNumber;
  const sha256 = artifact.sha256;
  return request.kind === "public"
    ? { plan: refreshPlan(`/share/${request.token}?meta=1`), revisionNumber, sha256, comments: commentsShown }
    : { plan: refreshPlan(`/api/artifacts/${artifact.id}`), revisionNumber, sha256 };
};

const designRequestOf = (input: ViewerPreparation, canComment: boolean): DesignRequestShellConfig | undefined => {
  const { artifact, request, embed } = input;
  if (embed || request.kind === "public" || artifact.kind !== "canvas") return undefined;
  if (artifact.revisionId === null || artifact.revisionId === "") return undefined;
  return {
    nonce: designRequestNonce(artifact.id, artifact.sha256),
    canComment,
    commentsEndpoint: `/api/artifacts/${artifact.id}/comments`,
    expectedRevisionId: artifact.revisionId,
    designId: artifact.id,
    designTitle: artifact.title ?? "Design",
  };
};

const modelOf = (
  input: ViewerPreparation,
  access: string | null,
  actions: ViewerActions,
  management: ViewerManagementPlan,
  comments: ViewerCommentsPlan,
  designRequest?: DesignRequestShellConfig | undefined,
): ViewerModel => {
  const { artifact, request, embed } = input;
  const chrome = chromeOf(request, embed);
  const commentsShown = request.kind === "public" && comments.kind === "page";
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: chrome === "full" ? artifact.title : null,
    revision: {
      id: request.kind === "public" ? null : artifact.revisionId,
      number: artifact.revisionNumber,
      sha256: artifact.sha256,
    },
    audience: audienceOf(request, access),
    chrome,
    backHref: chrome === "full" ? "/" : undefined,
    meta: chrome === "full" ? { title: artifact.title, version: artifact.revisionNumber } : undefined,
    embed: chrome === "none",
    actions,
    management,
    comments,
    refresh: refreshOf(input, commentsShown),
    ...(designRequest === undefined ? {} : { designRequest }),
  };
};

async function prepareSession(input: ViewerPreparation, request: SessionRequest): Promise<ViewerModel> {
  const session = await sessionLoad(input.db, request.viewerId, input.artifact, !input.embed);
  const access = input.artifact.ownerId === request.viewerId ? "owner" : session.access;
  const management = managementOf(input, request, access);
  const comments = input.embed ? { kind: "none" as const } : await sessionCommentsPlan(input, request, session.loaded);
  return modelOf(
    input,
    access,
    actionsOf(session.loaded),
    management,
    comments,
    designRequestOf(input, session.loaded.canComment),
  );
}

async function preparePublic(input: ViewerPreparation, request: PublicRequest): Promise<ViewerModel> {
  const comments = await publicCommentsPlan(input, request);
  return modelOf(input, null, DENIED, { kind: "none" }, comments);
}

export async function prepareViewer(input: ViewerPreparation): Promise<ViewerModel> {
  return input.request.kind === "public" ? preparePublic(input, input.request) : prepareSession(input, input.request);
}
