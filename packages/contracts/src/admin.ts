import { z } from "zod";

import { accountSessionSchema, revokedSessionSchema } from "./account.ts";
import { passwordPolicyDocumentSchema } from "./settings.ts";

export const userRoleSchema = z.enum(["member", "administrator"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const administratorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
});
export type Administrator = z.infer<typeof administratorSchema>;

export const administratorListResponseSchema = z.object({ administrators: z.array(administratorSchema) });
export type AdministratorListResponse = z.infer<typeof administratorListResponseSchema>;

export const accountStatusSchema = z.enum(["active", "deactivated"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const adminUserAccessMethodSchema = z.enum(["credential", "google", "github", "artiflow"]);
export type AdminUserAccessMethod = z.infer<typeof adminUserAccessMethodSchema>;

export const adminUserSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
  status: accountStatusSchema,
  accessMethods: z.array(z.string().min(1)),
  lastActivityAt: z.iso.datetime().nullable(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListResponseSchema = z.strictObject({
  users: z.array(adminUserSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

export const updateAdminUserRequestSchema = z.strictObject({
  name: z.string(),
  email: z.string(),
});
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;

export const updateAdminUserResponseSchema = z.strictObject({ user: adminUserSchema });
export type UpdateAdminUserResponse = z.infer<typeof updateAdminUserResponseSchema>;

export const setUserRoleRequestSchema = z.object({ role: z.string() });
export type SetUserRoleRequest = z.infer<typeof setUserRoleRequestSchema>;

export const setUserStatusRequestSchema = z.strictObject({ status: accountStatusSchema });
export type SetUserStatusRequest = z.infer<typeof setUserStatusRequestSchema>;

export const setUserStatusResponseSchema = z.strictObject({
  user: z.strictObject({ id: z.string().min(1), status: accountStatusSchema }),
});
export type SetUserStatusResponse = z.infer<typeof setUserStatusResponseSchema>;

export const setUserRoleResponseSchema = z.object({
  user: z.object({ id: z.string().min(1), role: userRoleSchema }),
  changed: z.boolean(),
});
export type SetUserRoleResponse = z.infer<typeof setUserRoleResponseSchema>;

export const accessProviderNameSchema = z.enum(["google", "github"]);
export type AccessProviderName = z.infer<typeof accessProviderNameSchema>;

export const accessProviderViewSchema = z.strictObject({
  enabled: z.boolean(),
  clientId: z.string(),
  credentialConfigured: z.boolean(),
});
export type AccessProviderView = z.infer<typeof accessProviderViewSchema>;

export const accessProviderRegistrationSchema = z.strictObject({
  origin: z.string().min(1),
  redirectUris: z.strictObject({
    google: z.string().min(1),
    github: z.string().min(1),
  }),
});
export type AccessProviderRegistration = z.infer<typeof accessProviderRegistrationSchema>;

export const accessConfigurationSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  passwordEnabled: z.boolean(),
  providers: z.strictObject({
    google: accessProviderViewSchema,
    github: accessProviderViewSchema,
  }),
  registration: accessProviderRegistrationSchema,
  provenance: z.strictObject({
    source: z.string().min(1),
    at: z.iso.datetime(),
  }),
});
export type AccessConfiguration = z.infer<typeof accessConfigurationSchema>;

export const accessProviderChangeSchema = z.strictObject({
  enabled: z.boolean(),
  clientId: z.string(),
  clientSecret: z.string().min(1).optional(),
});
export type AccessProviderChange = z.infer<typeof accessProviderChangeSchema>;

export const passwordPolicyConfigurationSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  policy: passwordPolicyDocumentSchema,
});
export type PasswordPolicyConfiguration = z.infer<typeof passwordPolicyConfigurationSchema>;

export const updatePasswordPolicyRequestSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  policy: passwordPolicyDocumentSchema,
});
export type UpdatePasswordPolicyRequest = z.infer<typeof updatePasswordPolicyRequestSchema>;

