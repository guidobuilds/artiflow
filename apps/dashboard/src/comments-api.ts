import { manageRequest } from "./auth-client.ts";
import type { CommentAnchor, TextRangeAnchor } from "@artiflow/domain/comment-anchors";
export type CommentAuthor = { id: string; name: string; image: string | null };
export type CommentEntry = {
  id: string;
  authorId: string;
  author: CommentAuthor;
  anchor: CommentAnchor | null;
  quotedText: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  canDelete: boolean;
};
export type CommentThread = CommentEntry & { anchor: CommentAnchor; replies: CommentEntry[] };
export type CommentList = { canComment: boolean; comments: CommentThread[] };
export type NewComment =
  { anchor: TextRangeAnchor; body: string; expectedRevisionId: string } | { body: string; parentId: string };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const textRange = (value: unknown): TextRangeAnchor | null => {
  if (!record(value) || value.kind !== "text-range") return null;
  const { startLine, startCol, endLine, endCol } = value;
  if (!positive(startLine) || !positive(startCol) || !positive(endLine) || !positive(endCol) || endLine < startLine)
    return null;
  if (typeof value.quotedText !== "string" || !value.quotedText) return null;
  return { kind: "text-range", startLine, startCol, endLine, endCol, quotedText: value.quotedText };
};
function entry(value: unknown): CommentEntry | null {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.authorId !== "string" ||
    !record(value.author) ||
    typeof value.author.id !== "string" ||
    typeof value.author.name !== "string" ||
    (value.author.image !== null && typeof value.author.image !== "string")
  )
    return null;
  const anchor = textRange(value.anchor);
  if (
    typeof value.body !== "string" ||
    (value.resolvedAt !== null && typeof value.resolvedAt !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.canDelete !== "boolean"
  )
    return null;
  return {
    id: value.id,
    authorId: value.authorId,
    author: { id: value.author.id, name: value.author.name, image: value.author.image },
    anchor,
    quotedText: anchor?.quotedText ?? "",
    body: value.body,
    resolvedAt: value.resolvedAt,
    createdAt: value.createdAt,
    canDelete: value.canDelete,
  };
}
export function parseComments(value: unknown): CommentList | null {
  if (!record(value) || typeof value.canComment !== "boolean" || !Array.isArray(value.comments)) return null;
  const comments = value.comments.map((row): CommentThread | null => {
    const root = entry(row);
    if (!root?.anchor || !record(row) || !Array.isArray(row.replies)) return null;
    const replies = row.replies.map(entry);
    return replies.every((reply) => reply !== null) ? { ...root, anchor: root.anchor, replies } : null;
  });
  return comments.every((row) => row !== null) ? { canComment: value.canComment, comments } : null;
}
const path = (id: string) => `/api/artifacts/${encodeURIComponent(id)}/comments`;
const confirmed = (value: unknown): string | null =>
  record(value) && typeof value.id === "string" && value.id !== "" ? value.id : null;
export const listComments = (id: string) => manageRequest(path(id), "GET", parseComments);
export const createComment = (id: string, body: NewComment) => manageRequest(path(id), "POST", confirmed, body);
export const resolveComment = (id: string, commentId: string, resolve: boolean) =>
  manageRequest(`${path(id)}/${encodeURIComponent(commentId)}/${resolve ? "resolve" : "unresolve"}`, "POST", confirmed);
export const deleteComment = (id: string, commentId: string) =>
  manageRequest(`${path(id)}/${encodeURIComponent(commentId)}`, "DELETE", confirmed);
