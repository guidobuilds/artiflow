import { createHash } from "node:crypto";

import { anchorIsStale, isSceneAnchor, sceneAnchorIsOrphaned } from "@artiflow/domain/comment-anchors";
import { sceneSubtree, type Scene } from "@artiflow/domain/scene";

export const bridgeNonce = (artifactId: string, sha256: string): string =>
  createHash("sha256").update(`comments:${artifactId}:${sha256}`).digest("hex").slice(0, 32);

export type ViewerCommentAuthor = { id: string; name: string; image: string | null };

export type ViewerComment = {
  id: string;
  author: ViewerCommentAuthor;
  quotedText: string;
  body: string;
  createdAt: string;
  resolvedAt: string | null;
  stale: boolean;
  occurrence: number;
  anchor?: unknown;
  orphaned?: boolean;
  canDelete: boolean;
  canResolve: boolean;
};

export type ViewerCommentThread = ViewerComment & { replies: ViewerComment[] };

export type ViewerCommentsConfig = {
  artifactId: string;
  mode: "text" | "element";
  bridgeNonce?: string;
  canComment: boolean;
  canResolve: boolean;
  threads: ViewerCommentThread[];
  endpoints: { comments: string; resolve: string; deleteComment: string; list?: string };
};

type Row = {
  id: string;
  authorId: string;
  authorName: string | null;
  authorImage: string | null;
  anchor: unknown;
  body: string;
  parentId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  canDelete?: boolean;
};

const textRange = (
  anchor: unknown,
): { startLine: number; startCol: number; endLine: number; endCol: number; quotedText: string } | null => {
  if (typeof anchor !== "object" || anchor === null) return null;
  const candidate = anchor as Record<string, unknown>;
  if (candidate.kind !== "text-range") return null;
  const numbers = [candidate.startLine, candidate.startCol, candidate.endLine, candidate.endCol];
  if (!numbers.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1)) return null;
  if (typeof candidate.quotedText !== "string" || candidate.quotedText.length === 0) return null;
  return candidate as never;
};

const occurrencesBefore = (source: string, needle: string, before: number): number => {
  if (!needle) return 0;
  let count = 0;
  for (let index = source.indexOf(needle); index >= 0 && index < before; index = source.indexOf(needle, index + 1))
    count++;
  return count;
};

const sourceOffset = (source: string, anchor: { startLine: number; startCol: number }): number => {
  const lines = source.split("\n");
  let offset = 0;
  for (let line = 1; line < anchor.startLine && line <= lines.length; line++)
    offset += (lines[line - 1]?.length ?? 0) + 1;
  return offset + anchor.startCol - 1;
};

const orphanOf = (row: Row, scene: Scene | undefined): { orphaned?: boolean } =>
  scene === undefined || !isSceneAnchor(row.anchor) ? {} : { orphaned: sceneAnchorIsOrphaned(scene, row.anchor) };

const mapRow = (
  source: string,
  row: Row,
  viewerId: string,
  role: { comment: boolean; resolve: boolean },
  mode: "text" | "element",
  scene?: Scene,
): ViewerComment => {
  const anchor = textRange(row.anchor);
  const offset = anchor === null ? 0 : sourceOffset(source, anchor);
  if (mode === "element")
    return {
      id: row.id,
      author: { id: row.authorId, name: row.authorName ?? "", image: row.authorImage ?? null },
      quotedText: "",
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      stale: false,
      occurrence: 0,
      anchor: row.anchor,
      ...orphanOf(row, scene),
      canDelete: row.canDelete === true,
      canResolve: role.resolve && row.parentId === null,
    };
  return {
    id: row.id,
    author: { id: row.authorId, name: row.authorName ?? "", image: row.authorImage ?? null },
    quotedText: anchor?.quotedText ?? "",
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    stale: anchor === null ? false : anchorIsStale(source, anchor, anchor.quotedText),
    occurrence: anchor === null ? 0 : occurrencesBefore(source, anchor.quotedText, offset),
    ...orphanOf(row, scene),
    canDelete: row.canDelete === true,
    canResolve: role.resolve && row.parentId === null,
  };
};

