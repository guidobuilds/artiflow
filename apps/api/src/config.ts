export type NodeEnv = "development" | "production" | "test";

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type ApiHost = "127.0.0.1" | "0.0.0.0";

export type SocialCredentials = { clientId: string; clientSecret: string };
export type SocialProviders = { github?: SocialCredentials; google?: SocialCredentials };

export type AppConfig = {
  nodeEnv: NodeEnv;
  apiHost: ApiHost;
  apiPort: number;
  publicOrigin: string;
  allowedHosts: string[];
  internalOrigin: string;
  demoAuth: boolean;
  authSecret: string;
  authProviders: SocialProviders;
  databaseUrl: string;
  storage: StorageConfig;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

const NODE_ENVS: NodeEnv[] = ["development", "production", "test"];

function fail(message: string): never {
  throw new ConfigError(message);
}

function read(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

const SECRET_PLACEHOLDER_MARKERS = [
  "replace-with",
  "replace_with",
  "replace-me",
  "replace_me",
  "changeme",
  "change-me",
  "change_me",
  "changethis",
  "change-this",
  "placeholder",
  "openssl",
  "rand-hex",
  "your-secret",
  "your_secret",
  "yoursecret",
  "dummy",
  "fixme",
];

function isWeakSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  if (SECRET_PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))) return true;
  if (new Set(normalized).size < 8) return true;
  const half = value.length / 2;
  if (Number.isInteger(half) && value.slice(0, half) === value.slice(half)) return true;
  for (let period = 2; period <= 8; period += 1) {
    if (value.length % period !== 0) continue;
    if (value === value.slice(0, period).repeat(value.length / period)) return true;
  }
  return false;
}

const DATABASE_TLS_SSLMODES = ["require", "verify-ca", "verify-full"];

