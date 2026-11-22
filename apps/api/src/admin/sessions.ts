import { eq } from "drizzle-orm";

import type { AdminSession } from "@artiflow/contracts/admin";

import { user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { UserRole } from "../identity/roles.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";
import { listOwnedSessions, revokeAllOwnedSessions, revokeOwnedSession } from "../account/sessions.ts";

async function accountExists(db: AppDb | AppTx, userId: string): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  return rows.length > 0;
}

export async function listAccountSessions(input: {
  db: AppDb;
  userId: string;
  currentSessionId: string | null;
}): Promise<AdminSession[] | null> {
  if (!(await accountExists(input.db, input.userId))) return null;
  return await listOwnedSessions(input);
}

export type AccountSessionChange = {
  db: AppDb;
  userId: string;
  actorId: string;
  actorRole: UserRole;
  requestId?: string;
};

export type RevokeAccountSessionOutcome = { kind: "revoked" } | { kind: "missing" };

export async function revokeAccountSession(
  change: AccountSessionChange & { sessionId: string },
): Promise<RevokeAccountSessionOutcome> {
  return await change.db.transaction(async (tx) => {
    const revoked = await revokeOwnedSession({ db: tx, userId: change.userId, sessionId: change.sessionId });
    if (!revoked) return { kind: "missing" as const };
    recordAdminEvent({
      event: "session.revoked",
      actorId: change.actorId,
      actorRole: change.actorRole,
      subjectId: change.userId,
      sessionId: change.sessionId,
      outcome: "applied",
      ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    });
    return { kind: "revoked" as const };
  });
}

export type RevokeAccountSessionsOutcome = { kind: "revoked"; revoked: number } | { kind: "missing" };

export async function revokeAccountSessions(change: AccountSessionChange): Promise<RevokeAccountSessionsOutcome> {
  return await change.db.transaction(async (tx) => {
    if (!(await accountExists(tx, change.userId))) return { kind: "missing" as const };
    const revoked = await revokeAllOwnedSessions({ db: tx, userId: change.userId });
    if (revoked === 0) return { kind: "revoked" as const, revoked };
    recordAdminEvent({
      event: "sessions.revoked",
      actorId: change.actorId,
      actorRole: change.actorRole,
      subjectId: change.userId,
      outcome: "applied",
      ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    });
    return { kind: "revoked" as const, revoked };
  });
}
