import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { bodyLimit } from "./http/body-limit.ts";

import { createArtifactTools } from "./mcp/artifact-tools.ts";
import { createAuth, createAuthApp } from "./auth.ts";
import { resolveMcpNetwork, type AppConfig } from "./config.ts";
import { MAX_ARTIFACT_BYTES } from "./adapters/postgres/db/artifact-schema.ts";
import { createAdminApp } from "./routes/admin.ts";
import { createEditingApp } from "./routes/editing.ts";
import { createCommentsApp } from "./routes/comments.ts";
import { createHealthApp } from "./routes/health.ts";
import { createLibraryApp } from "./routes/library.ts";
import { createMcpApp, createMcpBearerVerifier, createMultiAudienceBearerVerifier } from "./mcp/mount.ts";
import { API_RESOURCE_SCOPES, publicApiResource, publicIssuer, publicResource } from "./oauth.ts";
import { requiredScope, type ApiV1Method } from "./routes/v1/scopes.ts";
import { createMcpBackend } from "./mcp/backend.ts";
import { createArtifactsV1App } from "./routes/v1/create.ts";
import { createArtifactBytesV1App } from "./routes/v1/bytes.ts";
import { createArtifactUpdateV1App } from "./routes/v1/update.ts";
import { encodePrincipal, PRINCIPAL_HEADER, principalFromClaims } from "./http/principal.ts";

import { jsonError } from "./http/index.ts";
import { createShareViewerApp, createSharingApp } from "./routes/sharing.ts";
import type { Database } from "./adapters/postgres/db/client.ts";
import type { Storage } from "./adapters/storage/client.ts";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { appSchema } from "./adapters/postgres/db/app-schema.ts";

export type ApiAppDeps = {
  config: AppConfig;
  database: {
    db: NodePgDatabase<typeof appSchema>;
    check: () => Promise<void>;
  };
  storage: {
    client: Storage["client"];
    bucket: string;
    checkBucket: () => Promise<void>;
    destroy: () => void;
  };
};

