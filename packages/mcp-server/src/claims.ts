export type McpClaims = { userId: string | null; scopes: string[] };

export function toMcpClaims(payload: Record<string, unknown>): McpClaims {
  const subject = payload.sub;
  const scope = payload.scope;
  return {
    userId: typeof subject === "string" && subject.length > 0 ? subject : null,
    scopes: typeof scope === "string" ? scope.split(" ").filter((value) => value.length > 0) : [],
  };
}

export const MCP_SERVER_INFO = { name: "artiflow", version: "0.1.0" } as const;
