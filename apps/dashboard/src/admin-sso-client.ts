import { manageRequest } from "./auth-client.ts";

export const SSO_PATH = "/api/admin/sso";

export type SsoConnectionView = {
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  credentialConfigured: boolean;
  scopes: string[];
  jitProvisioning: boolean;
  allowedDomains: string[];
  acceptAnyAccount: boolean;
  acceptAnyAccountWarning: string;
};

export type SsoReadiness = { signInAvailable: boolean };

export type SsoConnectionConfiguration = {
  revision: number | null;
  connection: SsoConnectionView;
  redirectUri: string;
  readiness: SsoReadiness;
  provenance: { source: string; at: string } | null;
};

export type SsoConnectionDraft = {
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  jitProvisioning: boolean;
  allowedDomains: string[];
  acceptAnyAccount: boolean;
};

export type UpdateSsoPayload = {
  revision: number | null;
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  jitProvisioning: boolean;
  allowedDomains: string[];
  acceptAnyAccount: boolean;
};

export type SsoReadFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type SsoRead = { ok: true; value: SsoConnectionConfiguration } | SsoReadFailure;
export type SsoSaveFailure = SsoReadFailure & {
  conflict: boolean;
  refreshed: SsoConnectionConfiguration | null;
};
export type SsoSave = { ok: true; value: SsoConnectionConfiguration } | SsoSaveFailure;

const SIGN_IN_REQUIRED =
  "This browser has no signed-in account, so the enterprise connection cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was saved.";

const REFUSALS: Record<string, string> = {
  administrator_required:
    "Only an administrator can manage the enterprise connection. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  revision_conflict:
    "Another administrator saved a change first. The page now shows what is stored; review it and save again.",
  invalid_body: "The server refused the request as incomplete. Nothing was saved.",
  secret_encryption_unconfigured:
    "This instance has no encryption key, so a credential cannot be stored. Add ARTIFLOW_SECRET_ENCRYPTION_KEY (32 bytes, base64) to the environment and restart the API, then save again.",
  sso_sign_in_unavailable:
    "This build cannot sign in through the connection yet, so it cannot be enabled: enabling it now would " +
    "lock every non-administrator out of password and social sign-in. Save it disabled and enable it once " +
    "sign-in through it exists.",
  sso_display_name_required:
    "Enabling the connection needs the display name people will see on the sign-in page. Nothing was saved.",
  sso_client_id_required: "Enabling the connection needs its client id. Nothing was saved.",
  sso_credential_required: "Enabling the connection needs a stored client secret. Enter it, then save again.",
  sso_issuer_insecure:
    "The issuer must be an HTTPS address. Use the https:// address your identity provider publishes.",
  sso_issuer_invalid:
    "The issuer must be one concrete HTTPS address, without placeholders. Copy it from a single application registration.",
  sso_issuer_templated:
    "That authority serves several organizations, so it does not identify the authorized tenant. Register a " +
    "single-tenant application and use its tenant-scoped issuer, for example " +
    "https://login.microsoftonline.com/your-tenant-id/v2.0. Nothing was saved.",
  sso_issuer_mismatch:
    "The discovery document advertises an issuer other than the address given. Use exactly the issuer the provider publishes.",
  sso_discovery_unreachable:
    "The identity provider could not be reached to read its discovery document, so nothing was saved. " +
    "Check the address and this server's network access, then save again.",
  sso_discovery_invalid:
    "That address did not answer with an OIDC discovery document, so nothing was saved. Check the issuer with your provider.",
  sso_scopes_invalid: "The connection needs at least one requested scope, such as openid. Nothing was saved.",
  sso_domain_required:
    "Just-in-time provisioning needs at least one allowed domain. Add the domain people sign in with, or turn provisioning off.",
  sso_domain_invalid:
    "Allowed domains must be bare hostnames, such as example.com: no scheme, path, wildcard or email address.",
  network: "The server could not be reached, so nothing was saved.",
  unreadable_answer: "The server answered unexpectedly, so nothing was saved.",
};

export const SSO_REFUSAL_CODES: readonly string[] = Object.freeze(Object.keys(REFUSALS));

export function ssoRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

export const READINESS_BLOCKED =
  "This build cannot sign in through the connection yet. The document can be saved and edited, but it " +
  "cannot be published as enabled: doing that now would lock every non-administrator out of password and " +
  "social sign-in. It can be enabled once sign-in through it exists.";

export function readinessStatement(readiness: SsoReadiness): string | null {
  return readiness.signInAvailable ? null : READINESS_BLOCKED;
}

