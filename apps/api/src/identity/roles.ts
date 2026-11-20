export const USER_ROLES = ["member", "administrator"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const MEMBER_ROLE: UserRole = "member";

export const ADMINISTRATOR_ROLE: UserRole = "administrator";

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export function isAdministrator(role: string | null | undefined): boolean {
  return role === ADMINISTRATOR_ROLE;
}
