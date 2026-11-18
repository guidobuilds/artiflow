import { anchorIsStale } from "@artiflow/domain/comment-anchors";

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
  canDelete: boolean;
  canResolve: boolean;
};

export type ViewerCommentThread = ViewerComment & { replies: ViewerComment[] };

export type ViewerCommentsConfig = {
  artifactId: string;
  canComment: boolean;
  canResolve: boolean;
  threads: ViewerCommentThread[];
  endpoints: { comments: string; resolve: string; deleteComment: string };
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

const textRange = (anchor: unknown): { startLine: number; startCol: number; endLine: number; endCol: number; quotedText: string } | null => {
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
  for (let line = 1; line < anchor.startLine && line <= lines.length; line++) offset += (lines[line - 1]?.length ?? 0) + 1;
  return offset + anchor.startCol - 1;
};

const mapRow = (source: string, row: Row, viewerId: string, role: { comment: boolean; resolve: boolean }): ViewerComment => {
  const anchor = textRange(row.anchor);
  const offset = anchor === null ? 0 : sourceOffset(source, anchor);
  return {
    id: row.id,
    author: { id: row.authorId, name: row.authorName ?? "", image: row.authorImage ?? null },
    quotedText: anchor?.quotedText ?? "",
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    stale: anchor === null ? false : anchorIsStale(source, anchor, anchor.quotedText),
    occurrence: anchor === null ? 0 : occurrencesBefore(source, anchor.quotedText, offset),
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
  endpoints: ViewerCommentsConfig["endpoints"];
}): ViewerCommentsConfig {
  const role = { comment: input.canComment, resolve: input.canComment };
  const owned = (row: Row): boolean => input.canDeleteOwn && row.authorId === input.viewerId;
  const roots = input.rows
    .filter((row) => row.parentId === null)
    .map((row) => ({
      ...mapRow(input.source, row, input.viewerId ?? "", role),
      canDelete: row.canDelete === true || owned(row),
      replies: input.rows
        .filter((reply) => reply.parentId === row.id)
        .map((reply) => ({
          ...mapRow(input.source, reply, input.viewerId ?? "", role),
          canDelete: reply.canDelete === true || owned(reply),
        })),
    }));
  return {
    artifactId: input.artifactId,
    canComment: input.canComment,
    canResolve: role.resolve,
    threads: roots,
    endpoints: input.endpoints,
  };
}
