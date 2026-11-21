import { eq, or } from "drizzle-orm";

import { artifactComments, artifacts, artifactShares } from "../adapters/postgres/db/artifact-schema.ts";
import { registrationInvite } from "../adapters/postgres/db/invite-schema.ts";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../adapters/postgres/db/oauth-schema.ts";
import { passwordResetToken } from "../adapters/postgres/db/password-reset-schema.ts";
import { account, session, user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { UserRole } from "../identity/roles.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";

export type PurgeContent = { kind: "reassign"; targetUserId: string } | { kind: "delete" };

export type PurgeOutcome =
  | { kind: "purged"; userId: string }
  | { kind: "missing" }
  | { kind: "target-missing" }
  | { kind: "same-account" };

export type PurgeAccountInput = {
  db: AppDb;
  userId: string;
  content: PurgeContent;
  actorId: string;
  actorRole: UserRole | "console";
  requestId?: string;
  at?: Date;
};

type StoredAccount = { id: string; email: string };

async function storedAccount(tx: AppTx, userId: string): Promise<StoredAccount | null> {
  const rows = await tx.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0] ?? null;
}

async function removeOwnedContent(tx: AppTx, userId: string): Promise<void> {
  await tx.delete(artifacts).where(eq(artifacts.ownerId, userId));
}

async function reassignOwnedContent(tx: AppTx, userId: string, targetUserId: string, at: Date): Promise<void> {
  await tx
    .update(artifacts)
    .set({ ownerId: targetUserId, updatedAt: at })
    .where(eq(artifacts.ownerId, userId));
  await tx.update(artifactComments).set({ authorId: targetUserId }).where(eq(artifactComments.authorId, userId));
  await tx
    .update(artifactShares)
    .set({ grantedByUserId: targetUserId })
    .where(eq(artifactShares.grantedByUserId, userId));
}

async function releaseResolvedComments(tx: AppTx, userId: string): Promise<void> {
  await tx.update(artifactComments).set({ resolvedBy: null }).where(eq(artifactComments.resolvedBy, userId));
}

async function removeAccountAccess(tx: AppTx, owner: StoredAccount): Promise<void> {
  await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.id));
  await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.id));
  await tx.delete(oauthConsent).where(eq(oauthConsent.userId, owner.id));
  await tx.update(oauthClient).set({ userId: null }).where(eq(oauthClient.userId, owner.id));
  await tx.delete(passwordResetToken).where(eq(passwordResetToken.userId, owner.id));
  await tx
    .delete(registrationInvite)
    .where(or(eq(registrationInvite.userId, owner.id), eq(registrationInvite.email, owner.email)));
  await tx.delete(session).where(eq(session.userId, owner.id));
  await tx.delete(account).where(eq(account.userId, owner.id));
}

export async function purgeAccount(input: PurgeAccountInput): Promise<PurgeOutcome> {
  return await input.db.transaction(async (tx) => {
    const at = input.at ?? new Date();
    const owner = await storedAccount(tx, input.userId);
    if (owner === null) return { kind: "missing" as const };

    if (input.content.kind === "reassign") {
      if (input.content.targetUserId === owner.id) return { kind: "same-account" as const };
      const targets = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.content.targetUserId))
        .limit(1);
      if (targets.length === 0) return { kind: "target-missing" as const };
      await reassignOwnedContent(tx, owner.id, input.content.targetUserId, at);
    } else {
      await removeOwnedContent(tx, owner.id);
    }

    await releaseResolvedComments(tx, owner.id);
    await removeAccountAccess(tx, owner);
    await tx.delete(user).where(eq(user.id, owner.id));

    recordAdminEvent({
      event: "user.purged",
      actorId: input.actorId,
      actorRole: input.actorRole,
      subjectId: owner.id,
      outcome: "applied",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return { kind: "purged" as const, userId: owner.id };
  });
}
