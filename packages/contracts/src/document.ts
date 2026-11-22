import { z } from "zod";

export const documentResponseSchema = z.object({
  artifactId: z.string(),
  title: z.string().nullable(),
  kind: z.literal("markdown"),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  text: z.string(),
  seq: z.number().int().nonnegative().optional(),
  publishedSeq: z.number().int().nonnegative().optional(),
});
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export const saveDocumentRequestSchema = z.object({
  text: z.string(),
  expectedRevisionId: z.string().min(1).optional(),
  expectedSeq: z.number().int().nonnegative().optional(),
});
export type SaveDocumentRequest = z.infer<typeof saveDocumentRequestSchema>;

export const restoreRevisionRequestSchema = z.object({ expectedRevisionId: z.string().min(1) });
export type RestoreRevisionRequest = z.infer<typeof restoreRevisionRequestSchema>;

export const savedRevisionSchema = z.object({
  artifactId: z.string().optional(),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  sizeBytes: z.number().optional(),
  sha256: z.string().optional(),
  restoredFrom: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  publishedSeq: z.number().int().nonnegative().optional(),
});
export type SavedRevision = z.infer<typeof savedRevisionSchema>;

export const revisionRowSchema = z.object({
  id: z.string(),
  revisionNumber: z.number().int().positive(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});
export const revisionListResponseSchema = z.object({ revisions: z.array(revisionRowSchema) });
export type RevisionListResponse = z.infer<typeof revisionListResponseSchema>;
