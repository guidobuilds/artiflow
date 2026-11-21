import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_PASSWORD_POLICY, type PasswordPolicyDocument } from "@artiflow/contracts/settings";

import {
  MAX_PASSWORD_LENGTH,
  passwordPolicyMessage,
  policyRequirements,
  policyView,
  requirementMessage,
  validatePassword,
} from "../apps/api/src/password-policy/policy.ts";

function policy(overrides: Partial<PasswordPolicyDocument> = {}): PasswordPolicyDocument {
  return { ...DEFAULT_PASSWORD_POLICY, ...overrides };
}

const COMPLIANT = "Long-Enough1Password";

test("the default policy is twelve characters with the four requirements on", () => {
  assert.deepEqual({ ...DEFAULT_PASSWORD_POLICY }, {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: true,
  });
  assert.deepEqual(validatePassword(COMPLIANT, policy()), []);
});

test("each requirement is reported alone and names itself", () => {
  const cases: [string, string, string][] = [
    ["minLength", "Short1!Aa", "The password must be at least 12 characters."],
    ["maxLength", `${COMPLIANT}${"x".repeat(MAX_PASSWORD_LENGTH)}`, "The password must be at most 128 characters."],
    ["uppercase", "lowercase-1-password", "The password must include an uppercase letter."],
    ["lowercase", "UPPERCASE-1-PASSWORD", "The password must include a lowercase letter."],
    ["number", "NoNumbers-At-All-Password", "The password must include a number."],
    ["symbol", "NoSymbols1234Password", "The password must include a symbol."],
  ];
  for (const [requirement, candidate, message] of cases) {
    const missing = validatePassword(candidate, policy());
    assert.deepEqual(
      missing.map((rule) => rule.requirement),
      [requirement],
      `${requirement} is the only requirement the candidate misses`,
    );
    assert.equal(missing[0]?.message, message);
  }
});

test("a candidate that misses several requirements answers every one of them in a fixed order", () => {
  assert.deepEqual(
    validatePassword("", policy()).map((rule) => rule.requirement),
    ["minLength", "uppercase", "lowercase", "number", "symbol"],
  );
  assert.deepEqual(
    validatePassword("nodigits", policy()).map((rule) => rule.requirement),
    ["minLength", "uppercase", "number", "symbol"],
  );
  assert.equal(new Set(validatePassword("", policy())).size, 5, "a requirement is never reported twice");
});

test("the minimum length boundary is inclusive and the requirement is honoured exactly", () => {
  const exact = "Abcdefgh1!xy";
  assert.equal(exact.length, DEFAULT_PASSWORD_POLICY.minLength);
  assert.deepEqual(validatePassword(exact, policy()), []);
  const shorter = "Abcdefgh1!x";
  assert.equal(shorter.length, DEFAULT_PASSWORD_POLICY.minLength - 1);
  assert.deepEqual(
    validatePassword(shorter, policy()).map((rule) => rule.requirement),
    ["minLength"],
  );
  const longerRequired = validatePassword(exact, policy({ minLength: 20 }));
  assert.deepEqual(
    longerRequired.map((rule) => rule.requirement),
    ["minLength"],
  );
  assert.equal(longerRequired[0]?.message, "The password must be at least 20 characters.");
});

test("a requirement that is off is never demanded and never listed", () => {
  const relaxed = policy({ requireUppercase: false, requireLowercase: false, requireNumber: false, requireSymbol: false });
  assert.deepEqual(validatePassword("abcdefghijkl", relaxed), []);
  assert.deepEqual(
    validatePassword("abcdefghijk", relaxed).map((rule) => rule.requirement),
    ["minLength"],
  );
  assert.deepEqual(
    policyRequirements(relaxed).map((rule) => rule.requirement),
    ["minLength", "maxLength"],
  );
  assert.deepEqual(
    validatePassword("abcdefghijkl", policy({ requireSymbol: false, requireNumber: false })).map((rule) => rule.requirement),
    ["uppercase"],
  );
});

test("every message is one bounded sentence the interface can render without echoing the candidate", () => {
  const candidate = "";
  const allRequirements: PasswordPolicyDocument[] = [
    policy(),
    policy({ minLength: 40 }),
    policy({ requireUppercase: false, requireLowercase: false }),
  ];
  for (const current of allRequirements) {
    for (const rule of policyRequirements(current)) {
      assert.equal(rule.message.length > 0, true);
      assert.equal(rule.message.endsWith("."), true, `${rule.requirement} is a sentence`);
      assert.equal(rule.message.length <= 120, true, `${rule.requirement} stays bounded`);
      assert.equal(rule.message, requirementMessage(rule.requirement, current));
    }
    const summary = passwordPolicyMessage(validatePassword(candidate, current), current);
    assert.equal(summary.length <= 120, true, "the summary stays bounded");
    assert.equal(summary.includes("undefined"), false);
  }
});

test("a summary names what is missing and a single miss keeps the rule's own words", () => {
  const current = policy();
  const single = validatePassword("Short1!Aa", current);
  assert.equal(single.length, 1);
  assert.equal(passwordPolicyMessage(single, current), "The password must be at least 12 characters.");

  const several = validatePassword("short7!", current);
  const message = passwordPolicyMessage(several, current);
  assert.equal(message, "The password is missing at least 12 characters and an uppercase letter.");
  for (const rule of several) assert.equal(message.includes(rule.message), false, "the summary is not a message dump");

  const everyRule = passwordPolicyMessage(
    validatePassword("", policy({ minLength: 20 })),
    policy({ minLength: 20 }),
  );
  for (const phrase of ["at least 20 characters", "an uppercase letter", "a lowercase letter", "a number", "a symbol"]) {
    assert.equal(everyRule.includes(phrase), true, `the summary names ${phrase}`);
  }
  assert.equal(everyRule.length <= 120, true, "even the widest summary stays bounded");
});

test("the public view carries the ceiling, the policy and the active rules", () => {
  const view = policyView(policy({ requireNumber: false }));
  assert.deepEqual(view, {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: false,
    requireSymbol: true,
    maxLength: MAX_PASSWORD_LENGTH,
    requirements: [
      { requirement: "minLength", message: "The password must be at least 12 characters." },
      { requirement: "maxLength", message: "The password must be at most 128 characters." },
      { requirement: "uppercase", message: "The password must include an uppercase letter." },
      { requirement: "lowercase", message: "The password must include a lowercase letter." },
      { requirement: "symbol", message: "The password must include a symbol." },
    ],
  });
});
