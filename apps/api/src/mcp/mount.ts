import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";

import type { createAuth } from "../auth.ts";

export type McpAuth = ReturnType<typeof createAuth>;

import { MCP_SERVER_INFO, toMcpClaims, type McpClaims } from "@artiflow/mcp-server/claims";

export { MCP_SERVER_INFO, toMcpClaims };
export type { McpClaims };

export type McpBearerVerifier = (
  request: Request,
  handler: (request: Request, claims: McpClaims) => Response | Promise<Response>,
) => Promise<Response>;

export type McpBearerOptions = Pick<
  McpAppOptions,
  "resource" | "issuer" | "jwksUrl" | "challengeScopes" | "isAccountActive"
>;

function invalidTokenResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
  });
}

export function createMcpBearerVerifier(auth: McpAuth, options: McpBearerOptions): McpBearerVerifier {
  const isAccountActive = options.isAccountActive;
  return (request, handler) =>
    requireMcpAuth(
      auth,
      async (verifiedRequest, claims) => {
        const resolved = toMcpClaims(claims);
        if (isAccountActive !== undefined && (resolved.userId === null || !(await isAccountActive(resolved.userId))))
          return invalidTokenResponse();
        return handler(verifiedRequest, resolved);
      },
      {
        resource: options.resource,
        issuer: options.issuer,
        jwksUrl: options.jwksUrl,
        challengeScopes: options.challengeScopes,
      },
    )(request);
}

export function createMultiAudienceBearerVerifier(
  auth: McpAuth,
  audiences: readonly McpBearerOptions[],
): McpBearerVerifier {
  if (audiences.length === 0) throw new TypeError("createMultiAudienceBearerVerifier needs at least one audience");
  const verifiers = audiences.map((options) => createMcpBearerVerifier(auth, options));
  return async (request, handler) => {
    let refusal: Response | undefined;
    for (const verify of verifiers) {
      let accepted = false;
      const response = await verify(request, (verifiedRequest, claims) => {
        accepted = true;
        return handler(verifiedRequest, claims);
      });
      if (accepted) return response;
      refusal ??= response;
    }
    return refusal ?? new Response(null, { status: 401 });
  };
}

export type McpAppOptions = {
  allowedHosts: string[];
  allowedOrigins: string[];
  jwksUrl: string;
  resource: string;
  issuer: string;
  challengeScopes: readonly string[];
  isAccountActive?: (userId: string) => Promise<boolean>;
  mcpServerFactory?: (claims: McpClaims) => McpServer;
};

function createPlaceholderMcpServer(): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  return server;
}

async function handleMcpRequest(
  request: Request,
  createServer: () => McpServer,
  options: McpAppOptions,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
  });
  const server = createServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

export function createMcpApp(auth: McpAuth, options: McpAppOptions): Hono {
  const app = new Hono();
  const createServer = options.mcpServerFactory ?? createPlaceholderMcpServer;
  const verifyBearer = createMcpBearerVerifier(auth, options);
  const authorized = (request: Request) =>
    verifyBearer(request, (verifiedRequest, claims) =>
      handleMcpRequest(verifiedRequest, () => createServer(claims), options),
    );

  app.post("/mcp", (c) => authorized(c.req.raw));
  app.all("/mcp", (c) => {
    c.header("allow", "POST");
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405);
  });
  return app;
}
