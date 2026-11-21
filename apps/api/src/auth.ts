import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { randomAvatar } from "@artiflow/domain/avatars";

import { isLoopbackHostname, type AppConfig } from "./config.ts";
import type { Database } from "./adapters/postgres/db/client.ts";
import { registrationAuthSchema } from "./adapters/postgres/db/auth-schema.ts";
import { user } from "./adapters/postgres/db/schema.ts";
import { isActiveAccount } from "./identity/account-status.ts";
import { instanceRoles } from "./identity/admin-access.ts";
import { ADMINISTRATOR_ROLE, MEMBER_ROLE } from "./identity/roles.ts";
import { registrationInvites } from "./invites/plugin.ts";
import { passwordReset } from "./password-reset/plugin.ts";
import { API_RESOURCE_SCOPES, oauthPlugins, publicApiResource, publicIssuer } from "./oauth.ts";
import { passwordPolicyHook } from "./password-policy/hook.ts";
import {
  defaultPasswordPolicyView,
  readPasswordPolicy,
  type PasswordPolicySource,
} from "./password-policy/policy.ts";
import type { PasswordPolicyView } from "@artiflow/contracts/settings";
import { environmentSnapshot, type AccessSnapshot } from "./settings/access-snapshot.ts";

export type AuthConfig = Pick<
  AppConfig,
  "nodeEnv" | "demoAuth" | "authSecret" | "publicOrigin" | "authProviders" | "secretEncryptionKey"
>;

const AUTH_ROUTE = "/api/auth/*";

const OAUTH_CLIENT_AUTH_PATHS = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/introspect",
  "/api/auth/oauth2/revoke",
]);

const OAUTH_REGISTER_PATH = "/api/auth/oauth2/register";
const SESSION_COOKIE_NAME = "artiflow.session_token=";

const WELL_KNOWN_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
] as const;

const API_RESOURCE_WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource/api/v1";

const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

function publicOriginUrl(config: AuthConfig): URL {
  try {
    return new URL(config.publicOrigin);
  } catch {
    throw new Error("ARTIFLOW_PUBLIC_ORIGIN is not a valid absolute URL.");
  }
}

export function emailPasswordEnabled(config: AuthConfig): boolean {
  if (config.nodeEnv === "production") return true;
  return config.nodeEnv === "development" && config.demoAuth && isLoopbackHostname(publicOriginUrl(config).hostname);
}

export const PUBLIC_REGISTRATION_OPEN = false;

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value.trim());
}

export function emailPasswordOptions(config: AuthConfig): { enabled: boolean; disableSignUp: boolean } {
  return { enabled: emailPasswordEnabled(config), disableSignUp: !PUBLIC_REGISTRATION_OPEN };
}

export type SocialProviderCredentials = { clientId: string; clientSecret: string };

export function passwordLoginEnabled(config: AuthConfig, snapshot: AccessSnapshot): boolean {
  return emailPasswordEnabled(config) && snapshot.passwordEnabled;
}

export function socialProviderOptions(
  providers: Readonly<Record<string, SocialProviderCredentials | undefined>>,
): Record<string, { clientId: string; clientSecret: string; disableSignUp: true }> {
  const options: Record<string, { clientId: string; clientSecret: string; disableSignUp: true }> = {};
  for (const [name, credentials] of Object.entries(providers)) {
    if (credentials !== undefined)
      options[name] = { clientId: credentials.clientId, clientSecret: credentials.clientSecret, disableSignUp: true };
  }
  return options;
}

export type AuthInstance = ReturnType<typeof createAuthFromSnapshot>;

export function createAuth(config: AuthConfig, database: Database): AuthInstance {
  return createAuthFromSnapshot(config, database, environmentSnapshot(config.authProviders));
}

