import { z } from "zod";

export const sceneEnvelopeSchema = z.object({
  formatVersion: z.number().int().positive(),
  frames: z.array(z.record(z.string(), z.unknown())),
});
export type SceneEnvelope = z.infer<typeof sceneEnvelopeSchema>;

export const sceneDraftResponseSchema = z.object({
  kind: z.literal("canvas"),
  artifactId: z.string(),
  seq: z.number().int().nonnegative(),
  publishedSeq: z.number().int().nonnegative(),
  revisionId: z.string().min(1),
  scene: sceneEnvelopeSchema,
});
export type SceneDraftResponse = z.infer<typeof sceneDraftResponseSchema>;

export const saveSceneRequestSchema = z.object({
  scene: z.record(z.string(), z.unknown()),
  expectedSeq: z.number().int().nonnegative().optional(),
});
export type SaveSceneRequest = z.infer<typeof saveSceneRequestSchema>;

export const savedSceneSchema = z.object({
  artifactId: z.string(),
  seq: z.number().int().nonnegative(),
  publishedSeq: z.number().int().nonnegative(),
  frozen: z.boolean(),
  applied: z.number().int().nonnegative(),
  revisionId: z.string().min(1),
});
export type SavedScene = z.infer<typeof savedSceneSchema>;
