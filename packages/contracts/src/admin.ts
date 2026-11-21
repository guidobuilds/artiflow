import { z } from "zod";

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

export const accessConfigurationSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  passwordEnabled: z.boolean(),
  providers: z.strictObject({
    google: accessProviderViewSchema,
    github: accessProviderViewSchema,
  }),
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

export const updateAccessConfigurationRequestSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  passwordEnabled: z.boolean(),
  providers: z.strictObject({
    google: accessProviderChangeSchema,
    github: accessProviderChangeSchema,
  }),
});
export type UpdateAccessConfigurationRequest = z.infer<typeof updateAccessConfigurationRequestSchema>;
