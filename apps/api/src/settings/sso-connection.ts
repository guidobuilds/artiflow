import { SSO_DEFAULT_SCOPES, type SsoConnectionDocument } from "@artiflow/contracts/settings";

import type { AppDb, AppTx } from "../adapters/postgres/db/client.ts";
import { SSO_CONNECTION_KEY, readRawSettingValue } from "./store.ts";

export type SsoConnection = {
  readonly enabled: boolean;
  readonly displayName: string | null;
};

export const SSO_CONNECTION_OFF: SsoConnection = Object.freeze({ enabled: false, displayName: null });

export const SSO_CONNECTION_PROVIDER_ID = "artiflow";

export const SSO_SIGN_IN_AVAILABLE = true;

export type SsoIssuerProblem = "sso_issuer_insecure" | "sso_issuer_invalid" | "sso_issuer_templated";

const TEMPLATE_MARKER = /[{}<>]/;
const MULTI_TENANT_AUTHORITIES = new Set(["common", "organizations", "consumers"]);

export function ssoIssuerProblem(value: string): SsoIssuerProblem | null {
  if (TEMPLATE_MARKER.test(value)) return "sso_issuer_templated";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "sso_issuer_invalid";
  }
  if (url.protocol !== "https:") return "sso_issuer_insecure";
  if (url.search !== "" || url.hash !== "") return "sso_issuer_invalid";
  const multiTenant = url.pathname
    .split("/")
    .some((segment) => MULTI_TENANT_AUTHORITIES.has(segment.trim().toLowerCase()));
  return multiTenant ? "sso_issuer_templated" : null;
}

export function ssoIssuerOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export type SsoProviderRegistration = {
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly domain: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly jitProvisioning: boolean;
  readonly acceptAnyAccount: boolean;
};

export function ssoSecretName(): string {
  return `${SSO_CONNECTION_KEY}.clientSecret`;
}

export function ssoRedirectUri(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}/api/auth/sso/callback/${SSO_CONNECTION_PROVIDER_ID}`;
}

export function ssoDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

const TENANT_VERSION_SEGMENT = /^v\d+(?:\.\d+)?$/;

export function ssoPinnedTenant(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const last = segments.at(-1);
  if (last !== undefined && TENANT_VERSION_SEGMENT.test(last.toLowerCase())) segments.pop();
  const tenant = segments.at(-1);
  return tenant === undefined ? null : tenant.toLowerCase();
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

export function ssoProviderRegistration(value: unknown, clientSecret: string | null): SsoProviderRegistration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.enabled !== true) return null;
  const issuer = textOf(document, "issuer").trim();
  const clientId = textOf(document, "clientId").trim();
  const credential = (clientSecret ?? "").trim();
  const scopes = textsOf(document, "scopes")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  if (issuer === "" || ssoIssuerProblem(issuer) !== null) return null;
  if (clientId === "" || credential === "" || scopes.length === 0) return null;
  const allowedDomains = textsOf(document, "allowedDomains")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "");
  return Object.freeze({
    issuer,
    discoveryUrl: ssoDiscoveryUrl(issuer),
    domain: allowedDomains[0] ?? new URL(issuer).hostname.toLowerCase(),
    clientId,
    clientSecret: credential,
    scopes: Object.freeze([...scopes]),
    allowedDomains: Object.freeze([...allowedDomains]),
    jitProvisioning: flagOf(document, "jitProvisioning"),
    acceptAnyAccount: flagOf(document, "acceptAnyAccount"),
  });
}
