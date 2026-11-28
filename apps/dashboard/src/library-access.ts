import { editsDocumentInApp, editsSceneInApp } from "@artiflow/domain/kinds";

export type LibraryRowAccess = {
  readonly canShare: boolean;
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly ownerLabel: string;
};

export const libraryRowAccess = (input: { kind: string; owner?: string }): LibraryRowAccess => {
  const mine = input.owner === undefined;
  return {
    canShare: mine,
    canDelete: mine,
    canEdit: mine && (editsSceneInApp(input.kind) || editsDocumentInApp(input.kind)),
    ownerLabel: input.owner ?? "You",
  };
};

export const ownArtifactOpenHref = (kind: string, id: string): string =>
  editsSceneInApp(kind) ? `/canvas/${encodeURIComponent(id)}` : `/artifact/${encodeURIComponent(id)}`;
