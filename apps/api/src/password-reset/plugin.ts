import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

import { canonicalizeEmail } from "../invites/token.ts";
import {
  defaultPasswordPolicySource,
  passwordPolicyMessage,
  validatePassword,
  type PasswordPolicySource,
} from "../password-policy/policy.ts";
import { consumePasswordReset, resetTokenIsUsable } from "./service.ts";
import { hashResetToken } from "./token.ts";

export const PASSWORD_RESET_MODEL = "passwordResetToken";

const REFUSAL = { code: "INVALID_RESET", message: "This password reset link is invalid, expired or already used." };

type ResetRow = { userId: string; expiresAt: Date | string; consumedAt: Date | string | null };

function refused(): APIError {
  return APIError.from("BAD_REQUEST", REFUSAL);
}

function asResponseError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  return APIError.fromStatus("INTERNAL_SERVER_ERROR", { message: "The password reset request failed." });
}

function isUsable(row: ResetRow): boolean {
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(row.expiresAt);
  return row.consumedAt === null && expiresAt > Date.now();
}

const preview = createAuthEndpoint(
  "/password-reset/preview",
  { method: "POST", body: z.object({ token: z.string() }) },
  async (ctx) => {
    try {
      const reset = await ctx.context.adapter.findOne<ResetRow>({
        model: PASSWORD_RESET_MODEL,
        where: [{ field: "tokenHash", value: hashResetToken(ctx.body.token) }],
      });
      if (!reset || !isUsable(reset)) throw refused();
      const owner = await ctx.context.internalAdapter.findUserById(reset.userId);
      if (!owner) throw refused();
      ctx.setHeader("cache-control", "no-store");
      ctx.setHeader("pragma", "no-cache");
      return ctx.json({ email: canonicalizeEmail(owner.email) });
    } catch (error) {
      throw asResponseError(error);
    }
  },
);

const completeEndpoint = (policy: PasswordPolicySource) =>
  createAuthEndpoint(
    "/password-reset/complete",
    { method: "POST", body: z.object({ token: z.string(), newPassword: z.string() }) },
    async (ctx) => {
      try {
        if (!(await resetTokenIsUsable(ctx.context, ctx.body.token))) throw refused();

        const current = await policy();
        const missing = validatePassword(ctx.body.newPassword, current);
        if (missing.length > 0) {
          throw new APIError("BAD_REQUEST", {
            code: "PASSWORD_INVALID",
            message: passwordPolicyMessage(missing, current),
            missing,
          });
        }

        const result = await consumePasswordReset(ctx.context, {
          token: ctx.body.token,
          newPassword: ctx.body.newPassword,
        });
        if (result.kind === "invalid") throw refused();
      } catch (error) {
        throw asResponseError(error);
      }
      ctx.setHeader("cache-control", "no-store");
      ctx.setHeader("pragma", "no-cache");
      return ctx.json({ status: "ok" });
    },
  );

export const passwordReset = (input: { policy?: PasswordPolicySource } = {}): BetterAuthPlugin => ({
  id: "password-reset",
  schema: {
    [PASSWORD_RESET_MODEL]: {
      fields: {
        userId: { type: "string", required: true },
        tokenHash: { type: "string", required: true },
        expiresAt: { type: "date", required: true },
        consumedAt: { type: "date", required: false },
        createdBy: { type: "string", required: false },
        createdAt: { type: "date", required: true },
      },
      disableMigration: true,
    },
  },
  endpoints: { resetPreview: preview, resetComplete: completeEndpoint(input.policy ?? defaultPasswordPolicySource) },
});
