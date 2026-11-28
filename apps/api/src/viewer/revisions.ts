import type { RevisionSummary } from "../domain/revisions.ts";
import { editsDocumentInApp, rendersScene } from "@artiflow/domain/kinds";

import type { ViewerBanner, ViewerBannerLink, ViewerVersion, ViewerVersions } from "./model.ts";

export const VERSIONS_SHOWN = 25;

export const revisionHref = (artifactId: string, revisionId: string): string =>
  `/artifact/${encodeURIComponent(artifactId)}?revision=${encodeURIComponent(revisionId)}`;

export const compareHref = (input: {
  artifactId: string;
  from: string;
  to: string;
  frameId?: string | null;
}): string => {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  if (input.frameId !== undefined && input.frameId !== null && input.frameId !== "") query.set("frame", input.frameId);
  return `/artifact/${encodeURIComponent(input.artifactId)}/compare?${query.toString()}`;
};

export const editorHref = (artifactId: string, kind: string): string | null => {
  if (rendersScene(kind)) return `/canvas/${encodeURIComponent(artifactId)}`;
  if (editsDocumentInApp(kind)) return `/edit/${encodeURIComponent(artifactId)}`;
  return null;
};

const day = (value: Date): string => value.toISOString().slice(0, 10);

export function versionsOf(input: {
  artifactId: string;
  currentRevisionId: string | null;
  viewingRevisionId: string | null;
  rows: readonly RevisionSummary[];
  frameId: string | null;
  canRestore: boolean;
}): ViewerVersions | undefined {
  const current = input.currentRevisionId;
  if (input.rows.length === 0 || current === null) return undefined;
  const shown = input.rows.slice(0, VERSIONS_SHOWN);
  const rows: ViewerVersion[] = shown.map((row) => ({
    id: row.id,
    number: row.revisionNumber,
    publishedAt: row.createdAt.toISOString(),
    href: revisionHref(input.artifactId, row.id),
    compareHref:
      row.id === current ? null : compareHref({ artifactId: input.artifactId, from: row.id, to: current, frameId: input.frameId }),
    latest: row.id === current,
  }));
  return {
    artifactId: input.artifactId,
    rows,
    hidden: Math.max(0, input.rows.length - shown.length),
    viewingId: input.viewingRevisionId,
    canRestore: input.canRestore,
    expectedRevisionId: current,
  };
}

export function pinnedRevisionBanner(input: {
  artifactId: string;
  kind: string;
  viewing: { id: string; number: number; publishedAt: Date };
  latest: { id: string; number: number } | null;
  canEdit: boolean;
  frameId: string | null;
}): ViewerBanner {
  const links: ViewerBannerLink[] = [{ href: `/artifact/${encodeURIComponent(input.artifactId)}`, label: "View latest version" }];
  if (input.latest !== null)
    links.push({
      href: compareHref({ artifactId: input.artifactId, from: input.viewing.id, to: input.latest.id, frameId: input.frameId }),
      label: `Compare with version ${input.latest.number}`,
    });
  const editor = input.canEdit ? editorHref(input.artifactId, input.kind) : null;
  if (editor !== null) links.push({ href: editor, label: "Open the editor" });
  const latestText =
    input.latest === null ? "This is the only publication." : `The latest publication is version ${input.latest.number}.`;
  return {
    tone: "info",
    text: `You are looking at version ${input.viewing.number}, published ${day(input.viewing.publishedAt)}. ${latestText} This view never changes when someone publishes again.`,
    links,
  };
}

export function pinnedLinkBanner(input: { number: number; publishedAt: Date }): ViewerBanner {
  return {
    tone: "info",
    text: `Pinned to version ${input.number}, published ${day(input.publishedAt)}. This link keeps showing it after newer publications.`,
    links: [],
  };
}

export function draftBanner(input: {
  artifactId: string;
  kind: string;
  revisionNumber: number;
  draftSeq: number;
  publishedSeq: number;
}): ViewerBanner | undefined {
  const editor = editorHref(input.artifactId, input.kind);
  if (input.draftSeq <= input.publishedSeq || editor === null) return undefined;
  return {
    tone: "warning",
    text: `You are looking at version ${input.revisionNumber}, the last publication. The design has unpublished draft changes that this view does not show.`,
    links: [{ href: editor, label: "Continue editing the draft" }],
  };
}
