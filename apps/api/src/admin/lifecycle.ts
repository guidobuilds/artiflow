import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { artifactPublicLinks, artifacts } from "../adapters/postgres/db/artifact-schema.ts";
import { oauthAccessToken, oauthRefreshToken } from "../adapters/postgres/db/oauth-schema.ts";
import { session, user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { ACTIVE_ACCOUNT_STATUS, DEACTIVATED_ACCOUNT_STATUS, type AccountStatus } from "../identity/account-status.ts";
import type { UserRole } from "../identity/roles.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";

export type AccountLifecycleChange = {
  db: AppDb;
  userId: string;
  actorId: string;
  actorRole: UserRole;
  requestId?: string;
  at?: Date;
};

export type AccountLifecycleOutcome =
  { kind: "changed"; user: { id: string; status: AccountStatus } } | { kind: "unchanged" } | { kind: "missing" };

async function currentStatus(db: AppDb | AppTx, userId: string): Promise<AccountStatus | null> {
  const rows = await db.select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0]?.status ?? null;
}

async function refusalFor(db: AppDb | AppTx, userId: string): Promise<AccountLifecycleOutcome> {
  const status = await currentStatus(db, userId);
  return status === null ? { kind: "missing" as const } : { kind: "unchanged" as const };
}

async function revokeIssuedTokens(tx: AppTx, userId: string, at: Date): Promise<void> {
  await tx
    .update(oauthAccessToken)
    .set({ revoked: at })
    .where(
      and(eq(oauthAccessToken.userId, userId), isNotNull(oauthAccessToken.userId), isNull(oauthAccessToken.revoked)),
    );
  await tx
    .update(oauthRefreshToken)
    .set({ revoked: at })
    .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
}

async function revokeOwnedPublicLinks(tx: AppTx, userId: string, at: Date): Promise<void> {
  const owned = sql`${artifactPublicLinks.artifactId} in (select ${artifacts.id} from ${artifacts} where ${artifacts.ownerId} = ${userId})`;
  await tx
    .update(artifactPublicLinks)
    .set({ revokedAt: at })
    .where(and(owned, isNull(artifactPublicLinks.revokedAt)));
}

export async function deactivateAccount(change: AccountLifecycleChange): Promise<AccountLifecycleOutcome> {
  return change.db.transaction(async (tx) => {
    const at = change.at ?? new Date();
    const applied = await tx
      .update(user)
      .set({ status: DEACTIVATED_ACCOUNT_STATUS, deactivatedAt: at, deactivatedBy: change.actorId, updatedAt: at })
      .where(and(eq(user.id, change.userId), eq(user.status, ACTIVE_ACCOUNT_STATUS)))
      .returning({ id: user.id, status: user.status });
    if (applied.length === 0) return refusalFor(tx, change.userId);
    await tx.delete(session).where(eq(session.userId, change.userId));
    await revokeIssuedTokens(tx, change.userId, at);
    await revokeOwnedPublicLinks(tx, change.userId, at);
    recordAdminEvent({
      event: "user.deactivated",
      actorId: change.actorId,
      actorRole: change.actorRole,
      subjectId: change.userId,
      outcome: "applied",
      ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    });
    return { kind: "changed" as const, user: { id: change.userId, status: DEACTIVATED_ACCOUNT_STATUS } };
  });
}

export async function reactivateAccount(change: AccountLifecycleChange): Promise<AccountLifecycleOutcome> {
  return change.db.transaction(async (tx) => {
    const at = change.at ?? new Date();
    const applied = await tx
      .update(user)
      .set({ status: ACTIVE_ACCOUNT_STATUS, deactivatedAt: null, deactivatedBy: null, updatedAt: at })
      .where(and(eq(user.id, change.userId), eq(user.status, DEACTIVATED_ACCOUNT_STATUS)))
      .returning({ id: user.id, status: user.status });
    if (applied.length === 0) return refusalFor(tx, change.userId);
    recordAdminEvent({
      event: "user.reactivated",
      actorId: change.actorId,
      actorRole: change.actorRole,
      subjectId: change.userId,
      outcome: "applied",
      ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    });
    return { kind: "changed" as const, user: { id: change.userId, status: ACTIVE_ACCOUNT_STATUS } };
  });
}
