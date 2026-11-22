import { z } from "zod";

export const accountSessionSchema = z.strictObject({
  id: z.string().min(1),
  startedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type AccountSession = z.infer<typeof accountSessionSchema>;

export const accountSessionListResponseSchema = z.strictObject({
  sessions: z.array(accountSessionSchema),
});
export type AccountSessionListResponse = z.infer<typeof accountSessionListResponseSchema>;

export const revokedSessionSchema = z.strictObject({ id: z.string().min(1) });
export type RevokedSession = z.infer<typeof revokedSessionSchema>;

export const revokeAccountSessionResponseSchema = z.strictObject({ session: revokedSessionSchema });
export type RevokeAccountSessionResponse = z.infer<typeof revokeAccountSessionResponseSchema>;

export const revokeOtherAccountSessionsResponseSchema = z.strictObject({
  revoked: z.number().int().min(0),
});
export type RevokeOtherAccountSessionsResponse = z.infer<typeof revokeOtherAccountSessionsResponseSchema>;
