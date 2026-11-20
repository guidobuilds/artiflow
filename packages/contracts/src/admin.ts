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
