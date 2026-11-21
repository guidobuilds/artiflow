import { randomUUID } from "node:crypto";

import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { AuthContext, BetterAuthOptions } from "@better-auth/core";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "../adapters/postgres/db/client.ts";
import { passwordResetToken } from "../adapters/postgres/db/password-reset-schema.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { canonicalizeEmail } from "../invites/token.ts";
import { PASSWORD_RESET_MODEL } from "./plugin.ts";
import { createResetToken, hashResetToken } from "./token.ts";

export type IssueResetResult = { kind: "issued"; token: string; expiresAt: Date } | { kind: "no-account" };
export type ConsumeResetResult = { kind: "consumed" } | { kind: "invalid" };

export type PasswordResetContext<Options extends BetterAuthOptions = BetterAuthOptions> = Pick<
  AuthContext<Options>,
  "adapter" | "internalAdapter" | "password"
>;

class UnusableResetToken extends Error {}

export async function issuePasswordReset(db: AppDb, rawEmail: string, now?: Date): Promise<IssueResetResult> {
  const email = canonicalizeEmail(rawEmail);
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(btrim(${user.email})) = ${email}`)
    .limit(1);
  const owner = existing[0];
  if (owner === undefined) return { kind: "no-account" };

  const issued = createResetToken(now);
  await db.transaction(async (tx) => {
    await tx
      .delete(passwordResetToken)
      .where(and(eq(passwordResetToken.userId, owner.id), isNull(passwordResetToken.consumedAt)));
    await tx.insert(passwordResetToken).values({
      id: randomUUID(),
      userId: owner.id,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
    });
  });
  return { kind: "issued", token: issued.token, expiresAt: issued.expiresAt };
}

export async function consumePasswordReset<Options extends BetterAuthOptions>(
  context: PasswordResetContext<Options>,
  input: { token: string; newPassword: string },
): Promise<ConsumeResetResult> {
  const tokenHash = hashResetToken(input.token);
  const passwordHash = await context.password.hash(input.newPassword);

  try {
    await runWithTransaction(context.adapter, async () => {
      const adapter = await getCurrentAdapter(context.adapter);
      const consumed = await adapter.updateMany({
        model: PASSWORD_RESET_MODEL,
        where: [
          { field: "tokenHash", value: tokenHash },
          { field: "consumedAt", value: null },
          { field: "expiresAt", operator: "gt", value: new Date() },
        ],
        update: { consumedAt: new Date() },
      });
      if (consumed !== 1) throw new UnusableResetToken();

      const spent = await adapter.findOne<{ userId: string }>({
        model: PASSWORD_RESET_MODEL,
        where: [{ field: "tokenHash", value: tokenHash }],
      });
      if (spent === null) throw new UnusableResetToken();

      await setCredentialPassword(context, spent.userId, passwordHash);
      await context.internalAdapter.deleteUserSessions(spent.userId);
    });
  } catch (error) {
    if (error instanceof UnusableResetToken) return { kind: "invalid" };
    throw error;
  }
  return { kind: "consumed" };
}

export async function resetTokenIsUsable<Options extends BetterAuthOptions>(
  context: PasswordResetContext<Options>,
  token: string,
): Promise<boolean> {
  const row = await context.adapter.findOne<{ expiresAt: Date | string; consumedAt: Date | string | null }>({
    model: PASSWORD_RESET_MODEL,
    where: [{ field: "tokenHash", value: hashResetToken(token) }],
  });
  if (row === null) return false;
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(row.expiresAt);
  return row.consumedAt === null && expiresAt > Date.now();
}

async function setCredentialPassword<Options extends BetterAuthOptions>(
  context: PasswordResetContext<Options>,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const credential = await context.internalAdapter.findCredentialAccount(userId);
  if (credential !== null) {
    await context.internalAdapter.updatePassword(userId, passwordHash);
    return;
  }
  await context.internalAdapter.linkAccount({
    userId,
    providerId: "credential",
    accountId: userId,
    password: passwordHash,
  });
}
