import {
  PUBLIC_POLICY_PATH,
  parsePublicPasswordPolicy,
  type PublicPasswordPolicy,
} from "./admin-password-policy-client.ts";
import { manageRequest } from "./auth-client.ts";

export type PasswordPolicyRead = { ok: true; value: PublicPasswordPolicy } | { ok: false; error: string };

export const PASSWORD_POLICY_UNAVAILABLE =
  "The password policy could not be shown right now. The form still works, and the server applies the policy in force when the password is set.";

export function passwordPolicyStatements(policy: PublicPasswordPolicy): string[] {
  return policy.requirements.map((rule) => rule.message);
}

export async function readPasswordPolicyInForce(): Promise<PasswordPolicyRead> {
  const result = await manageRequest(PUBLIC_POLICY_PATH, "GET", parsePublicPasswordPolicy);
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: PASSWORD_POLICY_UNAVAILABLE };
}
