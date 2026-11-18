import { z } from "zod";

export const MAX_COMMENT_BODY = 4000;
export const MAX_COMMENT_QUOTE = 2000;
export const MAX_ELEMENT_TEXT_HINT = 120;
export const MAX_ELEMENT_SELECTOR = 512;

export const COMMENT_ANCHOR_KINDS = ["text-range", "element", "page-point", "board-point", "slide-point"] as const;
export type CommentAnchorKind = (typeof COMMENT_ANCHOR_KINDS)[number];

const ratio = z.number().min(0).max(1);
const viewportWidth = z.number().int().min(1).max(1_000_000);
const at = z.object({ x: ratio, y: ratio });
const planePoint = z.object({ x: z.number(), y: z.number() });

export const textRangeAnchorSchema = z
  .object({
    kind: z.literal("text-range"),
    startLine: z.number().int().min(1),
    startCol: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endCol: z.number().int().min(1),
    quotedText: z.string().min(1).max(MAX_COMMENT_QUOTE),
  })
  .refine(({ startLine, endLine }) => endLine >= startLine, { message: "endLine < startLine" });
export type TextRangeAnchorWire = z.infer<typeof textRangeAnchorSchema>;

export const elementAnchorSchema = z.object({
  kind: z.literal("element"),
  selector: z.string().min(1).max(MAX_ELEMENT_SELECTOR),
  point: at,
  textHint: z.string().max(MAX_ELEMENT_TEXT_HINT),
  viewportWidth,
});
export type ElementAnchorWire = z.infer<typeof elementAnchorSchema>;

export const pagePointAnchorSchema = z.object({
  kind: z.literal("page-point"),
  x: ratio,
  y: z.number().min(0),
  viewportWidth,
});
export type PagePointAnchorWire = z.infer<typeof pagePointAnchorSchema>;

export const boardPointAnchorSchema = z.object({
  kind: z.literal("board-point"),
  boardId: z.string().min(1),
  x: planePoint.shape.x,
  y: planePoint.shape.y,
});
export type BoardPointAnchorWire = z.infer<typeof boardPointAnchorSchema>;

export const slidePointAnchorSchema = z.object({
  kind: z.literal("slide-point"),
  slideId: z.string().min(1),
  x: planePoint.shape.x,
  y: planePoint.shape.y,
});
export type SlidePointAnchorWire = z.infer<typeof slidePointAnchorSchema>;

export const commentAnchorSchema = z.discriminatedUnion("kind", [
  textRangeAnchorSchema,
  elementAnchorSchema,
  pagePointAnchorSchema,
  boardPointAnchorSchema,
  slidePointAnchorSchema,
]);
export type CommentAnchorWire = z.infer<typeof commentAnchorSchema>;

export const commentAuthorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  image: z.string().nullable(),
});
export type CommentAuthorWire = z.infer<typeof commentAuthorSchema>;

export const commentEntrySchema = z.object({
  id: z.string().min(1),
  authorId: z.string(),
  author: commentAuthorSchema,
  anchor: commentAnchorSchema.nullable(),
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

export const createCommentRequestSchema = z
  .object({
    anchor: commentAnchorSchema.optional(),
    body: z.string(),
    parentId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.parentId === undefined && value.anchor === undefined)
      ctx.addIssue({ code: "custom", message: "root_requires_anchor", path: ["anchor"] });
    if (value.parentId !== undefined && value.anchor !== undefined)
      ctx.addIssue({ code: "custom", message: "reply_has_no_anchor", path: ["anchor"] });
  });
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

export const commentMutationResponseSchema = z.object({ id: z.string().min(1) });
export type CommentMutationResponse = z.infer<typeof commentMutationResponseSchema>;
