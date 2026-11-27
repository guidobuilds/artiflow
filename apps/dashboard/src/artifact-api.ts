import { manageRequest, type ManageResult } from "./auth-client.ts";

export type RenameOutcome = { readonly title: string };

const RENAME_MESSAGES: Record<string, string> = {
  title_required: "Enter a title to save.",
  title_too_long: "That title is too long. Shorten it, then save again.",
  not_found: "Only the owner can rename this artifact, and only while it exists.",
  origin_not_allowed: "This page was not opened from the app's own address, so the rename was refused.",
  json_content_type_required: "The rename was refused because the request was not a JSON one.",
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const titleOf = (body: unknown): RenameOutcome | null =>
  record(body) && typeof body.title === "string" && body.title !== "" ? { title: body.title } : null;

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
