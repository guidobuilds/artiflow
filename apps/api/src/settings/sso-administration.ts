import type { SsoConnectionConfiguration, UpdateSsoConnectionRequest } from "@artiflow/contracts/admin";
import { ACCEPT_ANY_ACCOUNT_WARNING, type SsoConnectionDocument } from "@artiflow/contracts/settings";

import type { AppDb } from "../adapters/postgres/db/client.ts";
import { secretConfigured, writeSecret, type SecretKey } from "./secrets.ts";
import {
  SSO_SIGN_IN_AVAILABLE,
  ssoDiscoveryUrl,
  ssoIssuerProblem,
  ssoRedirectUri,
  ssoSecretName,
  ssoStoredConnectionFromValue,
  type SsoStoredConnection,
} from "./sso-connection.ts";
import { SSO_CONNECTION_KEY, readRawSetting, ssoConnectionSetting, writeSetting } from "./store.ts";

export type SsoConfigurationErrorCode =
  | "sso_sign_in_unavailable"
  | "sso_display_name_required"
  | "sso_client_id_required"
  | "sso_credential_required"
  | "sso_issuer_insecure"
  | "sso_issuer_invalid"
  | "sso_issuer_templated"
  | "sso_issuer_mismatch"
  | "sso_discovery_unreachable"
  | "sso_discovery_invalid"
  | "sso_scopes_invalid"
  | "sso_domain_required"
  | "sso_domain_invalid"
  | "secret_encryption_unconfigured";

export class SsoConfigurationError extends Error {
  override name = "SsoConfigurationError";
  readonly code: SsoConfigurationErrorCode;

  constructor(code: SsoConfigurationErrorCode) {
    super(`the enterprise connection cannot be saved: ${code}`);
    this.code = code;
  }
}

export type DiscoveryResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type DiscoveryFetcher = (url: string) => Promise<DiscoveryResponse>;

