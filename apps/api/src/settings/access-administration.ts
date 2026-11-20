import type {
  AccessConfiguration,
  AccessProviderChange,
  UpdateAccessConfigurationRequest,
} from "@artiflow/contracts/admin";
import type { AccessMethodsDocument } from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import type { SocialProviders } from "../config.ts";
import { environmentAccessMethods, PROVIDERS, providerSecretName, type ProviderName } from "./seed.ts";
import { secretConfigured, writeSecret, type SecretKey } from "./secrets.ts";
import {
  accessMethodsSetting,
  readSetting,
  writeSetting,
  type StoredSetting,
} from "./store.ts";

type Query = AppDb | AppTx;

export type AccessConfigurationErrorCode =
  | "provider_client_id_required"
  | "provider_credential_required"
  | "secret_encryption_unconfigured";

export class AccessConfigurationError extends Error {
  override name = "AccessConfigurationError";
  readonly code: AccessConfigurationErrorCode;
  readonly provider: ProviderName;

  constructor(code: AccessConfigurationErrorCode, provider: ProviderName) {
    super(`the ${provider} provider cannot be saved: ${code}`);
    this.code = code;
    this.provider = provider;
  }
}

type ProviderDocument = AccessMethodsDocument["providers"]["google"];

type SecretWrite = { name: string; value: string; key: SecretKey };

function emptyProviders(): AccessConfiguration["providers"] {
  return {
    google: { enabled: false, clientId: "", credentialConfigured: false },
    github: { enabled: false, clientId: "", credentialConfigured: false },
  };
}

async function viewOf(db: Query, stored: StoredSetting<AccessMethodsDocument>): Promise<AccessConfiguration> {
  const providers = emptyProviders();
  for (const provider of PROVIDERS) {
    const entry = stored.value.providers[provider];
    providers[provider] = {
      enabled: entry.enabled,
      clientId: entry.clientId,
      credentialConfigured: entry.secretName.trim() !== "" && (await secretConfigured(db, entry.secretName)),
    };
  }
  return {
    revision: stored.revision,
    passwordEnabled: stored.value.password.enabled,
    providers,
    provenance: stored.value.provenance,
  };
}

export async function readAccessConfiguration(input: {
  db: AppDb;
  providers: SocialProviders;
  now?: Date;
}): Promise<AccessConfiguration> {
  const stored = await readSetting(input.db, accessMethodsSetting);
  if (stored !== null) return await viewOf(input.db, stored);

  const adopted = environmentAccessMethods(input.providers, input.now ?? new Date());
  const providers = emptyProviders();
  for (const provider of PROVIDERS) {
    const entry = adopted.providers[provider];
    providers[provider] = {
      enabled: entry.enabled,
      clientId: entry.clientId,
      credentialConfigured: input.providers[provider] !== undefined,
    };
  }
  return {
    revision: null,
    passwordEnabled: adopted.password.enabled,
    providers,
    provenance: adopted.provenance,
  };
}

async function providerDocument(input: {
  db: AppDb;
  provider: ProviderName;
  change: AccessProviderChange;
  key: SecretKey | null;
  secrets: SecretWrite[];
}): Promise<ProviderDocument> {
  const name = providerSecretName(input.provider);
  const clientId = input.change.clientId.trim();
  const supplied = input.change.clientSecret?.trim() ?? "";
  const stored = await secretConfigured(input.db, name);

  if (input.change.enabled) {
    if (clientId === "") throw new AccessConfigurationError("provider_client_id_required", input.provider);
    if (supplied === "" && !stored) {
      throw new AccessConfigurationError("provider_credential_required", input.provider);
    }
  }

  if (supplied !== "") {
    if (input.key === null) {
      throw new AccessConfigurationError("secret_encryption_unconfigured", input.provider);
    }
    input.secrets.push({ name, value: supplied, key: input.key });
  }

  return {
    enabled: input.change.enabled,
    clientId,
    secretName: supplied !== "" || stored ? name : "",
  };
}

export async function updateAccessConfiguration(input: {
  db: AppDb;
  key: SecretKey | null;
  change: UpdateAccessConfigurationRequest;
  actorId: string;
  now?: Date;
}): Promise<AccessConfiguration> {
  const now = input.now ?? new Date();
  const secrets: SecretWrite[] = [];
  const document: AccessMethodsDocument = {
    password: { enabled: input.change.passwordEnabled },
    providers: { google: { enabled: false, clientId: "", secretName: "" }, github: { enabled: false, clientId: "", secretName: "" } },
    provenance: { source: "administrator", at: now.toISOString() },
  };

  for (const provider of PROVIDERS) {
    document.providers[provider] = await providerDocument({
      db: input.db,
      provider,
      change: input.change.providers[provider],
      key: input.key,
      secrets,
    });
  }

  return await input.db.transaction(async (tx) => {
    for (const secret of secrets) {
      await writeSecret(tx, {
        name: secret.name,
        value: secret.value,
        key: secret.key,
        updatedBy: input.actorId,
      });
    }
    const written = await writeSetting(tx, accessMethodsSetting, {
      value: document,
      expectedRevision: input.change.revision,
      updatedBy: input.actorId,
    });
    return await viewOf(tx, written);
  });
}
