export class Unauthorized extends Error {
  override name = "Unauthorized";
}

export type OAuthTokens = { access_token: string; refresh_token?: string };
export type SavedAuth = { client: { client_id: string }; tokens: OAuthTokens };
export type AuthStorage = { get(key: string): Promise<unknown>; set(key: string, value: SavedAuth): Promise<void> };

export type ConsentFlow = (
  input: { origin: string; scope: string; resource: string },
  signal?: AbortSignal,
) => Promise<SavedAuth>;

export type SdkAuthOptions = {
  origin: string;
  storage: AuthStorage;
  fetch?: typeof fetch;
  scope?: string;
  resource?: string;
  clientName?: string;
  authorize?: ConsentFlow;
};

const DEFAULT_SCOPE = "artifacts:read artifacts:write";
const TOKEN_TIMEOUT_MS = 30_000;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function storageKey(origin: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin));
  return `sdk-auth:${toBase64Url(new Uint8Array(digest))}`;
}

export type SdkAuth = {
  options: { scope: string; resource: string };
  authorized<T>(operation: (token: string) => Promise<T>, signal?: AbortSignal): Promise<T>;
  register(signal?: AbortSignal): Promise<{ client: { client_id: string } }>;
};

export function createSdkAuth(options: SdkAuthOptions): SdkAuth {
  const request = options.fetch ?? fetch;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const resource = options.resource ?? `${options.origin.replace(/\/$/, "")}/api/v1`;
  let pending: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };

  const token = async (params: Record<string, string>, signal?: AbortSignal): Promise<OAuthTokens> => {
    const signalWithTimeout = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
      : AbortSignal.timeout(TOKEN_TIMEOUT_MS);
    const response = await request(`${options.origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: signalWithTimeout,
    });
    if (!response.ok) throw new Error(`Artiflow OAuth token request failed (HTTP ${response.status})`);
    const tokens = (await response.json()) as OAuthTokens;
    if (!tokens.access_token) throw new Error("Artiflow OAuth returned no access_token");
    return tokens;
  };

  const authorize = options.authorize
    ? (signal?: AbortSignal) => options.authorize!({ origin: options.origin, scope, resource }, signal)
    : undefined;

  const register = async (signal?: AbortSignal): Promise<{ client: { client_id: string } }> => {
    const signalWithTimeout = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
      : AbortSignal.timeout(TOKEN_TIMEOUT_MS);
    const response = await request(`${options.origin}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: options.clientName ?? "Artiflow client",
        application_type: "native",
        token_endpoint_auth_method: "none",
        scope,
        resources: [resource],
      }),
      signal: signalWithTimeout,
    });
    if (response.status !== 201) throw new Error(`Artiflow OAuth registration failed (HTTP ${response.status})`);
    const client = (await response.json()) as { client_id: string };
    if (!client.client_id) throw new Error("Artiflow OAuth registration returned no client_id");
    return { client };
  };

  const silentAuth = async <T>(operation: (token: string) => Promise<T>): Promise<T | null> => {
    const saved = (await options.storage.get(await storageKey(options.origin))) as SavedAuth | undefined;
    if (!saved) return null;
    try {
      return await operation(saved.tokens.access_token);
    } catch (error) {
      if (!(error instanceof Unauthorized)) throw error;
    }
    if (!saved.tokens.refresh_token) return null;
    const rotated = {
      client: saved.client,
      tokens: await token({
        grant_type: "refresh_token",
        refresh_token: saved.tokens.refresh_token,
        client_id: saved.client.client_id,
      }),
    };
    await options.storage.set(await storageKey(options.origin), rotated);
    return operation(rotated.tokens.access_token);
  };

  return {
    options: { scope, resource },
    authorized: <T>(operation: (token: string) => Promise<T>, signal?: AbortSignal): Promise<T> =>
      enqueue(async () => {
        const silent = await silentAuth(operation);
        if (silent !== null) return silent;
        if (!authorize) return null as unknown as T;
        const saved = await authorize(signal);
        await options.storage.set(await storageKey(options.origin), saved);
        return operation(saved.tokens.access_token);
      }),
    register,
  };
}
