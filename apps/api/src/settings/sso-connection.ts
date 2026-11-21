import { SSO_DEFAULT_SCOPES, type SsoConnectionDocument } from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { SSO_CONNECTION_KEY, readRawSettingValue } from "./store.ts";

export type SsoConnection = {
  readonly enabled: boolean;
  readonly displayName: string | null;
};

export const SSO_CONNECTION_OFF: SsoConnection = Object.freeze({ enabled: false, displayName: null });

export const SSO_CONNECTION_PROVIDER_ID = "artiflow";

export const SSO_SIGN_IN_AVAILABLE = false;

export function ssoSecretName(): string {
  return `${SSO_CONNECTION_KEY}.clientSecret`;
}

export function ssoRedirectUri(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}/api/auth/sso/callback/${SSO_CONNECTION_PROVIDER_ID}`;
}

function displayNameOf(document: Record<string, unknown>): string | null {
  const candidate = document.displayName;
  if (typeof candidate !== "string") return null;
  const name = candidate.trim();
  return name === "" ? null : name;
}

function textOf(document: Record<string, unknown>, field: string): string {
  const candidate = document[field];
  return typeof candidate === "string" ? candidate : "";
}

function textsOf(document: Record<string, unknown>, field: string): string[] {
  const candidate = document[field];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is string => typeof entry === "string");
}

function flagOf(document: Record<string, unknown>, field: string): boolean {
  return document[field] === true;
}

export function ssoConnectionFromValue(value: unknown): SsoConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return SSO_CONNECTION_OFF;
  const document = value as Record<string, unknown>;
  if (document.enabled !== true) return SSO_CONNECTION_OFF;
  return Object.freeze({ enabled: true, displayName: displayNameOf(document) });
}

export type SsoStoredConnection = Omit<SsoConnectionDocument, "provenance">;

export function ssoStoredConnectionFromValue(value: unknown): SsoStoredConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      enabled: false,
      displayName: "",
      issuer: "",
      clientId: "",
      clientSecretName: "",
      scopes: [...SSO_DEFAULT_SCOPES],
      jitProvisioning: false,
      allowedDomains: [],
      acceptAnyAccount: false,
    };
  }
  const document = value as Record<string, unknown>;
  const scopes = textsOf(document, "scopes");
  return {
    enabled: document.enabled === true,
    displayName: textOf(document, "displayName"),
    issuer: textOf(document, "issuer"),
    clientId: textOf(document, "clientId"),
    clientSecretName: textOf(document, "clientSecretName"),
    scopes: scopes.length === 0 ? [...SSO_DEFAULT_SCOPES] : scopes,
    jitProvisioning: flagOf(document, "jitProvisioning"),
    allowedDomains: textsOf(document, "allowedDomains"),
    acceptAnyAccount: flagOf(document, "acceptAnyAccount"),
  };
}

export async function readSsoConnection(db: AppDb | AppTx): Promise<SsoConnection> {
  return ssoConnectionFromValue(await readRawSettingValue(db, SSO_CONNECTION_KEY));
}
