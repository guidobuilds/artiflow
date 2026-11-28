import { z } from "zod";

export const ARTIFACT_TITLE_LIMIT = 200;

export type TitleProblem = "empty" | "too_long";

export function titleProblem(title: string): TitleProblem | null {
  const value = title.trim();
  if (value.length === 0) return "empty";
  return value.length > ARTIFACT_TITLE_LIMIT ? "too_long" : null;
}

export const artifactKindSchema = z.enum(["html", "markdown", "canvas", "deck", "unknown"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  kind: artifactKindSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  observedSizeBytes: z.number().nullable(),
  revisionCount: z.number(),
  currentRevisionId: z.string().nullable(),
  sha256: z.string().nullable(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactListResponseSchema = z.object({ artifacts: z.array(artifactSummarySchema) });
export type ArtifactListResponse = z.infer<typeof artifactListResponseSchema>;

export const sharedBySchema = z.object({ email: z.string() });
export const sharedArtifactSummarySchema = artifactSummarySchema.extend({ sharedBy: sharedBySchema });
export type SharedArtifactSummary = z.infer<typeof sharedArtifactSummarySchema>;

export const sharedArtifactListResponseSchema = z.object({ artifacts: z.array(sharedArtifactSummarySchema) });
export type SharedArtifactListResponse = z.infer<typeof sharedArtifactListResponseSchema>;

export const artifactRevisionRefSchema = z.object({
  id: z.string(),
  revisionNumber: z.number(),
  sha256: z.string(),
  sizeBytes: z.number(),
});
export const artifactDetailSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: artifactKindSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  observedSizeBytes: z.number().nullable(),
  revision: artifactRevisionRefSchema.nullable(),
});
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

export const artifactMetadataSchema = z.object({
  artifactId: z.string().min(1),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  kind: artifactKindSchema,
  sha256: z.string(),
  sizeBytes: z.number().int(),
  title: z.string().nullable().optional(),
});
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;

export const okResponseSchema = z.object({ ok: z.boolean() });
export type OkResponse = z.infer<typeof okResponseSchema>;

export const v1ArtifactBytesResponseSchema = z.object({
  artifactId: z.string().min(1),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  kind: artifactKindSchema,
  sha256: z.string(),
  sizeBytes: z.number().int(),
  contentBase64: z.string(),
});
export type V1ArtifactBytesResponse = z.infer<typeof v1ArtifactBytesResponseSchema>;

export const createArtifactRequestSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(["html", "markdown"]).optional(),
  title: z.string().min(1).max(ARTIFACT_TITLE_LIMIT).optional(),
});
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;

export const createArtifactResponseSchema = z.object({
  artifactId: z.string().min(1),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  sizeBytes: z.number().int(),
  observedSizeBytes: z.number().int(),
  sha256: z.string(),
});
export type CreateArtifactResponse = z.infer<typeof createArtifactResponseSchema>;

export const v1ArtifactUpdateRequestSchema = z.object({
  text: z.string().min(1),
  kind: z.literal("html"),
  expectedRevisionId: z.string().min(1),
  title: z.string().min(1).max(ARTIFACT_TITLE_LIMIT).optional(),
});
export type V1ArtifactUpdateRequest = z.infer<typeof v1ArtifactUpdateRequestSchema>;

export const v1ArtifactUpdateResponseSchema = createArtifactResponseSchema;
export type V1ArtifactUpdateResponse = CreateArtifactResponse;

export const artifactMetadataUpdateResponseSchema = z.object({
  artifactId: z.string().min(1),
  title: z.string().min(1),
  currentRevisionId: z.string().nullable(),
  revisionCount: z.number().int().nonnegative(),
});
export type ArtifactMetadataUpdateResponse = z.infer<typeof artifactMetadataUpdateResponseSchema>;

export const ARTIFACT_TOOL_NAMES = [
  "artifact_start_upload",
  "artifact_put_chunk",
  "artifact_commit",
  "artifact_write",
  "artifact_get",
  "artifact_resolve_link",
  "artifact_update_metadata",
  "artifact_get_markdown",
  "artifact_get_scene",
  "artifact_edit_lines",
  "artifact_list_comments",
  "artifact_add_comment",
  "artifact_reply_comment",
  "artifact_resolve_comment",
  "artifact_unresolve_comment",
  "document_create",
  "document_outline",
  "document_read",
  "document_query",
  "document_diff",
  "document_apply",
  "document_publish",
  "scene_outline",
  "scene_read",
  "scene_apply",
  "asset_upload",
] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];

export const DOCUMENT_TOOL_NAMES = [
  "document_create",
  "document_outline",
  "document_read",
  "document_query",
  "document_diff",
  "document_apply",
  "document_publish",
] as const;
export type DocumentToolName = (typeof DOCUMENT_TOOL_NAMES)[number];

export const SCENE_TOOL_NAMES = ["scene_outline", "scene_read", "scene_apply"] as const;
export type SceneToolName = (typeof SCENE_TOOL_NAMES)[number];

export const ASSET_TOOL_NAMES = ["asset_upload"] as const;
export type AssetToolName = (typeof ASSET_TOOL_NAMES)[number];
