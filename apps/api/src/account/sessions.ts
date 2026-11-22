import { and, asc, desc, eq, ne } from "drizzle-orm";

import type { AccountSession } from "@artiflow/contracts/account";

import { session } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";

type Query = AppDb | AppTx;

type SessionRow = {
  id: string;
  startedAt: Date;
  lastUsedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

const sessionColumns = {
  id: session.id,
  startedAt: session.createdAt,
  lastUsedAt: session.updatedAt,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
};

function toAccountSession(row: SessionRow, currentSessionId: string | null): AccountSession {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    current: row.id === currentSessionId,
  };
}

export async function listOwnedSessions(input: {
  db: Query;
  userId: string;
  currentSessionId: string | null;
}): Promise<AccountSession[]> {
  const rows = await input.db
    .select(sessionColumns)
    .from(session)
    .where(eq(session.userId, input.userId))
    .orderBy(desc(session.updatedAt), asc(session.id));
  return rows.map((row) => toAccountSession(row, input.currentSessionId));
}

export async function revokeOwnedSession(input: { db: Query; userId: string; sessionId: string }): Promise<boolean> {
  const revoked = await input.db
    .delete(session)
    .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
    .returning({ id: session.id });
  return revoked.length > 0;
}

export async function revokeOtherOwnedSessions(input: {
  db: Query;
  userId: string;
  keepSessionId: string;
}): Promise<number> {
  const revoked = await input.db
    .delete(session)
    .where(and(eq(session.userId, input.userId), ne(session.id, input.keepSessionId)))
    .returning({ id: session.id });
  return revoked.length;
}

export async function revokeAllOwnedSessions(input: { db: Query; userId: string }): Promise<number> {
  const revoked = await input.db.delete(session).where(eq(session.userId, input.userId)).returning({ id: session.id });
  return revoked.length;
}