export function createApiApp({ config, database, storage }: ApiAppDeps) {
  const mcpNetwork = resolveMcpNetwork(config);
  const databaseView = database as unknown as Database;
  const storageView = storage as unknown as Storage;
  type AppEnv = { Variables: { requestId: string } };
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });
  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? "unassigned";
    console.error(
      `[api] unhandled ${error instanceof Error ? error.name : "non-error"} on ${c.req.path} (${requestId})`,
    );
    return c.json({ error: "internal_error", requestId }, 500);
  });

  app.route(
    "/",
    createHealthApp({
      checkDatabase: database.check,
      checkStorage: storage.checkBucket,
    }),
  );

  const auth = createAuth(config, databaseView);
  app.route("/", createAuthApp(auth, config));

  app.use("/api/artifacts/*/document", async (c, next) => {
    if (c.req.method !== "PUT") return next();
    return bodyLimit({ kind: "document-save", limitBytes: MAX_ARTIFACT_BYTES })(c, next);
  });
  app.use("/api/artifacts/*/comments", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return bodyLimit({ kind: "comment", limitBytes: 64 * 1024 })(c, next);
  });
  app.use("/mcp", bodyLimit({ kind: "mcp", limitBytes: 2 * 1024 * 1024 }));

  const mcpAuthOptions = {
    jwksUrl: mcpNetwork.jwksUrl,
    resource: publicResource(config),
    issuer: publicIssuer(config),
    challengeScopes: ["artifacts:read", "artifacts:write"],
  };
  const apiAuthOptions = {
    jwksUrl: mcpNetwork.jwksUrl,
    resource: publicApiResource(config),
    issuer: publicIssuer(config),
    challengeScopes: [...API_RESOURCE_SCOPES],
  };

  app.route("/", createAdminApp({ database: databaseView, auth, publicOrigin: config.publicOrigin }));
  app.route("/", createSharingApp({ database: databaseView, auth, publicOrigin: config.publicOrigin }));
  app.route(
    "/",
    createEditingApp({ database: databaseView, auth, storage: storageView, publicOrigin: config.publicOrigin }),
  );
  app.route(
    "/",
    createCommentsApp({ database: databaseView, auth, storage: storageView, publicOrigin: config.publicOrigin }),
  );
  app.route(
    "/",
    createShareViewerApp({ database: databaseView, storage: storageView, maxArtifactBytes: MAX_ARTIFACT_BYTES }),
  );
  app.route(
    "/",
    createLibraryApp({
      database: databaseView,
      auth,
      storage: storageView,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      deletion: { publicOrigin: config.publicOrigin },
      bearerVerifier: createMultiAudienceBearerVerifier(auth, [mcpAuthOptions, apiAuthOptions]),
    }),
  );

  const artifactTools = createArtifactTools({
    backend: createMcpBackend(databaseView, storageView),
    requireScope: "artifacts:write",
    readScope: "artifacts:read",
  });

  app.route(
    "/",
    createMcpApp(auth, {
      allowedHosts: mcpNetwork.allowedHosts,
      allowedOrigins: [config.publicOrigin],
      ...mcpAuthOptions,
      mcpServerFactory: artifactTools,
    }),
  );

  const v1Target = new Hono();
  v1Target.route("/", createArtifactsV1App({ database: databaseView, storage: storageView }));
  v1Target.route("/", createArtifactBytesV1App({ database: databaseView, storage: storageView }));
  v1Target.route("/", createArtifactUpdateV1App({ database: databaseView, storage: storageView }));
  v1Target.route(
    "/",
    createSharingApp({ database: databaseView, auth, publicOrigin: config.publicOrigin, principal: true }),
  );
  v1Target.route(
    "/",
    createEditingApp({
      database: databaseView,
      auth,
      storage: storageView,
      publicOrigin: config.publicOrigin,
      principal: true,
    }),
  );
  v1Target.route(
    "/",
    createCommentsApp({
      database: databaseView,
      auth,
      storage: storageView,
      publicOrigin: config.publicOrigin,
      principal: true,
    }),
  );
  v1Target.route(
    "/",
    createLibraryApp({
      database: databaseView,
      auth,
      storage: storageView,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      deletion: { publicOrigin: config.publicOrigin },
      principal: true,
    }),
  );
  const apiVerifier = createMcpBearerVerifier(auth, apiAuthOptions);

  const serveV1 = async (c: Context): Promise<Response> => {
    const rewrittenPath = `/api${c.req.path.slice("/api/v1".length)}`;
    const method = c.req.method.toUpperCase() as ApiV1Method;
    if (requiredScope(method, rewrittenPath) === null) {
      return jsonError(c, "method_not_allowed", 405);
    }
    if (
      (method === "PUT" && rewrittenPath.endsWith("/document")) ||
      (method === "POST" && rewrittenPath === "/api/artifacts")
    ) {
      const declared = c.req.header("content-length");
      if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > MAX_ARTIFACT_BYTES) {
        return c.json({ error: "too_large", maxBytes: MAX_ARTIFACT_BYTES }, 413);
      }
    }
    const inboundPrincipal = c.req.header(PRINCIPAL_HEADER);
    if (inboundPrincipal !== undefined && inboundPrincipal !== null) {
      return jsonError(c, "invalid_request", 400);
    }
    try {
      return await apiVerifier(c.req.raw, async (verifiedRequest, claims) => {
        const principal = principalFromClaims(claims);
        if (principal === null) return jsonError(c, "invalid_token", 401);
        const scope = requiredScope(method, rewrittenPath);
        if (scope === null) return jsonError(c, "method_not_allowed", 405);
        if (!principal.scopes.includes(scope)) {
          c.header(
            "www-authenticate",
            `Bearer realm="api", scope="${scope}", resource_metadata="${config.publicOrigin}/.well-known/oauth-protected-resource/api/v1"`,
          );
          return jsonError(c, "insufficient_scope", 403);
        }
        const url = new URL(verifiedRequest.url);
        url.pathname = rewrittenPath;
        const headers = new Headers(verifiedRequest.headers);
        headers.set(PRINCIPAL_HEADER, encodePrincipal(principal));
        return v1Target.fetch(
          new Request(url, {
            method: verifiedRequest.method,
            headers,
            body: verifiedRequest.body,
            duplex: verifiedRequest.body ? "half" : undefined,
          }),
        );
      });
    } catch {
      return jsonError(c, "invalid_token", 401);
    }
  };
  app.all("/api/v1", (c) => serveV1(c));
  app.all("/api/v1/*", (c) => serveV1(c));
  return app;
}