function assertProductionDatabaseTls(databaseUrl: string): void {
  let sslmode: string | null;
  try {
    sslmode = new URL(databaseUrl).searchParams.get("sslmode");
  } catch {
    fail(
      "DATABASE_URL must be a valid postgres:// connection URL in production; " +
        "append ?sslmode=verify-full so the server certificate is verified.",
    );
  }
  if (sslmode === null || !DATABASE_TLS_SSLMODES.includes(sslmode.trim().toLowerCase())) {
    fail(
      "DATABASE_URL must require TLS in production: append ?sslmode=require, or ?sslmode=verify-full " +
        "(recommended, verifies the server certificate and hostname). " +
        "disable, allow, prefer and no-verify are rejected.",
    );
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

const LOOPBACK_HOST = "127.0.0.1";

function isValidHostAuthority(value: string): boolean {
  const match = /^[A-Za-z0-9.-]+(?::(\d{1,5}))?$/.exec(value);
  if (!match) return false;
  const port = match[1];
  if (port === undefined) return true;
  const portNumber = Number(port);
  return portNumber >= 1 && portNumber <= 65535;
}

export function selfReachableHost(host: ApiHost): string {
  return host === "0.0.0.0" ? LOOPBACK_HOST : host;
}

export function originHost(origin: string): string {
  return new URL(origin).host;
}

export function resolveMcpNetwork(config: AppConfig): {
  allowedHosts: string[];
  jwksUrl: string;
} {
  const loopbackAuthority = `${selfReachableHost(config.apiHost)}:${config.apiPort}`;
  return {
    allowedHosts: [
      ...new Set([
        originHost(config.publicOrigin),
        ...config.allowedHosts,
        ...(config.nodeEnv === "production" ? [] : [loopbackAuthority]),
      ]),
    ],
    jwksUrl: `${config.internalOrigin}/api/auth/jwks`,
  };
}

function parseHttpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${name} must use http or https.`);
  }
  return url;
}

function parseForcePathStyle(raw: string | undefined, loopbackDefault: boolean): boolean {
  const value = raw?.trim();
  if (value === undefined || value === "") return loopbackDefault;
  if (value === "1") return true;
  if (value === "0") return false;
  fail(
    "ARTIFLOW_S3_FORCE_PATH_STYLE must be 1 (path style), 0 (virtual-host style), " + "or unset (loopback default).",
  );
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const nodeEnvValue = (env.NODE_ENV ?? "development").trim();
  if (!NODE_ENVS.includes(nodeEnvValue as NodeEnv)) {
    fail(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}.`);
  }
  const nodeEnv = nodeEnvValue as NodeEnv;

  const required = [
    "DATABASE_URL",
    "ARTIFLOW_S3_ENDPOINT",
    "ARTIFLOW_S3_BUCKET",
    "ARTIFLOW_S3_ACCESS_KEY_ID",
    "ARTIFLOW_S3_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => read(env, name) === null);
  if (missing.length > 0) {
    fail(
      `Missing required configuration values: ${missing.join(", ")}. ` +
        "Run bun run setup:local to create the ignored .env.local file.",
    );
  }

  const apiHostValue = (env.ARTIFLOW_API_HOST ?? "127.0.0.1").trim();
  if (apiHostValue !== "127.0.0.1" && apiHostValue !== "0.0.0.0") {
    fail(
      "ARTIFLOW_API_HOST must be 127.0.0.1 (local loopback default) or 0.0.0.0 " +
        "(container bind); any other address is rejected.",
    );
  }
  const apiHost = apiHostValue as ApiHost;

  const apiPortValue = (env.ARTIFLOW_API_PORT ?? "8787").trim();
  if (!/^\d+$/.test(apiPortValue)) {
    fail("ARTIFLOW_API_PORT must be an integer between 1 and 65535.");
  }
  const apiPort = Number(apiPortValue);
  if (apiPort < 1 || apiPort > 65535) {
    fail("ARTIFLOW_API_PORT must be an integer between 1 and 65535.");
  }

  const publicOriginUrl = parseHttpUrl(
    "ARTIFLOW_PUBLIC_ORIGIN",
    (env.ARTIFLOW_PUBLIC_ORIGIN ?? "http://127.0.0.1:5173").trim(),
  );
  if (publicOriginUrl.pathname !== "/" || publicOriginUrl.search !== "" || publicOriginUrl.hash !== "") {
    fail("ARTIFLOW_PUBLIC_ORIGIN must be a bare origin without a path or query.");
  }

  const allowedHostsValue = read(env, "ARTIFLOW_ALLOWED_HOSTS");
  const allowedHosts = allowedHostsValue === null ? [] : allowedHostsValue.split(",").map((value) => value.trim());
  if (allowedHosts.some((host) => !isValidHostAuthority(host))) {
    fail(
      "ARTIFLOW_ALLOWED_HOSTS must be a comma-separated list of host[:port] authorities " +
        "without a scheme, path or wildcard.",
    );
  }

  const internalOriginValue = read(env, "ARTIFLOW_INTERNAL_ORIGIN");
  let internalOrigin: string;
  if (internalOriginValue === null) {
    internalOrigin = `http://${selfReachableHost(apiHost)}:${apiPort}`;
  } else {
    const internalOriginUrl = parseHttpUrl("ARTIFLOW_INTERNAL_ORIGIN", internalOriginValue);
    if (internalOriginUrl.pathname !== "/" || internalOriginUrl.search !== "" || internalOriginUrl.hash !== "") {
      fail("ARTIFLOW_INTERNAL_ORIGIN must be a bare origin without a path or query.");
    }
    internalOrigin = internalOriginUrl.origin;
  }

  const demoAuth = (env.ARTIFLOW_DEMO_AUTH ?? "").trim() === "1";
  if (demoAuth && nodeEnv !== "development") {
    fail(
      "ARTIFLOW_DEMO_AUTH is a loopback-only local profile and requires " +
        "NODE_ENV=development; production, test and other environments are rejected.",
    );
  }
  if (demoAuth && !isLoopbackHostname(publicOriginUrl.hostname)) {
    fail("ARTIFLOW_DEMO_AUTH requires a loopback ARTIFLOW_PUBLIC_ORIGIN; it is rejected for a non-loopback origin.");
  }

  const authSecret = read(env, "ARTIFLOW_AUTH_SECRET");
  if (authSecret === null) {
    fail(
      "Missing required configuration value: ARTIFLOW_AUTH_SECRET. " +
        "Run bun run setup:local (or bun run setup:auth for an existing .env.local) to add it.",
    );
  }
  if (authSecret.length < 32) {
    fail("ARTIFLOW_AUTH_SECRET must be at least 32 characters.");
  }
  if (isWeakSecret(authSecret)) {
    fail(
      "ARTIFLOW_AUTH_SECRET looks like a placeholder or a low-entropy value. " +
        "Generate a random secret with `openssl rand -hex 32` (or bun run setup:auth) " +
        "and never reuse the value published in a template.",
    );
  }

  const authProviders: SocialProviders = {};
  for (const [provider, idName, secretName] of [
    ["github", "ARTIFLOW_AUTH_GITHUB_CLIENT_ID", "ARTIFLOW_AUTH_GITHUB_CLIENT_SECRET"],
    ["google", "ARTIFLOW_AUTH_GOOGLE_CLIENT_ID", "ARTIFLOW_AUTH_GOOGLE_CLIENT_SECRET"],
  ] as const) {
    const clientId = read(env, idName);
    const clientSecret = read(env, secretName);
    if ((clientId === null) !== (clientSecret === null)) {
      fail(`${idName} and ${secretName} must be configured together; one of them is missing or blank.`);
    }
    if (clientId !== null && clientSecret !== null) {
      authProviders[provider] = { clientId, clientSecret };
    }
  }

  const databaseUrl = read(env, "DATABASE_URL") ?? "";
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    fail("DATABASE_URL must be a postgres:// connection string.");
  }
  if (nodeEnv === "production") {
    assertProductionDatabaseTls(databaseUrl);
  }

  const endpointUrl = parseHttpUrl("ARTIFLOW_S3_ENDPOINT", read(env, "ARTIFLOW_S3_ENDPOINT") ?? "");
  if (nodeEnv === "production" && endpointUrl.protocol !== "https:") {
    fail(
      "ARTIFLOW_S3_ENDPOINT must use https in production; an http endpoint sends credentials and " +
        "object data unencrypted. Use the provider's https endpoint.",
    );
  }
  const bucket = read(env, "ARTIFLOW_S3_BUCKET") ?? "";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    fail("ARTIFLOW_S3_BUCKET must be a lowercase S3 bucket name between 3 and 63 characters.");
  }

  return {
    nodeEnv,
    apiHost,
    apiPort,
    publicOrigin: publicOriginUrl.origin,
    allowedHosts,
    internalOrigin,
    demoAuth,
    authSecret,
    authProviders,
    databaseUrl,
    storage: {
      endpoint: endpointUrl.origin,
      region: (env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
      bucket,
      accessKeyId: read(env, "ARTIFLOW_S3_ACCESS_KEY_ID") ?? "",
      secretAccessKey: read(env, "ARTIFLOW_S3_SECRET_ACCESS_KEY") ?? "",
      forcePathStyle: parseForcePathStyle(env.ARTIFLOW_S3_FORCE_PATH_STYLE, isLoopbackHostname(endpointUrl.hostname)),
    },
  };
}
