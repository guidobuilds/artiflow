import { getSession, type AuthUser } from "./auth-client.ts";

export type AdminSection = "users" | "access" | "password-policy" | "invitations";
export type AdminSectionLink = { key: AdminSection; label: string; href: string };

export const ADMIN_SECTIONS: AdminSectionLink[] = [
  { key: "users", label: "Users", href: "/admin/users" },
  { key: "access", label: "Access", href: "/admin/access" },
  { key: "password-policy", label: "Password policy", href: "/admin/password-policy" },
  { key: "invitations", label: "Invitations", href: "/admin/invitations" },
];

export type AdminGate =
  { kind: "loading" } | { kind: "refused"; message: string; signInRequired: boolean } | { kind: "ready" };

export const ADMIN_MEMBER_REFUSAL =
  "Only an administrator can open this area. This page is not available to your account.";
export const ADMIN_SIGN_IN_REFUSAL =
  "This browser has no signed-in account, so this area cannot be shown. Sign in first.";

export function administrationEntryVisible(user: AuthUser | null): boolean {
  return user !== null && user.role === "administrator";
}

export function adminSectionPath(section: AdminSection): string {
  const match = ADMIN_SECTIONS.find((entry) => entry.key === section);
  return match === undefined ? "/" : match.href;
}

export function adminSectionLabel(section: AdminSection): string {
  const match = ADMIN_SECTIONS.find((entry) => entry.key === section);
  return match === undefined ? "Administration" : match.label;
}

export async function readAdminGate(): Promise<AdminGate> {
  const session = await getSession();
  if (!session.ok) return { kind: "refused", message: session.error, signInRequired: false };
  if (session.value === null) return { kind: "refused", message: ADMIN_SIGN_IN_REFUSAL, signInRequired: true };
  if (!administrationEntryVisible(session.value))
    return { kind: "refused", message: ADMIN_MEMBER_REFUSAL, signInRequired: false };
  return { kind: "ready" };
}
