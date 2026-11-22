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

export const passwordPolicyFields = {
  minLength: z.number().int().min(8).max(128),
  requireUppercase: z.boolean(),
  requireLowercase: z.boolean(),
  requireNumber: z.boolean(),
  requireSymbol: z.boolean(),
} as const;

export const passwordPolicyDocumentSchema = z.strictObject(passwordPolicyFields);
export const passwordPolicyDocumentReadSchema = z.object(passwordPolicyFields);
export type PasswordPolicyDocument = z.infer<typeof passwordPolicyDocumentSchema>;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicyDocument = Object.freeze({
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: true,
});

export const passwordRequirementSchema = z.enum([
  "minLength",
  "maxLength",
  "uppercase",
  "lowercase",
  "number",
  "symbol",
]);
export type PasswordRequirement = z.infer<typeof passwordRequirementSchema>;

export const passwordRequirementRuleSchema = z.strictObject({
  requirement: passwordRequirementSchema,
  message: z.string().min(1),
});
export type PasswordRequirementRule = z.infer<typeof passwordRequirementRuleSchema>;

export const passwordPolicyViewSchema = z.strictObject({
  ...passwordPolicyFields,
  maxLength: z.number().int().min(1),
  requirements: z.array(passwordRequirementRuleSchema),
});
export type PasswordPolicyView = z.infer<typeof passwordPolicyViewSchema>;

export const sessionPolicyFields = {
  expiresInDays: z.number().int().min(1),
  updateAgeDays: z.number().int().min(1),
} as const;

export const sessionPolicyDocumentSchema = z.strictObject(sessionPolicyFields);
export const sessionPolicyDocumentReadSchema = z.object(sessionPolicyFields);
export type SessionPolicyDocument = z.infer<typeof sessionPolicyDocumentSchema>;

export const SSO_DEFAULT_SCOPES: readonly string[] = Object.freeze(["openid", "profile", "email"]);

export const ACCEPT_ANY_ACCOUNT_WARNING =
  "Every account the identity provider authenticates will be able to sign in, not only the allowed domains. " +
  "An account created this way is always a member, never an administrator.";

export const ssoConnectionFields = {
  enabled: z.boolean(),
  displayName: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  clientSecretName: z.string(),
  scopes: z.array(z.string()),
  jitProvisioning: z.boolean(),
  allowedDomains: z.array(z.string()),
  acceptAnyAccount: z.boolean(),
} as const;

export const ssoConnectionDocumentSchema = z.strictObject({
  ...ssoConnectionFields,
  provenance: accessProvenanceSchema,
});
export const ssoConnectionDocumentReadSchema = z.object({
  ...ssoConnectionFields,
  provenance: accessProvenanceReadSchema,
});
export type SsoConnectionDocument = z.infer<typeof ssoConnectionDocumentSchema>;
