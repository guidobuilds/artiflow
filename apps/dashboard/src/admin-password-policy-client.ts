import { manageRequest } from "./auth-client.ts";

export type PasswordPolicy = {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
};

export type PasswordPolicyConfiguration = { revision: number | null; policy: PasswordPolicy };

export type PasswordPolicyDraft = {
  minLength: string;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
};

export type UpdatePasswordPolicyPayload = { revision: number | null; policy: PasswordPolicy };

export type PasswordPolicyReadFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type PasswordPolicyRead = { ok: true; value: PasswordPolicyConfiguration } | PasswordPolicyReadFailure;
export type PasswordPolicySaveFailure = PasswordPolicyReadFailure & {
  conflict: boolean;
  refreshed: PasswordPolicyConfiguration | null;
};
export type PasswordPolicySave = { ok: true; value: PasswordPolicyConfiguration } | PasswordPolicySaveFailure;

export type PolicyBuilt = { ok: true; value: UpdatePasswordPolicyPayload } | { ok: false; error: string };

export const POLICY_PATH = "/api/admin/password-policy";
export const PUBLIC_POLICY_PATH = "/api/auth/password-policy";
export const MINIMUM_LENGTH_FLOOR = 8;
export const MINIMUM_LENGTH_CEILING = 128;

export const POLICY_RULES: {
  name: "requireUppercase" | "requireLowercase" | "requireNumber" | "requireSymbol";
  label: string;
  phrase: string;
}[] = [
  { name: "requireUppercase", label: "Uppercase letter", phrase: "an uppercase letter" },
  { name: "requireLowercase", label: "Lowercase letter", phrase: "a lowercase letter" },
  { name: "requireNumber", label: "Number", phrase: "a number" },
  { name: "requireSymbol", label: "Symbol", phrase: "a symbol" },
];

const SIGN_IN_REQUIRED =
  "This browser has no signed-in account, so the password policy cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was saved.";
const LENGTH_OUT_OF_RANGE = `The minimum length must be a whole number between ${MINIMUM_LENGTH_FLOOR} and ${MINIMUM_LENGTH_CEILING}.`;

const REFUSALS: Record<string, string> = {
  administrator_required:
    "Only an administrator can change the password policy. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  revision_conflict:
    "Another administrator saved a change first. The page now shows what is stored; review it and save again.",
  invalid_body: "The server refused the request as incomplete. Nothing was saved.",
  network: "The server could not be reached, so nothing was saved.",
  unreadable_answer: "The server answered unexpectedly, so nothing was saved.",
};

export function passwordPolicyRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toPolicy(value: unknown): PasswordPolicy | null {
  if (!isRecord(value)) return null;
  const { minLength, requireUppercase, requireLowercase, requireNumber, requireSymbol } = value;
  if (typeof minLength !== "number" || !Number.isInteger(minLength) || minLength < 1) return null;
  for (const flag of [requireUppercase, requireLowercase, requireNumber, requireSymbol]) {
    if (typeof flag !== "boolean") return null;
  }
  return {
    minLength,
    requireUppercase: requireUppercase as boolean,
    requireLowercase: requireLowercase as boolean,
    requireNumber: requireNumber as boolean,
    requireSymbol: requireSymbol as boolean,
  };
}

export function parsePasswordPolicyConfiguration(body: unknown): PasswordPolicyConfiguration | null {
  if (!isRecord(body)) return null;
  const revision = body.revision;
  const validRevision = revision === null || (typeof revision === "number" && Number.isInteger(revision) && revision > 0);
  if (!validRevision) return null;
  const policy = toPolicy(body.policy);
  if (policy === null) return null;
  return { revision, policy };
}

export type PublicPasswordPolicy = PasswordPolicy & { requirements: { requirement: string; message: string }[] };

export function parsePublicPasswordPolicy(body: unknown): PublicPasswordPolicy | null {
  const policy = parsePasswordPolicyConfiguration({ revision: null, policy: body });
  if (policy === null || !isRecord(body)) return null;
  const requirements = body.requirements;
  if (!Array.isArray(requirements)) return null;
  const parsed: { requirement: string; message: string }[] = [];
  for (const entry of requirements) {
    if (!isRecord(entry)) return null;
    const { requirement, message } = entry;
    if (typeof requirement !== "string" || requirement === "") return null;
    if (typeof message !== "string" || message === "") return null;
    parsed.push({ requirement, message });
  }
  return { ...policy.policy, requirements: parsed };
}

export function draftFromPolicy(policy: PasswordPolicy): PasswordPolicyDraft {
  return {
    minLength: String(policy.minLength),
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireNumber: policy.requireNumber,
    requireSymbol: policy.requireSymbol,
  };
}

export function policySummary(policy: PasswordPolicy): string {
  const required = POLICY_RULES.filter((rule) => policy[rule.name]).map((rule) => rule.phrase);
  const base = `At least ${policy.minLength} characters`;
  if (required.length === 0) return `${base}, with no further requirement.`;
  if (required.length === 1) return `${base}, with ${required[0]}.`;
  return `${base}, with ${required.slice(0, -1).join(", ")} and ${required[required.length - 1]}.`;
}

export function buildUpdatePasswordPolicyPayload(
  draft: PasswordPolicyDraft,
  revision: number | null,
): PolicyBuilt {
  const trimmed = draft.minLength.trim();
  const minLength = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(minLength)) return { ok: false, error: LENGTH_OUT_OF_RANGE };
  if (minLength < MINIMUM_LENGTH_FLOOR || minLength > MINIMUM_LENGTH_CEILING) {
    return { ok: false, error: LENGTH_OUT_OF_RANGE };
  }
  return {
    ok: true,
    value: {
      revision,
      policy: {
        minLength,
        requireUppercase: draft.requireUppercase,
        requireLowercase: draft.requireLowercase,
        requireNumber: draft.requireNumber,
        requireSymbol: draft.requireSymbol,
      },
    },
  };
}

export async function readPasswordPolicyConfiguration(): Promise<PasswordPolicyRead> {
  const result = await manageRequest(POLICY_PATH, "GET", parsePasswordPolicyConfiguration);
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: passwordPolicyRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function savePasswordPolicy(
  draft: PasswordPolicyDraft,
  revision: number | null,
): Promise<PasswordPolicySave> {
  const built = buildUpdatePasswordPolicyPayload(draft, revision);
  if (!built.ok) {
    return {
      ok: false,
      code: "invalid_length",
      error: built.error,
      signInRequired: false,
      conflict: false,
      refreshed: null,
    };
  }
  const result = await manageRequest(POLICY_PATH, "PUT", parsePasswordPolicyConfiguration, built.value);
  if (result.ok) return result;
  if (result.code === "revision_conflict") {
    const refreshed = await readPasswordPolicyConfiguration();
    return {
      ok: false,
      code: result.code,
      error: passwordPolicyRefusalMessage(result.code),
      signInRequired: result.signInRequired,
      conflict: true,
      refreshed: refreshed.ok ? refreshed.value : null,
    };
  }
  return {
    ok: false,
    code: result.code,
    error: passwordPolicyRefusalMessage(result.code),
    signInRequired: result.signInRequired,
    conflict: false,
    refreshed: null,
  };
}
