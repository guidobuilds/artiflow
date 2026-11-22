import type { PasswordPolicyConfiguration, UpdatePasswordPolicyRequest } from "@artiflow/contracts/admin";
import { DEFAULT_PASSWORD_POLICY } from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { passwordPolicySetting, readSetting, writeSetting } from "../settings/store.ts";

type Query = AppDb | AppTx;

export async function readPasswordPolicyConfiguration(input: { db: Query }): Promise<PasswordPolicyConfiguration> {
  const stored = await readSetting(input.db, passwordPolicySetting);
  return { revision: stored?.revision ?? null, policy: stored?.value ?? DEFAULT_PASSWORD_POLICY };
}

export async function updatePasswordPolicyConfiguration(input: {
  db: AppDb;
  change: UpdatePasswordPolicyRequest;
  actorId: string;
}): Promise<PasswordPolicyConfiguration> {
  const written = await writeSetting(input.db, passwordPolicySetting, {
    value: input.change.policy,
    expectedRevision: input.change.revision,
    updatedBy: input.actorId,
  });
  return { revision: written.revision, policy: written.value };
}
