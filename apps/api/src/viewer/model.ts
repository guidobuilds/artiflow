import type { Assets } from "./assets.ts";
import type { ViewerCommentsConfig, ViewerCommentThread } from "./comments-data.ts";

export type RefreshPlan = { kind: "reload"; metaUrl: string } | { kind: "none" };

export type ViewerMeta = { title: string | null; version: number | null };

export type ViewerRefresh = {
  plan: RefreshPlan;
  revisionNumber: number;
  sha256: string;
  comments?: boolean;
};

export type WrapperComments = {
  nonce: string;
  bridge: string;
  config: unknown;
  assets: Assets;
};

export const refreshPlan = (metaUrl: string): RefreshPlan =>
  metaUrl === "" ? { kind: "none" } : { kind: "reload", metaUrl };

export type ViewerAudience =
  | { readonly kind: "session"; readonly viewerId: string; readonly access: string | null }
  | { readonly kind: "bearer"; readonly viewerId: string }
  | { readonly kind: "public"; readonly showComments: boolean };

export type ViewerChrome = "full" | "anonymous" | "none";

export type ViewerActions = {
  readonly comment: boolean;
  readonly resolve: boolean;
  readonly deleteOwn: boolean;
  readonly deleteAny: boolean;
};

export type ViewerManagement = { readonly share: boolean; readonly delete: boolean; readonly rename: boolean };

export type ViewerManagementConfig = {
  readonly id: string;
  readonly title: string | null;
  readonly kind: string;
};

export type ViewerManagementPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "menu";
      readonly actions: ViewerManagement;
      readonly config: ViewerManagementConfig;
      readonly assets: Assets;
    };

export type ViewerManagementMenu = { readonly config: ViewerManagementConfig; readonly assets: Assets };

export type ViewerBannerLink = { readonly href: string; readonly label: string };

export type ViewerBanner = {
  readonly tone: "info" | "warning";
  readonly text: string;
  readonly links: readonly ViewerBannerLink[];
};

export type ViewerVersion = {
  readonly id: string;
  readonly number: number;
  readonly publishedAt: string;
  readonly href: string;
  readonly compareHref: string | null;
  readonly latest: boolean;
};

export type ViewerVersions = {
  readonly artifactId: string;
  readonly rows: readonly ViewerVersion[];
  readonly hidden: number;
  readonly viewingId: string | null;
  readonly canRestore: boolean;
  readonly expectedRevisionId: string;
};

export type ViewerRevision = { readonly id: string | null; readonly number: number; readonly sha256: string };

export type ViewerCommentBridge = { readonly nonce: string; readonly script: string };

export type ViewerCommentsPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "page";
      readonly config: ViewerCommentsConfig;
      readonly assets: Assets;
      readonly bridge: ViewerCommentBridge | null;
    }
  | { readonly kind: "document"; readonly config: ViewerCommentsConfig };

export type ViewerMarginalComments = { readonly config: ViewerCommentsConfig; readonly assets: Assets };

export type DesignRequestShellConfig = {
  readonly nonce: string;
  readonly canComment: boolean;
  readonly commentsEndpoint: string;
  readonly expectedRevisionId: string;
  readonly designId: string;
  readonly designTitle: string;
};

export type ViewerModel = {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly revision: ViewerRevision;
  readonly audience: ViewerAudience;
  readonly chrome: ViewerChrome;
  readonly backHref: string | undefined;
  readonly meta: ViewerMeta | undefined;
  readonly embed: boolean;
  readonly actions: ViewerActions;
  readonly management: ViewerManagementPlan;
  readonly comments: ViewerCommentsPlan;
  readonly refresh: ViewerRefresh;
  readonly designRequest?: DesignRequestShellConfig | undefined;
  readonly banner?: ViewerBanner | undefined;
  readonly versions?: ViewerVersions | undefined;
};

export const commentThreads = (plan: ViewerCommentsPlan): readonly ViewerCommentThread[] =>
  plan.kind === "none" ? [] : plan.config.threads;

export const commentConfig = (plan: ViewerCommentsPlan): ViewerCommentsConfig | null =>
  plan.kind === "none" ? null : plan.config;

export const marginalComments = (plan: ViewerCommentsPlan): ViewerMarginalComments | undefined =>
  plan.kind === "page" ? { config: plan.config, assets: plan.assets } : undefined;

export const bridgeComments = (plan: ViewerCommentsPlan): WrapperComments | undefined =>
  plan.kind === "page" && plan.bridge !== null
    ? { nonce: plan.bridge.nonce, bridge: plan.bridge.script, config: plan.config, assets: plan.assets }
    : undefined;

export const managementMenu = (plan: ViewerManagementPlan): ViewerManagementMenu | undefined =>
  plan.kind === "menu" && plan.assets.script !== "" ? { config: plan.config, assets: plan.assets } : undefined;
