import type { McpClaims } from "../mcp/mount.ts";

export type Principal = { userId: string; scopes: string[] };

export const PRINCIPAL_HEADER = "x-artiflow-principal";

export function encodePrincipal(principal: Principal): string {
  return JSON.stringify(principal);
}

export function readPrincipal(headers: Headers): Principal | null {
  const raw = headers.get(PRINCIPAL_HEADER);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Principal> | null;
    if (
      value &&
      typeof value.userId === "string" &&
      value.userId.length > 0 &&
      Array.isArray(value.scopes) &&
      value.scopes.every((scope) => typeof scope === "string")
    )
      return { userId: value.userId, scopes: value.scopes };
    return null;
  } catch {
    return null;
  }
}

export function principalFromClaims(claims: McpClaims): Principal | null {
  return claims.userId === null ? null : { userId: claims.userId, scopes: claims.scopes };
}