export function viewerCommentsConfig(input: {
  artifactId: string;
  source: string;
  rows: Row[];
  viewerId: string | null;
  canComment: boolean;
  canDeleteOwn: boolean;
  deleteAny: boolean;
  endpoints: ViewerCommentsConfig["endpoints"];
  mode?: "text" | "element";
  bridgeNonce?: string;
  scene?: Scene;
}): ViewerCommentsConfig {
  const mode = input.mode ?? "text";
  const role = { comment: input.canComment, resolve: input.canComment };
  const mayDelete = (row: Row): boolean => input.deleteAny || (input.canDeleteOwn && row.authorId === input.viewerId);
  const roots = input.rows
    .filter((row) => row.parentId === null)
    .map((row) => ({
      ...mapRow(input.source, row, input.viewerId ?? "", role, mode, input.scene),
      canDelete: row.canDelete === true || mayDelete(row),
      replies: input.rows
        .filter((reply) => reply.parentId === row.id)
        .map((reply) => ({
          ...mapRow(input.source, reply, input.viewerId ?? "", role, mode, input.scene),
          canDelete: reply.canDelete === true || mayDelete(reply),
        })),
    }));
  return {
    artifactId: input.artifactId,
    mode,
    ...(input.bridgeNonce === undefined ? {} : { bridgeNonce: input.bridgeNonce }),
    canComment: input.canComment,
    canResolve: role.resolve,
    threads: roots,
    endpoints: input.endpoints,
  };
}

export type SceneThreadPin = {
  id: string;
  number: number;
  frameId: string;
  nodeId: string;
  left: number;
  top: number;
};

export type SceneThreadOrphan = { id: string; number: number };

export type SceneThreadPlacement = { pins: SceneThreadPin[]; orphans: SceneThreadOrphan[] };

export function sceneThreadPlacement(
  scene: Scene,
  threads: readonly { id: string; anchor?: unknown }[],
): SceneThreadPlacement {
  const pins: SceneThreadPin[] = [];
  const orphans: SceneThreadOrphan[] = [];
  threads.forEach((thread, index) => {
    const anchor = isSceneAnchor(thread.anchor) ? thread.anchor : null;
    if (anchor === null) return;
    const number = index + 1;
    const frameId = anchor.kind === "board-point" ? anchor.boardId : anchor.slideId;
    const frame = sceneSubtree(scene, frameId);
    const node = frame === null ? undefined : frame.nodes.find((candidate) => candidate.id === anchor.nodeId);
    if (frame === null || node === undefined) {
      orphans.push({ id: thread.id, number });
      return;
    }
    pins.push({
      id: thread.id,
      number,
      frameId: frame.id,
      nodeId: node.id,
      left: node.x + anchor.x * node.w,
      top: node.y + anchor.y * node.h,
    });
  });
  return { pins, orphans };
}

export type BridgePin = {
  id: string;
  number: number;
  selector: string;
  textHint: string;
  x: number;
  y: number;
  stale: boolean;
  stalePixels: boolean;
};

export const bridgePins = (threads: ViewerCommentThread[]): BridgePin[] =>
  threads.flatMap((thread, index) => {
    const anchor = thread.anchor as {
      kind?: string;
      selector?: string;
      textHint?: string;
      point?: { x: number; y: number };
      x?: number;
      y?: number;
    } | null;
    if (anchor === null || typeof anchor !== "object") return [];
    if (anchor.kind === "element")
      return [
        {
          id: thread.id,
          number: index + 1,
          selector: typeof anchor.selector === "string" ? anchor.selector : "",
          textHint: typeof anchor.textHint === "string" ? anchor.textHint : "",
          x: anchor.point?.x ?? 0.5,
          y: anchor.point?.y ?? 0.5,
          stale: false as boolean,
          stalePixels: false as boolean,
        },
      ];
    if (anchor.kind === "page-point")
      return [
        {
          id: thread.id,
          number: index + 1,
          selector: "",
          textHint: "",
          x: typeof anchor.x === "number" ? anchor.x : 0.5,
          y: typeof anchor.y === "number" ? anchor.y : 0,
          stale: true as boolean,
          stalePixels: true as boolean,
        },
      ];
    return [];
  });
