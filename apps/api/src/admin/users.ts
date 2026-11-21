import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { userRoleSchema, type AdminUser, type UpdateAdminUserRequest } from "@artiflow/contracts/admin";

import { account, session, user } from "../adapters/postgres/db/schema.ts";
import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { UserRole } from "../identity/roles.ts";
import { canonicalizeEmail, isEmailAddress } from "../invites/token.ts";
import { recordAdminEvent } from "../logging/admin-events.ts";

type Query = AppDb | AppTx;

export const ADMIN_USER_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_USER_MAX_PAGE_SIZE = 100;

export const adminUserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(ADMIN_USER_MAX_PAGE_SIZE).default(ADMIN_USER_DEFAULT_PAGE_SIZE),
  search: z.string().default(""),
  role: userRoleSchema.optional(),
});

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export type AdminUserPage = { users: AdminUser[]; total: number; page: number; pageSize: number };

export type AdminUserEditErrorCode = "invalid_name" | "invalid_email" | "email_in_use";

export class AdminUserEditError extends Error {
  override name = "AdminUserEditError";
  readonly code: AdminUserEditErrorCode;

  constructor(code: AdminUserEditErrorCode) {
    super(`the user cannot be saved: ${code}`);
    this.code = code;
  }
}

type AdminUserRecord = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  accessMethods: string[];
  lastActivityAt: Date | string | null;
};

const accessMethods = sql<string[]>`coalesce(array_agg(distinct ${account.providerId} order by ${account.providerId}), ${"{}"})`;
const lastActivityAt = sql<Date | string | null>`max(${session.updatedAt})`;

const adminUserColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  accessMethods,
  lastActivityAt,
};

function adminUserRows(db: Query) {
  return db
    .select(adminUserColumns)
    .from(user)
    .leftJoin(account, eq(account.userId, user.id))
    .leftJoin(session, eq(session.userId, user.id))
    .groupBy(user.id, user.name, user.email, user.role);
}

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toAdminUser(record: AdminUserRecord): AdminUser {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    accessMethods: record.accessMethods,
    lastActivityAt: isoTimestamp(record.lastActivityAt),
  };
}

function usingLike(term: string): string {
  const escaped = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `%${escaped}%`;
}

function conditionsOf(query: AdminUserListQuery): SQL[] {
  const conditions: SQL[] = [];
  const term = query.search.trim();
  if (term.length > 0) {
    const pattern = usingLike(term);
    const matched = or(ilike(user.name, pattern), ilike(user.email, pattern));
    if (matched !== undefined) conditions.push(matched);
  }
  if (query.role !== undefined) conditions.push(eq(user.role, query.role));
  return conditions;
}

function predicateOf(conditions: SQL[]): SQL | undefined {
  return conditions.length === 0 ? undefined : and(...conditions);
}

export async function listAdminUsers(input: { db: AppDb; query: AdminUserListQuery }): Promise<AdminUserPage> {
  const { db, query } = input;
  const where = predicateOf(conditionsOf(query));
  const rows = await adminUserRows(db)
    .where(where)
    .orderBy(asc(user.email), asc(user.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const totals = await db.select({ total: sql<number>`count(*)::int` }).from(user).where(where);
  return {
    users: rows.map(toAdminUser),
    total: totals[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function readAdminUser(db: Query, userId: string): Promise<AdminUser | null> {
  const rows = await adminUserRows(db).where(eq(user.id, userId));
  const row = rows[0];
  return row === undefined ? null : toAdminUser(row);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "23505";
}

export type UpdateAdminUserInput = UpdateAdminUserRequest & {
  db: AppDb;
  userId: string;
  actorId: string;
  actorRole: UserRole;
  requestId?: string;
};

export async function updateAdminUser(input: UpdateAdminUserInput): Promise<AdminUser | null> {
  const name = input.name.trim();
  if (name.length === 0) throw new AdminUserEditError("invalid_name");
  const email = canonicalizeEmail(input.email);
  if (!isEmailAddress(email)) throw new AdminUserEditError("invalid_email");

  try {
    return await input.db.transaction(async (tx) => {
      const rows = await tx.select({ email: user.email }).from(user).where(eq(user.id, input.userId)).limit(1);
      const current = rows[0];
      if (current === undefined) return null;
      if (current.email !== email) {
        const holders = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
        const holder = holders[0];
        if (holder !== undefined && holder.id !== input.userId) throw new AdminUserEditError("email_in_use");
      }

      await tx.update(user).set({ name, email, updatedAt: new Date() }).where(eq(user.id, input.userId));
      const updated = await readAdminUser(tx, input.userId);
      if (updated === null) return null;

      recordAdminEvent({
        event: "user.updated",
        actorId: input.actorId,
        actorRole: input.actorRole,
        subjectId: updated.id,
        outcome: "applied",
        ...(current.email === email ? {} : { emailChange: { before: current.email, after: email } }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      });
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AdminUserEditError("email_in_use");
    throw error;
  }
}
