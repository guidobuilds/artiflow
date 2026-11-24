import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { randomAvatar } from "@artiflow/domain/avatars";

import { isLoopbackHostname, type AppConfig } from "./config.ts";
import type { Database } from "./adapters/postgres/db/client.ts";
import { registrationAuthSchema } from "./adapters/postgres/db/auth-schema.ts";
import { ssoProvider, user } from "./adapters/postgres/db/schema.ts";
import { isActiveAccount } from "./identity/account-status.ts";
import { instanceRoles } from "./identity/admin-access.ts";
import { createSsoUserResolver } from "./identity/sso-resolution.ts";
import { ADMINISTRATOR_ROLE, MEMBER_ROLE, isAdministrator, isUserRole, type UserRole } from "./identity/roles.ts";
import { registrationInvites } from "./invites/plugin.ts";
import { canonicalizeEmail, hashInviteToken } from "./invites/token.ts";
import { alternativeMethodLock } from "./login/fallback-lock.ts";
import { UNATTRIBUTED_FALLBACK_ACTOR, recordAdminEvent } from "./logging/admin-events.ts";
import { passwordReset } from "./password-reset/plugin.ts";
import { API_RESOURCE_SCOPES, oauthPlugins, publicApiResource, publicIssuer } from "./oauth.ts";
import { passwordPolicyHook } from "./password-policy/hook.ts";
import { defaultPasswordPolicyView, readPasswordPolicy, type PasswordPolicySource } from "./password-policy/policy.ts";
import type { PasswordPolicyView } from "@artiflow/contracts/settings";
import { environmentSnapshot, type AccessSnapshot } from "./settings/access-snapshot.ts";
import {
  SSO_CONNECTION_PROVIDER_ID,
  ssoIssuerOrigin,
  type SsoProviderRegistration,
} from "./settings/sso-connection.ts";

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

const SSO_SELF_SERVICE_PATHS = [
  "/sso/register",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/callback",
];

const SOCIAL_SIGN_IN_PATHS = new Set(["/sign-in/social", "/callback/:id"]);

const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";
const REGISTRATION_COMPLETE_PATH = "/api/auth/registration/complete";

function fallbackAuditPlugin(database: Database, enabled: boolean): BetterAuthPlugin {
  return {
    id: "fallback-audit",
    hooks: {
      after: [
        {
          matcher: (context) => enabled && SOCIAL_SIGN_IN_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created) return;
            const rows = await database.db
              .select({ role: user.role, status: user.status })
              .from(user)
              .where(eq(user.id, created.user.id))
              .limit(1);
            const found = rows[0];
            const admitted = found !== undefined && isAdministrator(found.role) && isActiveAccount(found.status);
            const role = found !== undefined && isUserRole(found.role) ? found.role : MEMBER_ROLE;
            recordAdminEvent({
              event: "login.fallback.used",
              actorId: created.user.id,
              actorRole: role,
              subjectId: created.user.id,
              outcome: admitted ? "applied" : "refused",
            });
          }),
        },
      ],
    },
  };
}

function ssoIdentityPlugin(registration: SsoProviderRegistration, database: Database): BetterAuthPlugin {
  return sso({
    providersLimit: () => 0,
    domainVerification: { enabled: false },
    disableImplicitSignUp: true,
    disabledPaths: SSO_SELF_SERVICE_PATHS,
    defaultSSO: [
      {
        providerId: SSO_CONNECTION_PROVIDER_ID,
        domain: registration.domain,
        oidcConfig: {
          issuer: registration.issuer,
          discoveryEndpoint: registration.discoveryUrl,
          clientId: registration.clientId,
          clientSecret: registration.clientSecret,
          scopes: [...registration.scopes],
          pkce: true,
        },
      },
    ],
    resolveUser: createSsoUserResolver({
      db: database.db,
      allowedDomains: registration.allowedDomains,
      issuer: registration.issuer,
      jitProvisioning: registration.jitProvisioning,
      acceptAnyAccount: registration.acceptAnyAccount,
    }),
  }) as BetterAuthPlugin;
}

function trustedOriginsOf(config: AuthConfig, registration: SsoProviderRegistration | null): string[] {
  const idpOrigin = registration === null ? null : ssoIssuerOrigin(registration.issuer);
  return idpOrigin === null ? [config.publicOrigin] : [config.publicOrigin, idpOrigin];
}

export function createAuth(config: AuthConfig, database: Database): AuthInstance {
  return createAuthFromSnapshot(config, database, environmentSnapshot(config.authProviders));
}

