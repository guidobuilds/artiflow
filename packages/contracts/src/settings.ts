import { z } from "zod";

export const accessProviderFields = {
  enabled: z.boolean(),
  clientId: z.string(),
  secretName: z.string(),
} as const;

export const accessProviderSchema = z.strictObject(accessProviderFields);
export const accessProviderReadSchema = z.object(accessProviderFields);
export type AccessProviderDocument = z.infer<typeof accessProviderSchema>;

export const accessProvenanceFields = {
  source: z.string().min(1),
  at: z.iso.datetime(),
} as const;

export const accessProvenanceSchema = z.strictObject(accessProvenanceFields);
export const accessProvenanceReadSchema = z.object(accessProvenanceFields);
export type AccessProvenance = z.infer<typeof accessProvenanceSchema>;

export const passwordAccessFields = { enabled: z.boolean() } as const;

export const accessMethodsDocumentSchema = z.strictObject({
  password: z.strictObject(passwordAccessFields),
  providers: z.strictObject({
    google: accessProviderSchema,
    github: accessProviderSchema,
  }),
  provenance: accessProvenanceSchema,
});
export const accessMethodsDocumentReadSchema = z.object({
  password: z.object(passwordAccessFields),
  providers: z.object({
    google: accessProviderReadSchema,
    github: accessProviderReadSchema,
  }),
  provenance: accessProvenanceReadSchema,
});
export type AccessMethodsDocument = z.infer<typeof accessMethodsDocumentSchema>;

export const sessionPolicyFields = {
  expiresInDays: z.number().int().min(1),
  updateAgeDays: z.number().int().min(1),
} as const;

export const sessionPolicyDocumentSchema = z.strictObject(sessionPolicyFields);
export const sessionPolicyDocumentReadSchema = z.object(sessionPolicyFields);
export type SessionPolicyDocument = z.infer<typeof sessionPolicyDocumentSchema>;
