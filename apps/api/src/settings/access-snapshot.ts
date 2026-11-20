import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { SocialProviders } from "../config.ts";
import { SecretError, readSecret, type SecretKey } from "./secrets.ts";
import { PROVIDERS, type ProviderName } from "./seed.ts";
import { accessMethodsSetting, readSetting } from "./store.ts";

export type SnapshotProvider = { readonly clientId: string; readonly clientSecret: string };

export type AccessSnapshot = {
  readonly passwordEnabled: boolean;
  readonly providers: Readonly<Partial<Record<ProviderName, SnapshotProvider>>>;
  readonly degraded: readonly ProviderName[];
};

export type AccessSnapshotRead = {
  revision: number | null;
  snapshot: AccessSnapshot;
};

type SnapshotInput = {
  passwordEnabled: boolean;
  providers: Partial<Record<ProviderName, SnapshotProvider>>;
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
    providers: Object.freeze(providers),
    degraded: Object.freeze([...(input.degraded ?? [])]),
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
  return freezeSnapshot({ passwordEnabled: true, providers });
}

export async function readAccessSnapshot(input: {
  db: AppDb | AppTx;
  key: SecretKey | null;
  fallback: AccessSnapshot;
}): Promise<AccessSnapshotRead> {
  const stored = await readSetting(input.db, accessMethodsSetting);
  if (stored === null) return { revision: null, snapshot: input.fallback };

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
    revision: stored.revision,
    snapshot: freezeSnapshot({ passwordEnabled: stored.value.password.enabled, providers, degraded }),
  };
}
