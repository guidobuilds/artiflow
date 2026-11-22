import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { SocialProviders } from "../config.ts";
import { DEFAULT_PASSWORD_POLICY } from "@artiflow/contracts/settings";
import { readPasswordPolicy } from "../password-policy/policy.ts";
import { SecretError, readSecret, type SecretKey } from "./secrets.ts";
import { PROVIDERS, type ProviderName } from "./seed.ts";
import {
  SSO_CONNECTION_OFF,
  ssoConnectionFromValue,
  ssoProviderRegistration,
  ssoSecretName,
  type SsoConnection,
  type SsoProviderRegistration,
} from "./sso-connection.ts";
import {
  accessMethodsSetting,
  readRawSettingValue,
  readSetting,
  SSO_CONNECTION_KEY,
  readSettingsRevision,
} from "./store.ts";

export type SnapshotProvider = { readonly clientId: string; readonly clientSecret: string };

export type SnapshotSso = SsoConnection & { readonly provider: SsoProviderRegistration | null };

export type AccessSnapshot = {
  readonly passwordEnabled: boolean;
  readonly passwordMinLength: number;
  readonly providers: Readonly<Partial<Record<ProviderName, SnapshotProvider>>>;
  readonly degraded: readonly ProviderName[];
  readonly sso: SnapshotSso;
};

export type AccessSnapshotRead = {
  revision: number | null;
  snapshot: AccessSnapshot;
};

type SnapshotInput = {
  passwordEnabled: boolean;
  passwordMinLength: number;
  providers: Partial<Record<ProviderName, SnapshotProvider>>;
  sso: SnapshotSso;
  degraded?: readonly ProviderName[];
};

function freezeSso(sso: SnapshotSso): SnapshotSso {
  return Object.freeze({
    enabled: sso.enabled,
    displayName: sso.displayName,
    provider: sso.provider === null ? null : Object.freeze(sso.provider),
  });
}

function freezeSnapshot(input: SnapshotInput): AccessSnapshot {
  const providers: Partial<Record<ProviderName, SnapshotProvider>> = {};
  for (const provider of PROVIDERS) {
    const credentials = input.providers[provider];
    if (credentials === undefined) continue;
    providers[provider] = Object.freeze({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  }
  return Object.freeze({
    passwordEnabled: input.passwordEnabled,
    passwordMinLength: input.passwordMinLength,
    providers: Object.freeze(providers),
    degraded: Object.freeze([...(input.degraded ?? [])]),
    sso: freezeSso(input.sso),
  });
}

export function environmentSnapshot(socialProviders: SocialProviders): AccessSnapshot {
  const providers: Partial<Record<ProviderName, SnapshotProvider>> = {};
  for (const provider of PROVIDERS) {
    const credentials = socialProviders[provider];
    if (credentials !== undefined) {
      providers[provider] = { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
    }
  }
  return freezeSnapshot({
    passwordEnabled: true,
    passwordMinLength: DEFAULT_PASSWORD_POLICY.minLength,
    providers,
    sso: { ...SSO_CONNECTION_OFF, provider: null },
  });
}

export async function readAccessSnapshot(input: {
  db: AppDb | AppTx;
  key: SecretKey | null;
  fallback: AccessSnapshot;
}): Promise<AccessSnapshotRead> {
  const revision = await readSettingsRevision(input.db);
  const [stored, policy, ssoValue] = await Promise.all([
    readSetting(input.db, accessMethodsSetting),
    readPasswordPolicy(input.db),
    readRawSettingValue(input.db, SSO_CONNECTION_KEY),
  ]);
  const sso = ssoConnectionFromValue(ssoValue);
  let ssoSecret: string | null = null;
  if (sso.enabled) {
    try {
      ssoSecret = await readSecret(input.db, ssoSecretName(), input.key);
    } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      ssoSecret = null;
    }
  }
  const ssoRegistration = ssoProviderRegistration(ssoValue, ssoSecret);
  if (stored === null) {
    return {
      revision,
      snapshot: freezeSnapshot({
        passwordEnabled: input.fallback.passwordEnabled,
        passwordMinLength: policy.minLength,
        providers: input.fallback.providers,
        degraded: input.fallback.degraded,
        sso: { enabled: sso.enabled, displayName: sso.displayName, provider: ssoRegistration },
      }),
    };
  }

  const providers: Partial<Record<ProviderName, SnapshotProvider>> = {};
  const degraded: ProviderName[] = [];
  for (const provider of PROVIDERS) {
    const entry = stored.value.providers[provider];
    if (!entry.enabled) continue;
    if (entry.clientId.trim() === "" || entry.secretName.trim() === "") {
      degraded.push(provider);
      continue;
    }
    let clientSecret: string | null;
    try {
      clientSecret = await readSecret(input.db, entry.secretName, input.key);
    } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      degraded.push(provider);
      continue;
    }
    if (clientSecret === null || clientSecret.trim() === "") {
      degraded.push(provider);
      continue;
    }
    providers[provider] = { clientId: entry.clientId, clientSecret };
  }

  return {
    revision,
    snapshot: freezeSnapshot({
      passwordEnabled: stored.value.password.enabled,
      passwordMinLength: policy.minLength,
      providers,
      degraded,
      sso: { enabled: sso.enabled, displayName: sso.displayName, provider: ssoRegistration },
    }),
  };
}
