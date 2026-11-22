import { getSession, type AuthUser } from "./auth-client.ts";

export type AdminSection = "users" | "invitations" | "access" | "sso" | "password-policy";
export type AdminSectionGroup = "People" | "Authentication";
export type AdminSectionLink = {
  key: AdminSection;
  label: string;
  description: string;
  group: AdminSectionGroup;
  href: string;
};

export const ADMIN_SECTIONS: AdminSectionLink[] = [
  { key: "users", label: "Users", description: "Accounts, roles and sessions", group: "People", href: "/admin/users" },
  {
    key: "invitations",
    label: "Invitations",
    description: "Pending links to join",
    group: "People",
    href: "/admin/invitations",
  },
  {
    key: "access",
    label: "Sign-in methods",
    description: "Password, Google and GitHub",
    group: "Authentication",
    href: "/admin/access",
  },
  {
    key: "sso",
    label: "Enterprise SSO",
    description: "OpenID Connect provider",
    group: "Authentication",
    href: "/admin/sso",
  },
  {
    key: "password-policy",
    label: "Password policy",
    description: "Length and character rules",
    group: "Authentication",
    href: "/admin/password-policy",
  },
];

export const ADMIN_SECTION_GROUPS: AdminSectionGroup[] = ["People", "Authentication"];

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
