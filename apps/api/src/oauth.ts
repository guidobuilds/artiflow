import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";

import type { AppConfig } from "./config.ts";

export function publicResource(config: Pick<AppConfig, "publicOrigin">): string {
  return `${config.publicOrigin}/mcp`;
}
export function publicApiResource(config: Pick<AppConfig, "publicOrigin">): string {
  return `${config.publicOrigin}/api/v1`;
}
export function publicIssuer(config: Pick<AppConfig, "publicOrigin">): string {
  return `${config.publicOrigin}/api/auth`;
}
export const OAUTH_SCOPES = ["artifacts:read", "artifacts:write", "comments:write", "shares:manage", "offline_access"];

export const API_RESOURCE_SCOPES = OAUTH_SCOPES.filter((scope) => scope !== "offline_access");

export function apiResourceProviderOptions(config: Pick<AppConfig, "publicOrigin">) {
  const identifier = publicApiResource(config);
  return {
    resources: [{ identifier, allowedScopes: API_RESOURCE_SCOPES }],
    clientRegistrationAllowedResources: [identifier],
  };
}

export function oauthPlugins(config: Pick<AppConfig, "publicOrigin">) {
  return [
    jwt({ jwt: { issuer: publicIssuer(config) } }),
    mcp({
      resource: publicResource(config),
      scopes: OAUTH_SCOPES,
      ...apiResourceProviderOptions(config),
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 1_209_600,
      refreshTokenReuseInterval: 0,
      loginPage: "/login",
      consentPage: "/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientPrivileges: ({ action, user }) => action === "create" && user !== undefined,
      resourcePrivileges: () => false,
    }),
  ];
}
