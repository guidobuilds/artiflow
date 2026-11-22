import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { eq, type SQL } from "drizzle-orm";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { user } from "../adapters/postgres/db/schema.ts";
import { isActiveAccount } from "../identity/account-status.ts";
import { isAdministrator } from "../identity/roles.ts";

const PASSWORD_SIGN_IN_PATH = "/sign-in/email";
const SOCIAL_SIGN_IN_PATHS = new Set(["/sign-in/social", "/callback/:id"]);

export type AlternativeMethodLockOptions = {
  db: AppDb | AppTx;
  ssoEnabled: boolean;
  passwordEnabled: boolean;
};

type Query = AppDb | AppTx;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refuse(): APIError {
  return APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
}

async function isAdministratorAccount(db: Query, where: SQL): Promise<boolean> {
  const rows = await db.select({ role: user.role, status: user.status }).from(user).where(where).limit(1);
  const found = rows[0];
  return found !== undefined && isAdministrator(found.role) && isActiveAccount(found.status);
}

export function alternativeMethodLock(options: AlternativeMethodLockOptions): BetterAuthPlugin {
  const { db, ssoEnabled, passwordEnabled } = options;
  return {
    id: "alternative-method-lock",
    hooks: {
      before: [
        {
          matcher: (context) => ssoEnabled && passwordEnabled && context.path === PASSWORD_SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const address =
              isRecord(ctx.body) && typeof ctx.body.email === "string" ? ctx.body.email.toLowerCase() : "";
            if (address === "") throw refuse();
            if (await isAdministratorAccount(db, eq(user.email, address))) return;
            throw refuse();
          }),
        },
      ],
      after: [
        {
          matcher: (context) => ssoEnabled && SOCIAL_SIGN_IN_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created) return;
            if (await isAdministratorAccount(db, eq(user.id, created.user.id))) return;
            deleteSessionCookie(ctx as unknown as Parameters<typeof deleteSessionCookie>[0], true);
            await ctx.context.internalAdapter.deleteSession(created.session.token);
            ctx.context.setNewSession(null);
          }),
        },
      ],
    },
  };
}