export const ssoConnectionViewSchema = z.strictObject({
  enabled: z.boolean(),
  displayName: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  credentialConfigured: z.boolean(),
  scopes: z.array(z.string()),
  jitProvisioning: z.boolean(),
  allowedDomains: z.array(z.string()),
  acceptAnyAccount: z.boolean(),
  acceptAnyAccountWarning: z.string().min(1),
});
export type SsoConnectionView = z.infer<typeof ssoConnectionViewSchema>;

export const ssoConnectionConfigurationSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  connection: ssoConnectionViewSchema,
  redirectUri: z.string().min(1),
  readiness: z.strictObject({ signInAvailable: z.boolean() }),
  provenance: z
    .strictObject({
      source: z.string().min(1),
      at: z.iso.datetime(),
    })
    .nullable(),
});
export type SsoConnectionConfiguration = z.infer<typeof ssoConnectionConfigurationSchema>;

export const updateSsoConnectionRequestSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  enabled: z.boolean(),
  displayName: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  clientSecret: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)),
  jitProvisioning: z.boolean(),
  allowedDomains: z.array(z.string()),
  acceptAnyAccount: z.boolean(),
});
export type UpdateSsoConnectionRequest = z.infer<typeof updateSsoConnectionRequestSchema>;

export const updateAccessConfigurationRequestSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  passwordEnabled: z.boolean(),
  providers: z.strictObject({
    google: accessProviderChangeSchema,
    github: accessProviderChangeSchema,
  }),
});
export type UpdateAccessConfigurationRequest = z.infer<typeof updateAccessConfigurationRequestSchema>;

export const invitationIssuerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
});
export type InvitationIssuer = z.infer<typeof invitationIssuerSchema>;

export const adminInvitationSchema = z.strictObject({
  id: z.string().min(1),
  email: z.string(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  issuedBy: invitationIssuerSchema.nullable(),
});
export type AdminInvitation = z.infer<typeof adminInvitationSchema>;

export const adminInvitationListResponseSchema = z.strictObject({
  invitations: z.array(adminInvitationSchema),
});
export type AdminInvitationListResponse = z.infer<typeof adminInvitationListResponseSchema>;

export const createAdminInvitationRequestSchema = z.strictObject({ email: z.string() });
export type CreateAdminInvitationRequest = z.infer<typeof createAdminInvitationRequestSchema>;

export const createAdminInvitationResponseSchema = z.strictObject({
  invitation: adminInvitationSchema,
  link: z.string().min(1),
  reactivated: z.boolean(),
});
export type CreateAdminInvitationResponse = z.infer<typeof createAdminInvitationResponseSchema>;

export const regenerateAdminInvitationResponseSchema = z.strictObject({
  invitation: adminInvitationSchema,
  link: z.string().min(1),
});
export type RegenerateAdminInvitationResponse = z.infer<typeof regenerateAdminInvitationResponseSchema>;

export const revokeAdminInvitationResponseSchema = z.strictObject({
  invitation: z.strictObject({ id: z.string().min(1), revokedAt: z.iso.datetime() }),
});
export type RevokeAdminInvitationResponse = z.infer<typeof revokeAdminInvitationResponseSchema>;

export const issueAdminResetLinkRequestSchema = z.strictObject({ email: z.string() });
export type IssueAdminResetLinkRequest = z.infer<typeof issueAdminResetLinkRequestSchema>;

export const issueAdminResetLinkResponseSchema = z.strictObject({
  link: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
export type IssueAdminResetLinkResponse = z.infer<typeof issueAdminResetLinkResponseSchema>;

export const adminSessionSchema = accountSessionSchema;
export type AdminSession = z.infer<typeof adminSessionSchema>;

export const adminSessionListResponseSchema = z.strictObject({
  sessions: z.array(adminSessionSchema),
});
export type AdminSessionListResponse = z.infer<typeof adminSessionListResponseSchema>;

export const revokeAdminSessionResponseSchema = z.strictObject({ session: revokedSessionSchema });
export type RevokeAdminSessionResponse = z.infer<typeof revokeAdminSessionResponseSchema>;

export const revokeAdminSessionsResponseSchema = z.strictObject({
  revoked: z.number().int().min(0),
});
export type RevokeAdminSessionsResponse = z.infer<typeof revokeAdminSessionsResponseSchema>;
