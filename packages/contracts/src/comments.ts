import { z } from "zod";

export const commentAnchorSchema = z
  .object({
    startLine: z.number().int().min(1),
    startCol: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endCol: z.number().int().min(1),
  })
  .refine(({ startLine, endLine }) => endLine >= startLine, { message: "endLine < startLine" });
export type CommentAnchorWire = z.infer<typeof commentAnchorSchema>;

export const commentEntrySchema = z.object({
  id: z.string().min(1),
  authorId: z.string(),
  author: z.object({ email: z.string().nullable() }),
  anchor: commentAnchorSchema,
  quotedText: z.string(),
  body: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  canDelete: z.boolean(),
});
export type CommentEntryWire = z.infer<typeof commentEntrySchema>;

export const commentThreadSchema = commentEntrySchema.extend({ replies: z.array(commentEntrySchema) });
export type CommentThreadWire = z.infer<typeof commentThreadSchema>;

export const commentListResponseSchema = z.object({
  canComment: z.boolean(),
  comments: z.array(commentThreadSchema),
});
export type CommentListResponse = z.infer<typeof commentListResponseSchema>;

export const createCommentRequestSchema = z.object({
  anchor: commentAnchorSchema,
  quotedText: z.string(),
  body: z.string(),
  parentId: z.string().optional(),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

export const commentMutationResponseSchema = z.object({ id: z.string().min(1) });
export type CommentMutationResponse = z.infer<typeof commentMutationResponseSchema>;
