import assert from "node:assert/strict";

import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { SSO_CONNECTION_PROVIDER_ID } from "../../apps/api/src/settings/sso-connection.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_LIFETIME_SECONDS = 300;

export type IdpProfile = {
  subject: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
};

export type DiscoveryMode = "ok" | "broken" | "mismatched_issuer";

export type FakeIdentityProvider = {
  issuer: string;
  origin: string;
  setProfile(profile: IdpProfile): void;
  setDiscovery(mode: DiscoveryMode): void;
  requests(): string[];
  close(): Promise<void>;
};

type IdpOptions = {
  clientId: string;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const candidate = (input as { url?: unknown } | null)?.url;
  return typeof candidate === "string" ? candidate : "";
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown, headers = {}): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(payload);
}

export async function startFakeIdentityProvider(options: IdpOptions): Promise<FakeIdentityProvider> {
  const issuerOrigin = `https://idp-${randomUUID().slice(0, 8)}.example.test`;
  const issuer = `${issuerOrigin}/tenant-a`;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicJwk = keys.publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
  const kid = `idp-key-${randomUUID().slice(0, 8)}`;
  let profile: IdpProfile = { subject: `idp-subject-${randomUUID()}`, email: `person-${randomUUID()}@acme.example.test` };
  let discovery: DiscoveryMode = "ok";
  const seen: string[] = [];
  let origin = "";

  function idToken(claims: IdpProfile): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64url(
      JSON.stringify({
        iss: issuer,
        aud: options.clientId,
        sub: claims.subject,
        email: claims.email,
        email_verified: claims.emailVerified === true,
        name: claims.name ?? "Enterprise Person",
        iat: now,
        exp: now + TOKEN_LIFETIME_SECONDS,
      }),
    );
    const signature = createSign("SHA256").update(`${header}.${payload}`).sign(privatePem);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  function discoveryBody(): unknown {
    const advertised = discovery === "mismatched_issuer" ? `${issuerOrigin}/tenant-b` : issuer;
    return {
      issuer: advertised,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    };
  }

  function tokens(): unknown {
    return {
      access_token: `idp-access-${randomUUID()}`,
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      scope: "openid profile email",
      id_token: idToken(profile),
    };
  }

  const server: Server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    seen.push(`${incoming.method ?? "GET"} ${url.pathname}`);
    incoming.resume();
    const path = url.pathname;
    if (path.endsWith("/.well-known/openid-configuration")) {
      if (discovery === "broken") {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("discovery unavailable");
        return;
      }
      send(response, 200, discoveryBody());
      return;
    }
    if (path === "/tenant-a/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const code = `idp-code-${randomUUID()}`;
      response.writeHead(302, {
        location: `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      });
      response.end();
      return;
    }
    if (path === "/tenant-a/token" && incoming.method === "POST") {
      send(response, 200, tokens());
      return;
    }
    if (path === "/tenant-a/jwks") {
      send(response, 200, { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
      return;
    }
    send(response, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && "port" in address, true);
  origin = `http://127.0.0.1:${(address as { port: number }).port}`;

  const realFetch = globalThis.fetch;
  const bound = realFetch.bind(globalThis);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const target = textOf(input);
    if (!target.startsWith(issuerOrigin)) return await bound(input as Parameters<typeof fetch>[0], init);
    const rewritten = `${origin}${target.slice(issuerOrigin.length)}`;
    return await bound(rewritten as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;

  return {
    issuer,
    origin,
    setProfile(next) {
      profile = next;
    },
    setDiscovery(mode) {
      discovery = mode;
    },
    requests: () => [...seen],
    async close() {
      globalThis.fetch = realFetch;
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    },
  };
}

export type SsoStart = {
  status: number;
  body: string;
  url: string;
  state: string;
  cookie: string;
};

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .filter((value) => value !== "")
    .join("; ");
}

export async function beginSsoSignIn(
  baseUrl: string,
  origin: string,
  body: { callbackURL: string; errorCallbackURL?: string },
): Promise<SsoStart> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/sso`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ providerId: SSO_CONNECTION_PROVIDER_ID, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.text();
  const parsed = (() => {
    try {
      return JSON.parse(payload) as { url?: unknown; redirect?: unknown };
    } catch {
      return null;
    }
  })();
  const url = parsed !== null && typeof parsed.url === "string" ? parsed.url : "";
  const state = url === "" ? "" : (new URL(url).searchParams.get("state") ?? "");
  return { status: response.status, body: payload, url, state, cookie: cookiesOf(response) };
}

export type SsoCallback = {
  status: number;
  location: string;
  sessionCookie: string;
};

export async function completeSsoCallback(
  baseUrl: string,
  input: { state: string; cookie: string; code?: string },
): Promise<SsoCallback> {
  const query = new URLSearchParams({ code: input.code ?? "fake-authorization-code", state: input.state });
  const response = await fetch(
    `${baseUrl}/api/auth/sso/callback/${SSO_CONNECTION_PROVIDER_ID}?${query.toString()}`,
    {
      redirect: "manual",
      headers: { cookie: input.cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const sessionCookie =
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("artiflow.session_token=") && value.length > "artiflow.session_token=".length) ??
    "";
  return { status: response.status, location: response.headers.get("location") ?? "", sessionCookie };
}

export function failureOf(location: string): { error: string; description: string } {
  const url = new URL(location, "http://placeholder.test");
  return {
    error: url.searchParams.get("error") ?? "",
    description: url.searchParams.get("error_description") ?? "",
  };
}