export function createAuthFromSnapshot(config: AuthConfig, database: Database, snapshot: AccessSnapshot) {
  const origin = publicOriginUrl(config);
  const policy: PasswordPolicySource = () => readPasswordPolicy(database.db);
  const passwordEnabled = passwordLoginEnabled(config, snapshot);
  const registration = snapshot.sso.provider;
  const ssoPlugins: BetterAuthPlugin[] = registration === null ? [] : [ssoIdentityPlugin(registration, database)];
  return betterAuth({
    baseURL: config.publicOrigin,
    secret: config.authSecret,
    trustedOrigins: trustedOriginsOf(config, registration),
    telemetry: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: passwordEnabled,
      disableSignUp: !PUBLIC_REGISTRATION_OPEN,
      minPasswordLength: snapshot.passwordMinLength,
    },
    socialProviders: socialProviderOptions(snapshot.providers),
    account: {
      accountLinking: {
        requireLocalEmailVerified: false,
        trustedProviders: [],
      },
    },
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
      fallbackAuditPlugin(database, snapshot.sso.enabled),
      alternativeMethodLock({
        db: database.db,
        ssoEnabled: snapshot.sso.enabled,
        passwordEnabled,
      }),
      ...ssoPlugins,
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
      schema: { ...registrationAuthSchema, ssoProvider },
      transaction: true,
    }),
  });
}

export type AccessSnapshotSource = () => Promise<AccessSnapshot>;

export type PasswordPolicySourceRead = () => Promise<PasswordPolicyView>;

async function signInAddress(request: Request): Promise<string | null> {
  try {
    const payload: unknown = await request.clone().json();
    if (typeof payload !== "object" || payload === null) return null;
    const email = (payload as Record<string, unknown>).email;
    if (typeof email !== "string") return null;
    const address = canonicalizeEmail(email);
    return address === "" ? null : address;
  } catch {
    return null;
  }
}

async function registrationToken(request: Request): Promise<string | null> {
  try {
    const payload: unknown = await request.clone().json();
    if (typeof payload !== "object" || payload === null) return null;
    const token = (payload as Record<string, unknown>).token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

type AuditContext = Awaited<AuthInstance["$context"]>;

async function storedRole(context: AuditContext, userId: string): Promise<UserRole> {
  const rows = await context.adapter.findOne<{ role: string }>({
    model: "user",
    where: [{ field: "id", value: userId }],
  });
  return rows !== null && isUserRole(rows.role) ? rows.role : MEMBER_ROLE;
}

async function recordPasswordFallback(
  auth: AuthInstance,
  config: AuthConfig,
  access: AccessSnapshotSource | undefined,
  address: string,
  admitted: boolean,
): Promise<void> {
  try {
    const snapshot = access === undefined ? environmentSnapshot(config.authProviders) : await access();
    if (!(snapshot.sso.enabled && passwordLoginEnabled(config, snapshot))) return;
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserByEmail(address);
    if (found === null) {
      recordAdminEvent({
        event: "login.fallback.used",
        actorId: UNATTRIBUTED_FALLBACK_ACTOR,
        actorRole: "anonymous",
        subjectId: UNATTRIBUTED_FALLBACK_ACTOR,
        outcome: admitted ? "applied" : "refused",
      });
      return;
    }
    const role = await storedRole(context, found.user.id);
    recordAdminEvent({
      event: "login.fallback.used",
      actorId: found.user.id,
      actorRole: role,
      subjectId: found.user.id,
      outcome: admitted ? "applied" : "refused",
    });
  } catch {
    return;
  }
}

async function recordRegistrationCompleted(auth: AuthInstance, token: string): Promise<void> {
  try {
    const context = await auth.$context;
    const invitation = await context.adapter.findOne<{ email: string }>({
      model: "registrationInvite",
      where: [{ field: "tokenHash", value: hashInviteToken(token) }],
    });
    if (invitation === null) return;
    const found = await context.internalAdapter.findUserByEmail(invitation.email);
    if (found === null) return;
    const role = await storedRole(context, found.user.id);
    recordAdminEvent({
      event: "user.registered",
      actorId: found.user.id,
      actorRole: role,
      subjectId: found.user.id,
      outcome: "applied",
    });
  } catch {
    return;
  }
}

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
    const emailPassword = passwordLoginEnabled(config, snapshot);
    const socialProviders = Object.keys(snapshot.providers);
    c.header("cache-control", "no-store");
    return c.json({
      emailPassword,
      registration: PUBLIC_REGISTRATION_OPEN,
      socialProviders,
      ...(snapshot.sso.enabled
        ? {
            sso: {
              displayName: snapshot.sso.displayName,
              fallbackAvailable: emailPassword || socialProviders.length > 0,
              fallbackAdministratorsOnly: true,
            },
          }
        : {}),
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

  app.post(PASSWORD_SIGN_IN_PATH, async (c) => {
    const address = await signInAddress(c.req.raw);
    const response = await auth.handler(c.req.raw);
    if (address !== null) await recordPasswordFallback(auth, config, access, address, response.ok);
    return response;
  });

  app.post(REGISTRATION_COMPLETE_PATH, async (c) => {
    const token = await registrationToken(c.req.raw);
    const response = await auth.handler(c.req.raw);
    if (response.ok && token !== null) await recordRegistrationCompleted(auth, token);
    return response;
  });

  app.get(AUTHORIZE_PATH, (c): Response | Promise<Response> => {
    const resource = c.req.query("resource")?.trim() ?? "";
    if (resource.length === 0) {
      return c.json({ error: "invalid_target", error_description: "resource parameter is required" }, 400);
    }
    return auth.handler(c.req.raw);
  });

  app.on(["GET", "POST"], AUTH_ROUTE, (c) => auth.handler(c.req.raw));
  return app;
}
