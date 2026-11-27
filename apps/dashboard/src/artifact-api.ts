import { ARTIFACT_TITLE_LIMIT, titleProblem } from "@artiflow/contracts/artifacts";

import { manageRequest, type ManageResult } from "./auth-client.ts";

export type RenameOutcome = { readonly title: string };
export type RenameState = "ready" | "empty" | "unchanged" | "too_long";

const NOTICE: Record<RenameState, string | null> = {
  ready: null,
  unchanged: null,
  empty: "Enter a title to save.",
  too_long: `Titles are limited to ${ARTIFACT_TITLE_LIMIT} characters.`,
};

const RENAME_MESSAGES: Record<string, string> = {
  title_required: NOTICE.empty ?? "",
  title_too_long: `That title is too long. ${NOTICE.too_long ?? ""}`,
  not_found: "This artifact cannot be renamed: it is either not yours or no longer available.",
  origin_not_allowed: "This page was not opened from the app's own address, so the rename was refused.",
  json_content_type_required: "The rename was refused because the request was not a JSON one.",
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const titleOf = (body: unknown): RenameOutcome | null =>
  record(body) && typeof body.title === "string" && body.title !== "" ? { title: body.title } : null;

export function renameState(current: string | null, next: string): RenameState {
  const problem = titleProblem(next);
  if (problem !== null) return problem;
  return next.trim() === (current ?? "").trim() ? "unchanged" : "ready";
}

export function renameNotice(state: RenameState): string | null {
  return NOTICE[state];
}

export function renameMessage(code: string): string | undefined {
  return RENAME_MESSAGES[code];
}

export async function renameArtifact(artifactId: string, title: string): Promise<ManageResult<RenameOutcome>> {
  const result = await manageRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/metadata`, "PATCH", titleOf, {
    title,
  });
  if (result.ok) return result;
  const message = renameMessage(result.code);
  return message === undefined ? result : { ...result, error: message };
}