export function connectionStateLabel(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

const PROVENANCE_SOURCES: Record<string, string> = {
  administrator: "Set by an administrator",
  environment: "Adopted from the environment",
};

export function ssoProvenanceLabel(provenance: SsoConnectionConfiguration["provenance"]): string {
  if (provenance === null) return "Not stored yet.";
  const day = /^\d{4}-\d{2}-\d{2}/.test(provenance.at) ? provenance.at.slice(0, 10) : "an unknown date";
  const source = PROVENANCE_SOURCES[provenance.source] ?? `Set from ${provenance.source}`;
  return `${source} on ${day}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry): entry is string => typeof entry === "string") ? [...value] : null;
}

function toConnectionView(value: unknown): SsoConnectionView | null {
  if (!isRecord(value)) return null;
  const { enabled, displayName, issuer, clientId, credentialConfigured, jitProvisioning, acceptAnyAccount } = value;
  if (typeof enabled !== "boolean" || typeof displayName !== "string" || typeof issuer !== "string") return null;
  if (typeof clientId !== "string" || typeof credentialConfigured !== "boolean") return null;
  if (typeof jitProvisioning !== "boolean" || typeof acceptAnyAccount !== "boolean") return null;
  const scopes = stringsOf(value.scopes);
  const allowedDomains = stringsOf(value.allowedDomains);
  const warning = value.acceptAnyAccountWarning;
  if (scopes === null || allowedDomains === null) return null;
  if (typeof warning !== "string" || warning === "") return null;
  return {
    enabled,
    displayName,
    issuer,
    clientId,
    credentialConfigured,
    scopes,
    jitProvisioning,
    allowedDomains,
    acceptAnyAccount,
    acceptAnyAccountWarning: warning,
  };
}

export function parseSsoConnectionConfiguration(body: unknown): SsoConnectionConfiguration | null {
  if (!isRecord(body)) return null;
  const revision = body.revision;
  const validRevision =
    revision === null || (typeof revision === "number" && Number.isInteger(revision) && revision > 0);
  if (!validRevision) return null;
  const connection = toConnectionView(body.connection);
  if (connection === null) return null;
  if (typeof body.redirectUri !== "string" || body.redirectUri === "") return null;
  if (!isRecord(body.readiness) || typeof body.readiness.signInAvailable !== "boolean") return null;
  const provenance = body.provenance;
  if (provenance !== null) {
    if (!isRecord(provenance)) return null;
    if (typeof provenance.source !== "string" || provenance.source === "") return null;
    if (typeof provenance.at !== "string" || provenance.at === "") return null;
  }
  return {
    revision,
    connection,
    redirectUri: body.redirectUri,
    readiness: { signInAvailable: body.readiness.signInAvailable },
    provenance: provenance === null ? null : { source: String(provenance.source), at: String(provenance.at) },
  };
}

export function parseScopes(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function scopesText(scopes: readonly string[]): string {
  return scopes.join(" ");
}

export function addDomain(domains: readonly string[]): string[] {
  return [...domains, ""];
}

export function updateDomain(domains: readonly string[], index: number, value: string): string[] {
  return domains.map((entry, position) => (position === index ? value.trim() : entry));
}

export function removeDomain(domains: readonly string[], index: number): string[] {
  return domains.filter((_entry, position) => position !== index);
}

export function draftFromConfiguration(configuration: SsoConnectionConfiguration): SsoConnectionDraft {
  return {
    enabled: configuration.connection.enabled,
    displayName: configuration.connection.displayName,
    issuer: configuration.connection.issuer,
    clientId: configuration.connection.clientId,
    clientSecret: "",
    scopes: scopesText(configuration.connection.scopes),
    jitProvisioning: configuration.connection.jitProvisioning,
    allowedDomains: [...configuration.connection.allowedDomains],
    acceptAnyAccount: configuration.connection.acceptAnyAccount,
  };
}

export function buildUpdateSsoPayload(draft: SsoConnectionDraft, revision: number | null): UpdateSsoPayload {
  const secret = draft.clientSecret.trim();
  const domains = draft.allowedDomains.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  return {
    revision,
    enabled: draft.enabled,
    displayName: draft.displayName.trim(),
    issuer: draft.issuer.trim(),
    clientId: draft.clientId.trim(),
    ...(secret === "" ? {} : { clientSecret: secret }),
    scopes: parseScopes(draft.scopes),
    jitProvisioning: draft.jitProvisioning,
    allowedDomains: domains,
    acceptAnyAccount: draft.acceptAnyAccount,
  };
}

export async function readSsoConnectionConfiguration(): Promise<SsoRead> {
  const result = await manageRequest(SSO_PATH, "GET", parseSsoConnectionConfiguration);
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: ssoRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function saveSsoConnection(draft: SsoConnectionDraft, revision: number | null): Promise<SsoSave> {
  const result = await manageRequest(
    SSO_PATH,
    "PUT",
    parseSsoConnectionConfiguration,
    buildUpdateSsoPayload(draft, revision),
  );
  if (result.ok) return result;
  if (result.code === "revision_conflict") {
    const refreshed = await readSsoConnectionConfiguration();
    return {
      ok: false,
      code: result.code,
      error: ssoRefusalMessage(result.code),
      signInRequired: result.signInRequired,
      conflict: true,
      refreshed: refreshed.ok ? refreshed.value : null,
    };
  }
  return {
    ok: false,
    code: result.code,
    error: ssoRefusalMessage(result.code),
    signInRequired: result.signInRequired,
    conflict: false,
    refreshed: null,
  };
}