const DISCOVERY_TIMEOUT_MS = 5_000;
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`);

const fetchDiscovery: DiscoveryFetcher = (url) =>
  globalThis.fetch(url, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });

function normalized(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConcreteIssuer(issuer: string): void {
  const problem = ssoIssuerProblem(issuer);
  if (problem !== null) throw new SsoConfigurationError(problem);
}

async function discoveredIssuer(issuer: string, discover: DiscoveryFetcher): Promise<string> {
  let response: DiscoveryResponse;
  try {
    response = await discover(ssoDiscoveryUrl(issuer));
  } catch {
    throw new SsoConfigurationError("sso_discovery_unreachable");
  }
  if (!response.ok) throw new SsoConfigurationError("sso_discovery_unreachable");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SsoConfigurationError("sso_discovery_invalid");
  }
  const advertised =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).issuer : undefined;
  if (typeof advertised !== "string" || advertised.trim() === "") {
    throw new SsoConfigurationError("sso_discovery_invalid");
  }
  return advertised.trim();
}

async function assertUsableIssuer(issuer: string, discover: DiscoveryFetcher): Promise<void> {
  if (issuer === "") throw new SsoConfigurationError("sso_issuer_invalid");
  assertConcreteIssuer(issuer);
  const advertised = await discoveredIssuer(issuer, discover);
  assertConcreteIssuer(advertised);
  if (normalized(advertised) !== normalized(issuer)) throw new SsoConfigurationError("sso_issuer_mismatch");
}

function scopesOf(entries: readonly string[]): string[] {
  const scopes = entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (scopes.length === 0) throw new SsoConfigurationError("sso_scopes_invalid");
  return scopes;
}

function domainsOf(entries: readonly string[]): string[] {
  const domains: string[] = [];
  for (const entry of entries) {
    const domain = entry.trim().toLowerCase();
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) throw new SsoConfigurationError("sso_domain_invalid");
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function provenanceOf(value: unknown): SsoConnectionConfiguration["provenance"] {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>).provenance;
  if (typeof candidate !== "object" || candidate === null) return null;
  const source = (candidate as Record<string, unknown>).source;
  const at = (candidate as Record<string, unknown>).at;
  if (typeof source !== "string" || source.trim() === "" || typeof at !== "string") return null;
  return { source, at };
}

function viewOf(
  input: {
    publicOrigin: string;
    revision: number | null;
    connection: SsoStoredConnection;
    credentialConfigured: boolean;
    provenance: SsoConnectionConfiguration["provenance"];
  },
): SsoConnectionConfiguration {
  return {
    revision: input.revision,    connection: {
      enabled: input.connection.enabled,
      displayName: input.connection.displayName,
      issuer: input.connection.issuer,
      clientId: input.connection.clientId,
      credentialConfigured: input.credentialConfigured,
      scopes: [...input.connection.scopes],
      jitProvisioning: input.connection.jitProvisioning,
      allowedDomains: [...input.connection.allowedDomains],
      acceptAnyAccount: input.connection.acceptAnyAccount,
      acceptAnyAccountWarning: ACCEPT_ANY_ACCOUNT_WARNING,
    },
    redirectUri: ssoRedirectUri(input.publicOrigin),
    readiness: { signInAvailable: SSO_SIGN_IN_AVAILABLE },
    provenance: input.provenance,
  };
}

export async function readSsoConnectionConfiguration(input: {
  db: AppDb;
  publicOrigin: string;
}): Promise<SsoConnectionConfiguration> {
  const stored = await readRawSetting(input.db, SSO_CONNECTION_KEY);
  const connection = ssoStoredConnectionFromValue(stored?.value ?? null);
  const credentialConfigured =
    connection.clientSecretName.trim() !== "" && (await secretConfigured(input.db, connection.clientSecretName));
  return viewOf({
    publicOrigin: input.publicOrigin,
    revision: stored?.revision ?? null,
    connection,
    credentialConfigured,
    provenance: stored === null ? null : provenanceOf(stored.value),
  });
}

export async function updateSsoConnectionConfiguration(input: {
  db: AppDb;
  key: SecretKey | null;
  change: UpdateSsoConnectionRequest;
  publicOrigin: string;
  actorId: string;
  now?: Date;
  discover?: DiscoveryFetcher;
}): Promise<SsoConnectionConfiguration> {
  const now = input.now ?? new Date();
  const scopes = scopesOf(input.change.scopes);
  const allowedDomains = domainsOf(input.change.allowedDomains);
  const supplied = input.change.clientSecret?.trim() ?? "";
  const storedCredential = await secretConfigured(input.db, ssoSecretName());

  if (input.change.jitProvisioning && allowedDomains.length === 0) {
    throw new SsoConfigurationError("sso_domain_required");
  }
  if (supplied !== "" && input.key === null) throw new SsoConfigurationError("secret_encryption_unconfigured");

  const displayName = input.change.displayName.trim();
  const clientId = input.change.clientId.trim();
  const issuer = input.change.issuer.trim();

  if (input.change.enabled) {
    if (displayName === "") throw new SsoConfigurationError("sso_display_name_required");
    if (clientId === "") throw new SsoConfigurationError("sso_client_id_required");
    if (supplied === "" && !storedCredential) throw new SsoConfigurationError("sso_credential_required");
    await assertUsableIssuer(issuer, input.discover ?? fetchDiscovery);
    if (!SSO_SIGN_IN_AVAILABLE) throw new SsoConfigurationError("sso_sign_in_unavailable");
  }

  const document: SsoConnectionDocument = {
    enabled: input.change.enabled,
    displayName,
    issuer,
    clientId,
    clientSecretName: supplied !== "" || storedCredential ? ssoSecretName() : "",
    scopes,
    jitProvisioning: input.change.jitProvisioning,
    allowedDomains,
    acceptAnyAccount: input.change.acceptAnyAccount,
    provenance: { source: "administrator", at: now.toISOString() },
  };

  return await input.db.transaction(async (tx) => {
    if (supplied !== "" && input.key !== null) {
      await writeSecret(tx, { name: ssoSecretName(), value: supplied, key: input.key, updatedBy: input.actorId });
    }
    const written = await writeSetting(tx, ssoConnectionSetting, {
      value: document,
      expectedRevision: input.change.revision,
      updatedBy: input.actorId,
    });
    return viewOf({
      publicOrigin: input.publicOrigin,
      revision: written.revision,
      connection: ssoStoredConnectionFromValue(document),
      credentialConfigured: await secretConfigured(tx, ssoSecretName()),
      provenance: document.provenance,
    });
  });
}
