import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createSdkAuth, Unauthorized, type SavedAuth, type SdkAuth } from "@artiflow/sdk/auth";
import { createArtifactApi, type ArtifactApi } from "./api.ts";

export type { SavedAuth };
export type AuthStorage = { get(key: string): Promise<unknown>; set(key: string, value: SavedAuth): Promise<void> };

export const scope = "artifacts:read artifacts:write offline_access";

export async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not open browser for Artiflow consent")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Could not open browser for Artiflow consent")),
    );
  });
}

export function registrationBody(input: { redirectUri: string; scope: string; resource: string }) {
  return {
    redirect_uris: [input.redirectUri],
    client_name: "Artiflow OpenCode",
    application_type: "native",
    token_endpoint_auth_method: "none",
    scope: input.scope,
    resources: [input.resource],
  };
}

export function authorizationUrl(input: {
  origin: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: input.resource,
  });
  return `${input.origin}/api/auth/oauth2/authorize?${params}`;
}

type ConsentInput = { origin: string; scope: string; resource: string };

export type ConsentFlow = (input: ConsentInput, signal?: AbortSignal) => Promise<SavedAuth>;

function loopbackConsent(request: typeof fetch, browse: typeof openBrowser) {
  const exchange = async (origin: string, params: Record<string, string>) => {
    const response = await request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Artiflow OAuth token request failed (HTTP ${response.status})`);
    const tokens = (await response.json()) as SavedAuth["tokens"];
    if (!tokens.access_token) throw new Error("Artiflow OAuth returned no access_token");
    return tokens;
  };

  return async (input: ConsentInput, signal?: AbortSignal): Promise<SavedAuth> => {
    const state = randomUUID();
    const verifier = randomBytes(32).toString("base64url");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Artiflow OAuth loopback unavailable");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    let onAbort: () => void = () => {};
    try {
      const response = await request(`${input.origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: input.origin },
        signal: timeout,
        body: JSON.stringify(registrationBody({ redirectUri, scope: input.scope, resource: input.resource })),
      });
      if (response.status !== 201) throw new Error(`Artiflow OAuth registration failed (HTTP ${response.status})`);
      const client = (await response.json()) as { client_id: string };
      if (!client.client_id) throw new Error("Artiflow OAuth registration returned no client_id");
      const code = new Promise<string>((resolve, reject) => {
        onAbort = () => reject(new Error("Artiflow OAuth consent cancelled or timed out"));
        timeout.addEventListener("abort", onAbort, { once: true });
        if (timeout.aborted) onAbort();
        server.on("request", (request, reply) => {
          const url = new URL(request.url ?? "/", redirectUri);
          if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
            reply.writeHead(400).end("Invalid OAuth callback");
            return;
          }
          const value = url.searchParams.get("code");
          reply.setHeader("connection", "close");
          reply
            .writeHead(200, { "content-type": "text/plain" })
            .end("Artiflow authorization received. You can close this tab.");
          if (value) resolve(value);
          else reject(new Error("Artiflow OAuth consent returned no code"));
        });
      });
      const [, authorizationCode] = await Promise.all([
        browse(
          authorizationUrl({
            origin: input.origin,
            clientId: client.client_id,
            redirectUri,
            scope: input.scope,
            resource: input.resource,
            state,
            codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          }),
        ),
        code,
      ]);
      const tokens = await exchange(input.origin, {
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      });
      return { client, tokens };
    } finally {
      timeout.removeEventListener("abort", onAbort);
      server.closeAllConnections();
      server.close();
    }
  };
}

export class ArtiflowAuth {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly base: string;
  private readonly request: typeof fetch;
  private readonly consenting: SdkAuth;
  private readonly silent: SdkAuth;
  private readonly reauthorize: SdkAuth;

  constructor(
    base: string,
    storage: AuthStorage,
    request: typeof fetch = fetch,
    browse = openBrowser,
    flow: ConsentFlow = loopbackConsent(request, browse),
  ) {
    this.base = base;
    this.request = request;
    const common = {
      origin: base,
      storage,
      fetch: request,
      scope,
      resource: `${base}/api/v1`,
      clientName: "Artiflow OpenCode",
    };
    this.consenting = createSdkAuth({ ...common, authorize: flow });
    this.silent = createSdkAuth(common);
    this.reauthorize = createSdkAuth({
      ...common,
      storage: { get: async () => undefined, set: (key, value) => storage.set(key, value) },
      authorize: flow,
    });
  }

  api<T>(operation: (api: ArtifactApi) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(() =>
      this.consenting.authorized(
        (token) =>
          operation(createArtifactApi({ base: this.base, token, request: this.request, signal })),
        signal,
      ),
    );
  }

  viewerToken(): Promise<string | null> {
    return this.enqueue(async () => {
      try {
        const token = await this.silent.authorized<string | null>((access) => this.proven(access));
        return token ?? null;
      } catch {
        return null;
      }
    });
  }

  consent(): Promise<{ token: string } | { error: string }> {
    return this.enqueue(async () => {
      try {
        return { token: await this.consenting.authorized((access) => this.proven(access)) };
      } catch {
      }
      try {
        return { token: await this.reauthorize.authorized((access) => this.proven(access)) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Artiflow sign-in failed." };
      }
    });
  }

  private async proven(access: string): Promise<string> {
    try {
      await createArtifactApi({ base: this.base, token: access, request: this.request }).probe();
    } catch {
      throw new Unauthorized("Artiflow viewer token probe failed");
    }
    return access;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
}
