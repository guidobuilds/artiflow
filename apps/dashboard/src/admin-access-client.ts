import { manageRequest } from "./auth-client.ts";

export type AccessProviderName = "google" | "github";
export type AccessProviderView = { enabled: boolean; clientId: string; credentialConfigured: boolean };
export type AccessProviderRegistration = {
  origin: string;
  redirectUris: Record<AccessProviderName, string>;
};
export type AccessConfiguration = {
  revision: number | null;
  passwordEnabled: boolean;
  providers: Record<AccessProviderName, AccessProviderView>;
  registration: AccessProviderRegistration;
  provenance: { source: string; at: string };
};
export type AccessProviderDraft = { enabled: boolean; clientId: string; clientSecret: string };
export type AccessDraft = { passwordEnabled: boolean; providers: Record<AccessProviderName, AccessProviderDraft> };
export type AccessPayloadProvider = { enabled: boolean; clientId: string; clientSecret?: string };
export type UpdateAccessPayload = {
  revision: number | null;
  passwordEnabled: boolean;
  providers: Record<AccessProviderName, AccessPayloadProvider>;
};
export type AccessReadFailure = { ok: false; code: string; error: string; signInRequired: boolean };
export type AccessRead = { ok: true; value: AccessConfiguration } | AccessReadFailure;
export type AccessSaveFailure = AccessReadFailure & {
  conflict: boolean;
  refreshed: AccessConfiguration | null;
};
export type AccessSave = { ok: true; value: AccessConfiguration } | AccessSaveFailure;

export const ACCESS_PATH = "/api/admin/access";
export const ACCESS_PROVIDERS: { name: AccessProviderName; label: string }[] = [
  { name: "google", label: "Google" },
  { name: "github", label: "GitHub" },
];

const SIGN_IN_REQUIRED =
  "This browser has no signed-in account, so access methods cannot be shown. Sign in first.";
const UNRECOGNIZED = "The server refused that without a reason this page recognizes. Nothing was saved.";

const REFUSALS: Record<string, string> = {
  administrator_required: "Only an administrator can manage access methods. This page is not available to your account.",
  sign_in_required: SIGN_IN_REQUIRED,
  unauthorized: SIGN_IN_REQUIRED,
  revision_conflict:
    "Another administrator saved a change first. The page now shows what is stored; review it and save again.",
  provider_client_id_required: "Enabling a provider needs its client id. Nothing was saved.",
  provider_credential_required:
    "Enabling a provider needs a stored credential. Enter the client secret, then save again.",
  secret_encryption_unconfigured:
    "This instance cannot encrypt a credential because no secret key is configured. Set the encryption key before storing one.",
  invalid_body: "The server refused the request as incomplete. Nothing was saved.",
  network: "The server could not be reached, so nothing was saved.",
  unreadable_answer: "The server answered unexpectedly, so nothing was saved.",
};

export function accessRefusalMessage(code: string): string {
  return REFUSALS[code] ?? UNRECOGNIZED;
}

export function credentialStateLabel(configured: boolean): string {
  return configured ? "Configured" : "Not configured";
}

const PROVENANCE_SOURCES: Record<string, string> = {
  environment: "Adopted from the environment",
  administrator: "Set by an administrator",
};

export function provenanceLabel(provenance: AccessConfiguration["provenance"]): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(provenance.at) ? provenance.at.slice(0, 10) : "an unknown date";
  const source = PROVENANCE_SOURCES[provenance.source] ?? `Set from ${provenance.source}`;
  return `${source} on ${day}.`;
}

export function enabledMethodsLabel(configuration: AccessConfiguration): string {
  const names = [
    ...(configuration.passwordEnabled ? ["Password"] : []),
    ...ACCESS_PROVIDERS.filter((provider) => configuration.providers[provider.name].enabled).map(
      (provider) => provider.label,
    ),
  ];
  if (names.length === 0) return "No sign-in method is enabled.";
  if (names.length === 1) return `${names[0]} sign-in is enabled.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} sign-in are enabled.`;
}

const ORIGIN_SENTENCE = "Use this as the JavaScript origin of the provider's application.";
const CALLBACK_SENTENCE = "Use this as the redirect URI, or callback URL, of that provider's application.";

export const REGISTRATION_NOTES: readonly string[] = [
  "GitHub accepts a single callback per application, while Google accepts several.",
  "The origin has to match exactly the address you open this instance at: localhost and 127.0.0.1 are two different origins, even on the same port.",
];

