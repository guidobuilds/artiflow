import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { SSO_CONNECTION_KEY, readRawSettingValue } from "./store.ts";

export type SsoConnection = {
  readonly enabled: boolean;
  readonly displayName: string | null;
};

export const SSO_CONNECTION_OFF: SsoConnection = Object.freeze({ enabled: false, displayName: null });

function displayNameOf(document: Record<string, unknown>): string | null {
  const candidate = document.displayName;
  if (typeof candidate !== "string") return null;
  const name = candidate.trim();
  return name === "" ? null : name;
}

export function ssoConnectionFromValue(value: unknown): SsoConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return SSO_CONNECTION_OFF;
  const document = value as Record<string, unknown>;
  if (document.enabled !== true) return SSO_CONNECTION_OFF;
  return Object.freeze({ enabled: true, displayName: displayNameOf(document) });
}

export async function readSsoConnection(db: AppDb | AppTx): Promise<SsoConnection> {
  return ssoConnectionFromValue(await readRawSettingValue(db, SSO_CONNECTION_KEY));
}
