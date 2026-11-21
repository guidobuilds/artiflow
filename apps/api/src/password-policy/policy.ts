import {
  DEFAULT_PASSWORD_POLICY,
  type PasswordPolicyDocument,
  type PasswordPolicyView,
  type PasswordRequirement,
  type PasswordRequirementRule,
} from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { passwordPolicySetting, readSetting } from "../settings/store.ts";

type Query = AppDb | AppTx;

export const MAX_PASSWORD_LENGTH = 128;

const REQUIREMENT_ORDER: readonly PasswordRequirement[] = [
  "minLength",
  "maxLength",
  "uppercase",
  "lowercase",
  "number",
  "symbol",
];

const CHARACTER_RULES: Readonly<Record<"uppercase" | "lowercase" | "number" | "symbol", RegExp>> = {
  uppercase: /[A-Z]/,
  lowercase: /[a-z]/,
  number: /[0-9]/,
  symbol: /[^A-Za-z0-9]/,
};

const RULE_MESSAGES: Readonly<Record<"uppercase" | "lowercase" | "number" | "symbol", string>> = {
  uppercase: "The password must include an uppercase letter.",
  lowercase: "The password must include a lowercase letter.",
  number: "The password must include a number.",
  symbol: "The password must include a symbol.",
};

const RULE_PHRASES: Readonly<Record<"uppercase" | "lowercase" | "number" | "symbol", string>> = {
  uppercase: "an uppercase letter",
  lowercase: "a lowercase letter",
  number: "a number",
  symbol: "a symbol",
};

export type PasswordPolicy = PasswordPolicyDocument;

function isRequired(requirement: PasswordRequirement, policy: PasswordPolicy): boolean {
  switch (requirement) {
    case "minLength":
      return true;
    case "maxLength":
      return true;
    case "uppercase":
      return policy.requireUppercase;
    case "lowercase":
      return policy.requireLowercase;
    case "number":
      return policy.requireNumber;
    case "symbol":
      return policy.requireSymbol;
  }
}

function isSatisfied(requirement: PasswordRequirement, password: string, policy: PasswordPolicy): boolean {
  switch (requirement) {
    case "minLength":
      return password.length >= policy.minLength;
    case "maxLength":
      return password.length <= MAX_PASSWORD_LENGTH;
    case "uppercase":
    case "lowercase":
    case "number":
    case "symbol":
      return CHARACTER_RULES[requirement].test(password);
  }
}

export function requirementMessage(requirement: PasswordRequirement, policy: PasswordPolicy): string {
  if (requirement === "minLength") return `The password must be at least ${policy.minLength} characters.`;
  if (requirement === "maxLength") return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return RULE_MESSAGES[requirement];
}

export function requirementPhrase(requirement: PasswordRequirement, policy: PasswordPolicy): string {
  if (requirement === "minLength") return `at least ${policy.minLength} characters`;
  if (requirement === "maxLength") return `at most ${MAX_PASSWORD_LENGTH} characters`;
  return RULE_PHRASES[requirement];
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

export function validatePassword(password: string, policy: PasswordPolicy): PasswordRequirementRule[] {
  return REQUIREMENT_ORDER.filter(
    (requirement) => isRequired(requirement, policy) && !isSatisfied(requirement, password, policy),
  ).map((requirement) => ({ requirement, message: requirementMessage(requirement, policy) }));
}

export function passwordPolicyMessage(missing: readonly PasswordRequirementRule[], policy: PasswordPolicy): string {
  if (missing.length === 0) return "The password meets the policy.";
  if (missing.length === 1) return missing[0]?.message ?? "";
  return `The password is missing ${joinPhrases(missing.map((rule) => requirementPhrase(rule.requirement, policy)))}.`;
}

export function policyRequirements(policy: PasswordPolicy): PasswordRequirementRule[] {
  return REQUIREMENT_ORDER.filter((requirement) => isRequired(requirement, policy)).map((requirement) => ({
    requirement,
    message: requirementMessage(requirement, policy),
  }));
}

export function policyView(policy: PasswordPolicy): PasswordPolicyView {
  return { ...policy, maxLength: MAX_PASSWORD_LENGTH, requirements: policyRequirements(policy) };
}

export function defaultPasswordPolicyView(): PasswordPolicyView {
  return policyView(DEFAULT_PASSWORD_POLICY);
}

export async function readPasswordPolicy(db: Query): Promise<PasswordPolicy> {
  const stored = await readSetting(db, passwordPolicySetting);
  return stored === null ? DEFAULT_PASSWORD_POLICY : stored.value;
}

export async function readPasswordPolicyView(db: Query): Promise<PasswordPolicyView> {
  return policyView(await readPasswordPolicy(db));
}

export type PasswordPolicySource = () => Promise<PasswordPolicy>;

export const defaultPasswordPolicySource: PasswordPolicySource = async () => DEFAULT_PASSWORD_POLICY;