export function createAuthFromSnapshot(config: AuthConfig, database: Database, snapshot: AccessSnapshot) {
  const origin = publicOriginUrl(config);
  const policy: PasswordPolicySource = () => readPasswordPolicy(database.db);
  return betterAuth({
    baseURL: config.publicOrigin,
    secret: config.authSecret,
    trustedOrigins: [config.publicOrigin],
    telemetry: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: passwordLoginEnabled(config, snapshot),
      disableSignUp: !PUBLIC_REGISTRATION_OPEN,
      minPasswordLength: snapshot.passwordMinLength,
    },
    socialProviders: socialProviderOptions(snapshot.providers),
    session: { cookieCache: { enabled: false } },
    hooks: { before: passwordPolicyHook(policy) },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: { ...user, image: user.image ?? randomAvatar() } }),
        },
      },
      session: {
        create: {
          before: async (created) => {
            const rows = await database.db
              .select({ status: user.status })
              .from(user)
              .where(eq(user.id, created.userId))
              .limit(1);
            return isActiveAccount(rows[0]?.status) ? undefined : false;
          },
        },
      },
    },
    plugins: [
      ...oauthPlugins(config),
      registrationInvites({ policy }),
      passwordReset({ policy }),
      admin({
        roles: instanceRoles,
        adminRoles: [ADMINISTRATOR_ROLE],
        defaultRole: MEMBER_ROLE,
        allowImpersonatingAdmins: false,
      }),
    ],
    rateLimit: {
      customRules: {
        "/oauth2/register": { window: 3600, max: 20 },
        "/registration/preview": { window: 60, max: 20 },
        "/registration/complete": { window: 60, max: 10 },
        "/password-reset/preview": { window: 60, max: 20 },
        "/password-reset/complete": { window: 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "artiflow",
      useSecureCookies: config.nodeEnv === "production" || origin.protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: registrationAuthSchema,
      transaction: true,
    }),
  });
}

export type AccessSnapshotSource = () => Promise<AccessSnapshot>;

export type PasswordPolicySourceRead = () => Promise<PasswordPolicyView>;

export function createAuthApp(
  auth: AuthInstance,
  config: AuthConfig,
  access?: AccessSnapshotSource,
  passwordPolicy?: PasswordPolicySourceRead,
): Hono {
  const app = new Hono();

  app.use(AUTH_ROUTE, async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      await next();
      return;
    }
    if (c.req.method === "POST" && OAUTH_CLIENT_AUTH_PATHS.has(c.req.path)) {
      await next();
      return;
    }
    if (c.req.method === "POST" && c.req.path === OAUTH_REGISTER_PATH) {
      const origin = c.req.header("origin");
      if (
        (origin !== undefined && origin !== config.publicOrigin) ||
        (origin === undefined && (c.req.header("cookie") ?? "").includes(SESSION_COOKIE_NAME))
      ) {
        return c.json({ error: "origin_not_allowed" }, 403);
      }
      if (!isJsonContentType(c.req.header("content-type"))) {
        return c.json({ error: "json_content_type_required" }, 415);
      }
      await next();
      return;
    }
    if (c.req.header("origin") !== config.publicOrigin) {
      return c.json({ error: "origin_not_allowed" }, 403);
    }
    const contentType = c.req.header("content-type");
    if (!isJsonContentType(contentType)) {
      return c.json({ error: "json_content_type_required" }, 415);
    }
    await next();
  });

  app.get("/api/auth/capabilities", async (c) => {
    const snapshot = access === undefined ? environmentSnapshot(config.authProviders) : await access();
    c.header("cache-control", "no-store");
    return c.json({
      emailPassword: passwordLoginEnabled(config, snapshot),
      registration: PUBLIC_REGISTRATION_OPEN,
      socialProviders: Object.keys(snapshot.providers),
    });
  });

  app.get("/api/auth/password-policy", async (c) => {
    const view = passwordPolicy === undefined ? defaultPasswordPolicyView() : await passwordPolicy();
    c.header("cache-control", "no-store");
    return c.json(view);
  });

  for (const path of WELL_KNOWN_PATHS) {
    app.on(["GET", "HEAD"], path, (c) => auth.handler(c.req.raw));
  }

  app.on(["GET", "HEAD"], API_RESOURCE_WELL_KNOWN_PATH, (c) => {
    c.header("cache-control", "no-store");
    return c.json({
      resource: publicApiResource(config),
      authorization_servers: [publicIssuer(config)],
      scopes_supported: API_RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  app.get(AUTHORIZE_PATH, (c) => {
    const resource = c.req.query("resource")?.trim() ?? "";
    if (resource.length === 0) {
      return c.json({ error: "invalid_target", error_description: "resource parameter is required" }, 400);
    }
    return auth.handler(c.req.raw);
  });

  app.on(["GET", "POST"], AUTH_ROUTE, (c) => auth.handler(c.req.raw));
  return app;
}
