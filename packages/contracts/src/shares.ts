import { z } from "zod";

import { commentThreadSchema } from "./comments.ts";

export const shareGrantSchema = z.object({
  id: z.string().min(1),
  sharedWithUserId: z.string().optional(),
  sharedWith: z.object({ email: z.string() }),
  createdAt: z.string(),
});
export type ShareGrant = z.infer<typeof shareGrantSchema>;

export const shareListResponseSchema = z.object({ shares: z.array(shareGrantSchema) });
export type ShareListResponse = z.infer<typeof shareListResponseSchema>;

export const createShareRequestSchema = z.object({ email: z.string() });
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

export const linkRowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  showComments: z.boolean().optional(),
});
export type LinkRow = z.infer<typeof linkRowSchema>;

export const linkListResponseSchema = z.object({ links: z.array(linkRowSchema) });
export type LinkListResponse = z.infer<typeof linkListResponseSchema>;

export const linkRevealSchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  token: z.string(),
  showComments: z.boolean().optional(),
});
export type LinkReveal = z.infer<typeof linkRevealSchema>;

export const linkCommentsResponseSchema = z.object({ comments: z.array(commentThreadSchema) });
export type LinkCommentsResponse = z.infer<typeof linkCommentsResponseSchema>;
