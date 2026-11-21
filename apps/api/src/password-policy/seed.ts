import { DEFAULT_PASSWORD_POLICY } from "@artiflow/contracts/settings";

import type { AppDb } from "../adapters/postgres/db/client.ts";
import { SettingRevisionConflictError, passwordPolicySetting, readSetting, writeSetting } from "../settings/store.ts";

export type SeedPasswordPolicyResult = { seeded: boolean };

export async function seedPasswordPolicy(db: AppDb): Promise<SeedPasswordPolicyResult> {
  const existing = await readSetting(db, passwordPolicySetting);
  if (existing !== null) return { seeded: false };
  try {
    await writeSetting(db, passwordPolicySetting, { value: DEFAULT_PASSWORD_POLICY, expectedRevision: null });
  } catch (error) {
    if (error instanceof SettingRevisionConflictError) return { seeded: false };
    throw error;
  }
  return { seeded: true };
}
