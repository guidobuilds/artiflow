import { z } from "zod";

export const legacyErrorSchema = z.object({ error: z.string() }).passthrough();
export type LegacyErrorBody = z.infer<typeof legacyErrorSchema>;

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  status: z.number().int(),
  requestId: z.string().min(1),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const concurrentEditDetailSchema = z.object({
  error: z.literal("concurrent_edit"),
  currentRevisionId: z.string().optional(),
  reason: z.string().optional(),
});
export const tooLargeDetailSchema = z.object({
  error: z.literal("too_large"),
  maxBytes: z.number().optional(),
});
