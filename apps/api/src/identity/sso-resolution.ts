import type { SSOUserResolution, SSOUserResolutionInput } from "@better-auth/sso";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { account, user } from "../adapters/postgres/db/schema.ts";
import { SSO_CONNECTION_PROVIDER_ID, ssoPinnedTenant } from "../settings/sso-connection.ts";
import { ACTIVE_ACCOUNT_STATUS, isActiveAccount } from "./account-status.ts";
import { MEMBER_ROLE } from "./roles.ts";

export const SSO_ACCOUNT_UNKNOWN = "sso_account_unknown";
export const SSO_ACCOUNT_DEACTIVATED = "sso_account_deactivated";
export const SSO_EMAIL_UNVERIFIED = "sso_email_unverified";
export const SSO_IDENTITY_CONFLICT = "sso_identity_conflict";
export const SSO_DOMAIN_NOT_ALLOWED = "sso_domain_not_allowed";
export const SSO_TENANT_MISMATCH = "sso_tenant_mismatch";

export const SSO_ACCOUNT_UNKNOWN_MESSAGE =
  "No account on this instance signs in with that address. Ask the administrator to create one.";
export const SSO_ACCOUNT_DEACTIVATED_MESSAGE = "This account is deactivated. Ask the administrator to reactivate it.";
export const SSO_EMAIL_UNVERIFIED_MESSAGE =
  "The identity provider did not confirm the email address. Ask the administrator for access.";
export const SSO_IDENTITY_CONFLICT_MESSAGE =
  "This account is linked to a different enterprise identity. Ask the administrator for access.";
export const SSO_DOMAIN_NOT_ALLOWED_MESSAGE =
  "This instance only creates accounts on the domains the administrator allowed. Ask the administrator to allow " +
  "that domain, or to accept any account this identity provider authenticates by turning that acceptance on.";
export const SSO_TENANT_MISMATCH_MESSAGE =
  "The identity provider answered for a tenant this connection does not pin. Ask the administrator to review the " +
  "enterprise connection.";

export type SsoUserResolver = (subject: SSOUserResolutionInput) => Promise<SSOUserResolution>;

export type SsoUserRules = {
  readonly db: AppDb | AppTx;
  readonly allowedDomains: readonly string[];
  readonly issuer: string;
  readonly jitProvisioning: boolean;
  readonly acceptAnyAccount: boolean;
};

type Db = AppDb | AppTx;

type AccountRow = { id: string; email: string; status: string };

type Claim = { readonly [key: string]: unknown };

function reject(code: string, message: string): SSOUserResolution {
  return { action: "reject", code, message };
}

function confirmedEmail(subject: SSOUserResolutionInput): boolean {
  if (subject.protocol !== "oidc") return subject.providerUser.emailVerified === true;
  const claim = subject.verifiedIdTokenClaims.email_verified;
  return claim === true || claim === "true";
}

function claimsOf(subject: SSOUserResolutionInput): Claim {
  return subject.protocol === "oidc" ? subject.verifiedIdTokenClaims : {};
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const domain = domainOf(email);
  return domain !== "" && allowedDomains.includes(domain);
}

function normalizedEmail(subject: SSOUserResolutionInput): string {
  return subject.providerUser.email.trim().toLowerCase();
}

function sameIssuer(presented: unknown, pinned: string): boolean {
  if (typeof presented !== "string") return false;
  return presented.trim().replace(/\/+$/, "") === pinned.trim().replace(/\/+$/, "");
}

function tenantRefused(subject: SSOUserResolutionInput, issuer: string): boolean {
  const claims = claimsOf(subject);
  if (subject.protocol === "oidc" && !sameIssuer(claims.iss, issuer)) return true;
  const asserted = claims.tid;
  if (asserted === undefined || asserted === null || asserted === "") return false;
  if (typeof asserted !== "string") return true;
  const pinned = ssoPinnedTenant(issuer);
  return pinned === null || pinned !== asserted.trim().toLowerCase();
}

async function userByEmail(db: Db, email: string): Promise<AccountRow | null> {
  const rows = await db
    .select({ id: user.id, email: user.email, status: user.status })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);
  return rows[0] ?? null;
}