export type RegistrationEntry = { id: string; label: string; value: string; sentence: string };

export function registrationEntries(
  configuration: Pick<AccessConfiguration, "registration">,
): RegistrationEntry[] {
  return [
    {
      id: "origin",
      label: "JavaScript origin",
      value: configuration.registration.origin,
      sentence: ORIGIN_SENTENCE,
    },
    ...ACCESS_PROVIDERS.map((provider) => ({
      id: provider.name,
      label: `${provider.label} redirect URI`,
      value: configuration.registration.redirectUris[provider.name],
      sentence: CALLBACK_SENTENCE,
    })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toProviderView(value: unknown): AccessProviderView | null {
  if (!isRecord(value)) return null;
  const { enabled, clientId, credentialConfigured } = value;
  if (typeof enabled !== "boolean" || typeof clientId !== "string") return null;
  if (typeof credentialConfigured !== "boolean") return null;
  return { enabled, clientId, credentialConfigured };
}

function toRegistration(value: unknown): AccessProviderRegistration | null {
  if (!isRecord(value)) return null;
  if (typeof value.origin !== "string" || value.origin === "") return null;
  if (!isRecord(value.redirectUris)) return null;
  const { google, github } = value.redirectUris;
  if (typeof google !== "string" || google === "") return null;
  if (typeof github !== "string" || github === "") return null;
  return { origin: value.origin, redirectUris: { google, github } };
}

export function parseAccessConfiguration(body: unknown): AccessConfiguration | null {
  if (!isRecord(body)) return null;
  const revision = body.revision;
  const validRevision =
    revision === null || (typeof revision === "number" && Number.isInteger(revision) && revision > 0);
  if (!validRevision || typeof body.passwordEnabled !== "boolean") return null;
  if (!isRecord(body.providers)) return null;
  const google = toProviderView(body.providers.google);
  const github = toProviderView(body.providers.github);
  if (google === null || github === null) return null;
  const registration = toRegistration(body.registration);
  if (registration === null) return null;
  if (!isRecord(body.provenance)) return null;
  const { source, at } = body.provenance;
  if (typeof source !== "string" || source === "" || typeof at !== "string" || at === "") return null;
  return {
    revision,
    passwordEnabled: body.passwordEnabled,
    providers: { google, github },
    registration,
    provenance: { source, at },
  };
}

export function draftFromConfiguration(configuration: AccessConfiguration): AccessDraft {
  return {
    passwordEnabled: configuration.passwordEnabled,
    providers: {
      google: {
        enabled: configuration.providers.google.enabled,
        clientId: configuration.providers.google.clientId,
        clientSecret: "",
      },
      github: {
        enabled: configuration.providers.github.enabled,
        clientId: configuration.providers.github.clientId,
        clientSecret: "",
      },
    },
  };
}

function providerPayload(provider: AccessProviderDraft): AccessPayloadProvider {
  const clientId = provider.clientId.trim();
  return provider.clientSecret === ""
    ? { enabled: provider.enabled, clientId }
    : { enabled: provider.enabled, clientId, clientSecret: provider.clientSecret };
}

export function buildUpdateAccessPayload(draft: AccessDraft, revision: number | null): UpdateAccessPayload {
  return {
    revision,
    passwordEnabled: draft.passwordEnabled,
    providers: {
      google: providerPayload(draft.providers.google),
      github: providerPayload(draft.providers.github),
    },
  };
}

export async function readAccessConfiguration(): Promise<AccessRead> {
  const result = await manageRequest(ACCESS_PATH, "GET", parseAccessConfiguration);
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    error: accessRefusalMessage(result.code),
    signInRequired: result.signInRequired,
  };
}

export async function saveAccessConfiguration(
  draft: AccessDraft,
  revision: number | null,
): Promise<AccessSave> {
  const result = await manageRequest(
    ACCESS_PATH,
    "PUT",
    parseAccessConfiguration,
    buildUpdateAccessPayload(draft, revision),
  );
  if (result.ok) return result;
  if (result.code === "revision_conflict") {
    const refreshed = await readAccessConfiguration();
    return {
      ok: false,
      code: result.code,
      error: accessRefusalMessage(result.code),
      signInRequired: result.signInRequired,
      conflict: true,
      refreshed: refreshed.ok ? refreshed.value : null,
    };
  }
  return {
    ok: false,
    code: result.code,
    error: accessRefusalMessage(result.code),
    signInRequired: result.signInRequired,
    conflict: false,
    refreshed: null,
  };
}
