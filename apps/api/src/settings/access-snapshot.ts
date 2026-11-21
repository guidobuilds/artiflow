import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { SocialProviders } from "../config.ts";
import { DEFAULT_PASSWORD_POLICY } from "@artiflow/contracts/settings";
import { readPasswordPolicy } from "../password-policy/policy.ts";
import { SecretError, readSecret, type SecretKey } from "./secrets.ts";
import { PROVIDERS, type ProviderName } from "./seed.ts";
import { SSO_CONNECTION_OFF, readSsoConnection, type SsoConnection } from "./sso-connection.ts";
import { accessMethodsSetting, readSetting, readSettingsRevision } from "./store.ts";

export type SnapshotProvider = { readonly clientId: string; readonly clientSecret: string };

export type AccessSnapshot = {
  readonly passwordEnabled: boolean;
  readonly passwordMinLength: number;
  readonly providers: Readonly<Partial<Record<ProviderName, SnapshotProvider>>>;
  readonly degraded: readonly ProviderName[];
  readonly sso: SsoConnection;
};

export type AccessSnapshotRead = {
  revision: number | null;
  snapshot: AccessSnapshot;
};

type SnapshotInput = {
  passwordEnabled: boolean;
  passwordMinLength: number;
  providers: Partial<Record<ProviderName, SnapshotProvider>>;
  sso: SsoConnection;
  degraded?: readonly ProviderName[];
};

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
    sso: Object.freeze({ enabled: input.sso.enabled, displayName: input.sso.displayName }),
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
    sso: SSO_CONNECTION_OFF,
  });
}

export async function readAccessSnapshot(input: {
  db: AppDb | AppTx;
  key: SecretKey | null;
  fallback: AccessSnapshot;
}): Promise<AccessSnapshotRead> {
  const revision = await readSettingsRevision(input.db);
  const [stored, policy, sso] = await Promise.all([
    readSetting(input.db, accessMethodsSetting),
    readPasswordPolicy(input.db),
    readSsoConnection(input.db),
  ]);
  if (stored === null) {
    return {
      revision,
      snapshot: freezeSnapshot({
        passwordEnabled: input.fallback.passwordEnabled,
        passwordMinLength: policy.minLength,
        providers: input.fallback.providers,
        degraded: input.fallback.degraded,
        sso,
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
      sso,
    }),
  };
}