async function identityOwnerId(db: Db, accountId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, SSO_CONNECTION_PROVIDER_ID), eq(account.accountId, accountId)))
    .limit(1);
  return rows[0]?.userId ?? null;
}

async function holdsOtherIdentity(db: Db, userId: string, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, SSO_CONNECTION_PROVIDER_ID)));
  return rows.some((row) => row.accountId !== accountId);
}

async function bindIdentity(db: Db, userId: string, accountId: string): Promise<boolean> {
  const inserted = await db
    .insert(account)
    .values({ id: randomUUID(), userId, providerId: SSO_CONNECTION_PROVIDER_ID, accountId })
    .onConflictDoNothing({ target: [account.providerId, account.accountId] })
    .returning({ userId: account.userId });
  const owner = inserted[0]?.userId ?? (await identityOwnerId(db, accountId));
  return owner === userId;
}

async function createMemberAccount(db: Db, subject: SSOUserResolutionInput, email: string): Promise<AccountRow | null> {
  const name = subject.providerUser.name.trim();
  const rows = await db
    .insert(user)
    .values({
      id: randomUUID(),
      name: name === "" ? email : name,
      email,
      emailVerified: confirmedEmail(subject),
      image: subject.providerUser.image ?? null,
      role: MEMBER_ROLE,
      status: ACTIVE_ACCOUNT_STATUS,
    })
    .onConflictDoNothing({ target: user.email })
    .returning({ id: user.id, email: user.email, status: user.status });
  return rows[0] ?? null;
}

export function createSsoUserResolver(input: SsoUserRules): SsoUserResolver {
  const { db, allowedDomains, issuer, jitProvisioning, acceptAnyAccount } = input;

  async function linkExisting(
    found: AccountRow,
    subject: SSOUserResolutionInput,
    trustRequired: boolean,
  ): Promise<SSOUserResolution> {
    if (!isActiveAccount(found.status)) return reject(SSO_ACCOUNT_DEACTIVATED, SSO_ACCOUNT_DEACTIVATED_MESSAGE);
    const identity = subject.accountKey.accountId;
    const owner = await identityOwnerId(db, identity);
    if (owner !== null && owner !== found.id) return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
    if (await holdsOtherIdentity(db, found.id, identity)) {
      return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
    }
    if (trustRequired && !confirmedEmail(subject) && !domainAllowed(found.email.toLowerCase(), allowedDomains)) {
      return reject(SSO_EMAIL_UNVERIFIED, SSO_EMAIL_UNVERIFIED_MESSAGE);
    }
    if (!(await bindIdentity(db, found.id, identity))) {
      return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
    }
    return { action: "link", userId: found.id, profile: "preserve" };
  }

  return async (subject) => {
    if (tenantRefused(subject, issuer)) return reject(SSO_TENANT_MISMATCH, SSO_TENANT_MISMATCH_MESSAGE);

    const email = normalizedEmail(subject);
    if (email === "") return reject(SSO_ACCOUNT_UNKNOWN, SSO_ACCOUNT_UNKNOWN_MESSAGE);

    const found = await userByEmail(db, email);
    if (found !== null) return await linkExisting(found, subject, true);

    const identity = subject.accountKey.accountId;
    if ((await identityOwnerId(db, identity)) !== null) {
      return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
    }
    if (!jitProvisioning) return reject(SSO_ACCOUNT_UNKNOWN, SSO_ACCOUNT_UNKNOWN_MESSAGE);
    if (!acceptAnyAccount && !domainAllowed(email, allowedDomains)) {
      return reject(SSO_DOMAIN_NOT_ALLOWED, SSO_DOMAIN_NOT_ALLOWED_MESSAGE);
    }

    const created = await createMemberAccount(db, subject, email);
    if (created !== null) {
      if (!(await bindIdentity(db, created.id, identity))) {
        return reject(SSO_IDENTITY_CONFLICT, SSO_IDENTITY_CONFLICT_MESSAGE);
      }
      return { action: "link", userId: created.id, profile: "preserve" };
    }

    const raced = await userByEmail(db, email);
    if (raced === null) return reject(SSO_ACCOUNT_UNKNOWN, SSO_ACCOUNT_UNKNOWN_MESSAGE);
    return await linkExisting(raced, subject, false);
  };
}
