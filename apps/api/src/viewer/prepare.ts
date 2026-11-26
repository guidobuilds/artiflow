import { isSceneAnchor } from "@artiflow/domain/comment-anchors";
import { viewerFor } from "@artiflow/domain/kinds";
import type { Scene } from "@artiflow/domain/scene";

import { commentDocument, listComments } from "../adapters/postgres/comments-repo.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";
import { viewerCommentsAssets } from "./assets.ts";
import { bridgeNonce, bridgePins, viewerCommentsConfig, type ViewerCommentsConfig } from "./comments-data.ts";
import { loadViewerComments, type ViewerCommentLoad } from "./comments-degrade.ts";
import { htmlBridgeScript } from "./html-bridge-script.ts";
import {
  refreshPlan,
  type ViewerActions,
  type ViewerAudience,
  type ViewerChrome,
  type ViewerCommentsPlan,
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

type ViewerCommentRow = Awaited<ReturnType<typeof listComments>>[number];

async function sessionLoad(
  db: AppDb,
  viewerId: string,
  artifact: ViewerArtifactRow,
): Promise<{ loaded: ViewerCommentLoad<ViewerCommentRow>; access: string | null }> {
  const { id: artifactId } = artifact;
  const seen: { access: string | null } = { access: null };
  const loaded = await loadViewerComments({
    document: async () => {
      const shared = await commentDocument(db, viewerId, artifactId, "shared");
      seen.access = shared === undefined ? null : (shared.access ?? null);
      return shared;
    },
    list: () => listComments(db, artifactId, true),
    onError: (error) => console.error(`[viewer] comments degraded for ${artifactId}`, error),
  });
  return { loaded, access: seen.access };
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
  if (viewerFor(artifact.kind) === "scene") return { kind: "document", config };
  return pagePlan(config, source, nonce);
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

const modelOf = (
  input: ViewerPreparation,
  access: string | null,
  actions: ViewerActions,
  comments: ViewerCommentsPlan,
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
    comments,
    refresh: refreshOf(input, commentsShown),
  };
};

async function prepareSession(input: ViewerPreparation, request: SessionRequest): Promise<ViewerModel> {
  const session = await sessionLoad(input.db, request.viewerId, input.artifact);
  const access = input.artifact.ownerId === request.viewerId ? "owner" : session.access;
  const comments = await sessionCommentsPlan(input, request, session.loaded);
  return modelOf(input, access, actionsOf(session.loaded), comments);
}

async function preparePublic(input: ViewerPreparation, request: PublicRequest): Promise<ViewerModel> {
  const comments = await publicCommentsPlan(input, request);
  return modelOf(input, null, DENIED, comments);
}

export async function prepareViewer(input: ViewerPreparation): Promise<ViewerModel> {
  return input.request.kind === "public" ? preparePublic(input, input.request) : prepareSession(input, input.request);
}
