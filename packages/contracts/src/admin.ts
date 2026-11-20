import { z } from "zod";

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

export const setUserRoleRequestSchema = z.object({ role: z.string() });
export type SetUserRoleRequest = z.infer<typeof setUserRoleRequestSchema>;

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

export const updateAccessConfigurationRequestSchema = z.strictObject({
  revision: z.number().int().min(1).nullable(),
  passwordEnabled: z.boolean(),
  providers: z.strictObject({
    google: accessProviderChangeSchema,
    github: accessProviderChangeSchema,
  }),
});
export type UpdateAccessConfigurationRequest = z.infer<typeof updateAccessConfigurationRequestSchema>;
