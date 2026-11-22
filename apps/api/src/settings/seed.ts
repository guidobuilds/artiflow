import type { AccessMethodsDocument } from "@artiflow/contracts/settings";

import type { AppConfig, SocialProviders } from "../config.ts";
import type { AppDb } from "../adapters/postgres/db/client.ts";
import { SecretError, writeSecret, type SecretKey } from "./secrets.ts";
import { ACCESS_METHODS_KEY, accessMethodsSetting, readSetting, writeSetting } from "./store.ts";

export const PROVIDERS = ["google", "github"] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export const providerEnvironment = {
  google: { clientId: "ARTIFLOW_AUTH_GOOGLE_CLIENT_ID", clientSecret: "ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET" },
  github: { clientId: "ARTIFLOW_AUTH_GITHUB_CLIENT_ID", clientSecret: "ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET" },
} as const;

export function providerSecretName(provider: ProviderName): string {
  return `${ACCESS_METHODS_KEY}.${provider}.clientSecret`;
}

export function stillSetVariables(env: Record<string, string | undefined>): string[] {
  return PROVIDERS.flatMap((provider) => [
    providerEnvironment[provider].clientId,
    providerEnvironment[provider].clientSecret,
  ]).filter((name) => (env[name] ?? "").trim() !== "");
}

function providerDocument(
  provider: ProviderName,
  credentials: SocialProviders["google"],
): AccessMethodsDocument["providers"]["google"] {
  if (credentials === undefined) return { enabled: false, clientId: "", secretName: "" };
  return { enabled: true, clientId: credentials.clientId, secretName: providerSecretName(provider) };
}

export function environmentAccessMethods(providers: SocialProviders, at: Date): AccessMethodsDocument {
  return {
    password: { enabled: true },
    providers: {
      google: providerDocument("google", providers.google),
      github: providerDocument("github", providers.github),
    },
    provenance: { source: "environment", at: at.toISOString() },
  };
}

function providerSecrets(providers: SocialProviders): { name: string; value: string }[] {
  const secrets: { name: string; value: string }[] = [];
  for (const provider of PROVIDERS) {
    const credentials = providers[provider];
    if (credentials !== undefined)
      secrets.push({ name: providerSecretName(provider), value: credentials.clientSecret });
  }
  return secrets;
}

function requireKey(key: SecretKey | null | undefined): SecretKey {
  if (key === null || key === undefined) {
    throw new SecretError(
      "key_missing",
      "social providers are configured but ARTIFLOW_SECRET_ENCRYPTION_KEY is unset; refusing to store their secrets unprotected.",
    );
  }
  return key;
}

export function accessSeedWarningLine(variables: readonly string[], at: Date): string {
  return JSON.stringify({
    ts: at.toISOString(),
    level: "warn",
    event: "access.seed.skipped",
    reason: "document_exists",
    variables: [...variables],
  });
}

export type SeedAccessMethodsInput = {
  db: AppDb;
  config: AppConfig;
  env?: Record<string, string | undefined>;
  now?: Date;
  write?: (line: string) => void;
};

export type SeedAccessMethodsResult = {
  seeded: boolean;
  warnedVariables: string[];
};

const writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export async function seedAccessMethods(input: SeedAccessMethodsInput): Promise<SeedAccessMethodsResult> {
  const now = input.now ?? new Date();
  const write = input.write ?? writeLine;
  const existing = await readSetting(input.db, accessMethodsSetting);
  if (existing !== null) {
    const variables = stillSetVariables(input.env ?? process.env);
    if (variables.length > 0) write(accessSeedWarningLine(variables, now));
    return { seeded: false, warnedVariables: variables };
  }

  const document = environmentAccessMethods(input.config.authProviders, now);
  const secrets = providerSecrets(input.config.authProviders);
  const key = input.config.secretEncryptionKey;
  if (secrets.length > 0) requireKey(key);

  await input.db.transaction(async (tx) => {
    for (const secret of secrets) {
      await writeSecret(tx, { name: secret.name, value: secret.value, key: requireKey(key), updatedBy: null });
    }
    await writeSetting(tx, accessMethodsSetting, { value: document, expectedRevision: null });
  });

  return { seeded: true, warnedVariables: [] };
}
