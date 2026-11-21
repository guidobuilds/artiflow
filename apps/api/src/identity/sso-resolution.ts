import type { SSOUserResolution, SSOUserResolutionInput } from "@better-auth/sso";
import { and, eq } from "drizzle-orm";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { account, user } from "../adapters/postgres/db/schema.ts";
import { SSO_CONNECTION_PROVIDER_ID } from "../settings/sso-connection.ts";
import { isActiveAccount } from "./account-status.ts";

export const SSO_ACCOUNT_UNKNOWN = "sso_account_unknown";
export const SSO_ACCOUNT_DEACTIVATED = "sso_account_deactivated";
export const SSO_EMAIL_UNVERIFIED = "sso_email_unverified";
export const SSO_IDENTITY_CONFLICT = "sso_identity_conflict";

export const SSO_ACCOUNT_UNKNOWN_MESSAGE =
  "No account on this instance signs in with that address. Ask the administrator to create one.";
export const SSO_ACCOUNT_DEACTIVATED_MESSAGE =
  "This account is deactivated. Ask the administrator to reactivate it.";
export const SSO_EMAIL_UNVERIFIED_MESSAGE =
  "The identity provider did not confirm the email address. Ask the administrator for access.";
export const SSO_IDENTITY_CONFLICT_MESSAGE =
  "This account is linked to a different enterprise identity. Ask the administrator for access.";

export type SsoUserResolver = (subject: SSOUserResolutionInput) => Promise<SSOUserResolution>;

function reject(code: string, message: string): SSOUserResolution {
  return { action: "reject", code, message };
}

function confirmedEmail(subject: SSOUserResolutionInput): boolean {
  if (subject.protocol !== "oidc") return subject.providerUser.emailVerified === true;
  const claim = subject.verifiedIdTokenClaims.email_verified;
  return claim === true || claim === "true";
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export function createSsoUserResolver(input: {
  db: AppDb | AppTx;
  allowedDomains: readonly string[];
}): SsoUserResolver {
  const { db, allowedDomains } = input;
  return async (subject) => {
    const email = subject.providerUser.email.trim().toLowerCase();
    if (email === "") return reject(SSO_ACCOUNT_UNKNOWN, SSO_ACCOUNT_UNKNOWN_MESSAGE);

    const rows = await db
      .select({ id: user.id, status: user.status })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    const found = rows[0];
    if (found === undefined) return reject(SSO_ACCOUNT_UNKNOWN, SSO_ACCOUNT_UNKNOWN_MESSAGE);
    if (!isActiveAccount(found.status)) return reject(SSO_ACCOUNT_DEACTIVATED, SSO_ACCOUNT_DEACTIVATED_MESSAGE);

    const linked = await db
      .select({ accountId: account.accountId })
      .from(account)
      .where(and(eq(account.userId, found.id), eq(account.providerId, SSO_CONNECTION_PROVIDER_ID)));
    if (linked.some((row) => row.accountId !== subject.accountKey.accountId)) {
      return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
    }

    const domain = domainOf(email);
    const trusted = confirmedEmail(subject) || (domain !== "" && allowedDomains.includes(domain));
    if (!trusted) return reject(SSO_EMAIL_UNVERIFIED, SSO_EMAIL_UNVERIFIED_MESSAGE);

    return { action: "link", userId: found.id, profile: "preserve" };
  };
}
