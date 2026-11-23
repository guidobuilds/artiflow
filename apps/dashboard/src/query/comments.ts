import { keepPreviousData, queryOptions, type QueryClient } from "@tanstack/react-query";

import type { ManageResult } from "../auth-client.ts";
import { listComments, type CommentList } from "../comments-api.ts";
import { queryKeys } from "./keys.ts";

export const commentsQuery = (artifactId: string, revisionId: string) =>
  queryOptions({
    queryKey: queryKeys.comments(artifactId, revisionId),
    queryFn: () => listComments(artifactId),
    placeholderData: keepPreviousData,
  });

export function invalidateComments(client: QueryClient, artifactId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.comments(artifactId) });
}

export type CommentStatus = "loading" | "ready" | "empty" | "error";

export function commentStatus(result: ManageResult<CommentList> | undefined): CommentStatus {
  if (result === undefined) return "loading";
  if (!result.ok) return "error";
  return result.value.comments.length === 0 ? "empty" : "ready";
}
