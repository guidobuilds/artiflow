import { getCurrentAdapter, runWithTransaction } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

import {
  defaultPasswordPolicySource,
  passwordPolicyMessage,
  validatePassword,
  type PasswordPolicySource,
} from "../password-policy/policy.ts";
import { canonicalizeEmail, hashInviteToken } from "./token.ts";

const INVITE_MODEL = "registrationInvite";
const REFUSAL = { code: "INVALID_INVITATION", message: "This invitation is invalid, expired or already used." };

type InvitationRow = { email: string; expiresAt: Date | string; consumedAt: Date | string | null };

function refused(): APIError {
  return APIError.from("BAD_REQUEST", REFUSAL);
}

function asResponseError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  return APIError.fromStatus("INTERNAL_SERVER_ERROR", { message: "The registration request failed." });
}

function isUsable(invitation: InvitationRow): boolean {
  const expiresAt =
    invitation.expiresAt instanceof Date ? invitation.expiresAt.getTime() : Date.parse(invitation.expiresAt);
  return invitation.consumedAt === null && expiresAt > Date.now();
}

const preview = createAuthEndpoint(
  "/registration/preview",
  { method: "POST", body: z.object({ token: z.string() }) },
  async (ctx) => {
    try {
      const invitation = await ctx.context.adapter.findOne<InvitationRow>({
        model: INVITE_MODEL,
        where: [{ field: "tokenHash", value: hashInviteToken(ctx.body.token) }],
      });
      if (!invitation || !isUsable(invitation)) throw refused();
      ctx.setHeader("cache-control", "no-store");
      ctx.setHeader("pragma", "no-cache");
      return ctx.json({ email: canonicalizeEmail(invitation.email) });
    } catch (error) {
      throw asResponseError(error);
    }
  },
);

const completeEndpoint = (policy: PasswordPolicySource) =>
  createAuthEndpoint(
    "/registration/complete",
    { method: "POST", body: z.object({ token: z.string(), name: z.string(), password: z.string() }) },
    async (ctx) => {
      const name = ctx.body.name.trim();
      const { password } = ctx.body;
      if (name.length === 0) throw APIError.from("BAD_REQUEST", { code: "INVALID_NAME", message: "A name is required." });

      const tokenHash = hashInviteToken(ctx.body.token);

      try {
        const current = await policy();
        const missing = validatePassword(password, current);
        if (missing.length > 0) {
          throw new APIError("BAD_REQUEST", {
            code: "INVALID_PASSWORD",
            message: passwordPolicyMessage(missing, current),
            missing,
          });
        }

        const passwordHash = await ctx.context.password.hash(password);

        await runWithTransaction(ctx.context.adapter, async () => {
          const adapter = await getCurrentAdapter(ctx.context.adapter);
          const consumed = await adapter.updateMany({
            model: INVITE_MODEL,
            where: [
              { field: "tokenHash", value: tokenHash },
              { field: "consumedAt", value: null },
              { field: "expiresAt", operator: "gt", value: new Date() },
            ],
            update: { consumedAt: new Date() },
          });
          if (consumed !== 1) throw refused();

          const invitation = await adapter.findOne<InvitationRow>({
            model: INVITE_MODEL,
            where: [{ field: "tokenHash", value: tokenHash }],
          });
          if (!invitation) throw refused();

          const email = canonicalizeEmail(invitation.email);
          if (await ctx.context.internalAdapter.findUserByEmail(email)) throw refused();

          const created = await ctx.context.internalAdapter.createUser(
            { email, name, emailVerified: false },
            { method: "email-password" },
          );
          await ctx.context.internalAdapter.linkAccount({
            userId: created.id,
            providerId: "credential",
            accountId: created.id,
            password: passwordHash,
          });
        });
      } catch (error) {
        throw asResponseError(error);
      }
      ctx.setHeader("cache-control", "no-store");
      ctx.setHeader("pragma", "no-cache");
      return ctx.json({ ok: true });
    },
  );

export const registrationInvites = (input: { policy?: PasswordPolicySource } = {}): BetterAuthPlugin => ({
  id: "registration-invites",
  schema: {
    registrationInvite: {
      fields: {
        tokenHash: { type: "string", required: true },
        email: { type: "string", required: true },
        expiresAt: { type: "date", required: true },
        consumedAt: { type: "date", required: false },
        createdAt: { type: "date", required: true },
      },
      disableMigration: true,
    },
  },
  endpoints: { preview, complete: completeEndpoint(input.policy ?? defaultPasswordPolicySource) },
});
