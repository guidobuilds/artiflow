import { APIError, createAuthMiddleware } from "better-auth/api";

import { passwordPolicyMessage, validatePassword, type PasswordPolicySource } from "./policy.ts";

export const PASSWORD_POLICY_CODE = "INVALID_PASSWORD";

const CANDIDATE_FIELD: Readonly<Record<string, "password" | "newPassword">> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function passwordPolicyHook(readPolicy: PasswordPolicySource) {
  return createAuthMiddleware(async (ctx) => {
    const field = CANDIDATE_FIELD[ctx.path];
    if (field === undefined) return;
    if (ctx.path === "/sign-up/email" && ctx.context.options.emailAndPassword?.disableSignUp === true) return;
    const candidate = isRecord(ctx.body) ? ctx.body[field] : undefined;
    if (typeof candidate !== "string") return;

    const policy = await readPolicy();

    const missing = validatePassword(candidate, policy);
    if (missing.length === 0) return;
    throw new APIError("BAD_REQUEST", {
      code: PASSWORD_POLICY_CODE,
      message: passwordPolicyMessage(missing, policy),
      missing,
    });
  });
}
