import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { markArtifactDeleted } from "../apps/api/src/domain/commits.ts";
import { REVISION_KEY_PREFIX } from "../apps/api/src/adapters/storage/s3.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import {
  createMcpApp,
  createMcpBearerVerifier,
  createMultiAudienceBearerVerifier,
  type McpBearerVerifier,
} from "../apps/api/src/mcp/mount.ts";
import { API_RESOURCE_SCOPES, publicApiResource, publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import { createSharingApp, createShareViewerApp } from "../apps/api/src/routes/sharing.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createPkce } from "./helpers/oauth.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const config = loadConfig(process.env);
const resource = publicResource(config);
const apiResource = publicApiResource(config);
const issuer = publicIssuer(config);
const html = `<!doctype html><h1>Bearer viewer ${randomUUID()}</h1>`;
const digest = createHash("sha256").update(html).digest("hex");
type Identity = { cookie: string; id: string; email: string; token: string };
let admin: Pool, database: Database, storage: Storage, server: ReturnType<typeof serve>;
let auth: ReturnType<typeof createAuth>;
let singleAudienceVerifier: McpBearerVerifier, dualAudienceVerifier: McpBearerVerifier;
let databaseName = "",
  baseUrl = "",
  artifactId = "",
  deletedId = "",
  narrowToken = "",
  apiToken = "";
let owner: Identity, reader: Identity, stranger: Identity;
let markdownId = "";
const usedKeys: string[] = [];
let baselineKeys = new Set<string>();
const managementCells =
  /<span data-island="actions">.*?<\/span>|<script type="application\/json" id="viewer-management-data">[^<]*<\/script>|<script type="module" src="[^"]*viewer-actions[^"]*"><\/script>/g;
const withoutManagement = (html: string): string => html.replace(managementCells, "");
const revisionKeyOf = async (revisionId: string): Promise<string> => {
  const row = await database.pool.query<{ storageKey: string }>(
    `select "storageKey" from "artifactRevisions" where "id" = $1`,
    [revisionId],
  );
  const storageKey = row.rows[0]?.storageKey;
  assert.ok(typeof storageKey === "string", "the revision row names its own storage key");
  return storageKey;
};
const revisionKeys = async (): Promise<Set<string>> => {
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const page = await storage.client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: REVISION_KEY_PREFIX, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.add(object.Key);
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return keys;
};
const request = (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
const post = (path: string, body: unknown, cookie?: string) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.publicOrigin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const viewer = (token?: string, cookie?: string, id = artifactId, origin?: string) =>
  request(`/artifact/${id}`, {
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
  });
const signedToken = async (payload: Record<string, unknown>): Promise<string> =>
  (await auth.api.signJWT({ body: { payload } })).token;

async function earnToken(cookie: string, scope = "artifacts:read", audience = resource): Promise<string> {
  const redirectUri = "http://127.0.0.1:5173/oauth/callback";
  const registration = await post("/api/auth/oauth2/register", {
    client_name: "Viewer integration",
    redirect_uris: [redirectUri],
    application_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    resources: [audience],
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const pkce = createPkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    resource: audience,
    state: randomUUID(),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  const authorized = await request(`/api/auth/oauth2/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(authorized.status, 200);
  const { url } = (await authorized.json()) as { url: string };
  assert.ok(url.startsWith("/consent?"));
  const consent = await post(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: url.slice("/consent?".length) },
    cookie,
  );
  assert.equal(consent.status, 200);
  const callback = (await consent.json()) as { url: string };
  const code = new URL(callback.url).searchParams.get("code") ?? "";
  assert.ok(code.length > 0);
  const exchanged = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: pkce.verifier,
      resource: audience,
    }).toString(),
  });
  assert.equal(exchanged.status, 200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

async function identity(): Promise<Identity> {
  const account = await trustedSession(
    { database, baseUrl, origin: config.publicOrigin },
    { name: "Viewer integration", email: `viewer-${randomUUID()}@example.test` },
  );
  return { cookie: account.cookie, id: account.userId, email: account.email, token: await earnToken(account.cookie) };
}

async function seed(kind = "html"): Promise<string> {
  const bytes = Buffer.from(html);
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(
    (
      await createUpload(database.db, {
        ownerId: owner.id,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: digest,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await putChunk(database.db, {
        ownerId: owner.id,
        uploadId,
        chunkIndex: 0,
        sizeBytes: bytes.length,
        sha256: digest,
      })
    ).ok,
    true,
  );
  const result = await commitUpload({
    database,
    storage,
    ownerId: owner.id,
    uploadId,
    bytes,
    title: "Bearer viewer",
    kind,
  });
  if (!result.ok) throw new Error(`seed refused: ${result.reason}`);
  assert.equal(
    await revisionKeyOf(result.value.revisionId),
    result.value.storageKey,
    "the committed key is the one persisted on the revision row",
  );
  usedKeys.push(result.value.storageKey);
  return result.value.artifactId;
}

before(async () => {
  const url = new URL(config.databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/artiflow");
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(config.storage.endpoint).hostname));
  admin = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_viewer_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^artiflow_viewer_test_[0-9a-f]{32}$/);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  storage = createStorage(config.storage);
  baselineKeys = await revisionKeys();
  auth = createAuth(config, database);
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createSharingApp({ database, auth, publicOrigin: config.publicOrigin }));
  app.route("/", createShareViewerApp({ database, storage }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bearerOptions = {
    jwksUrl: `${baseUrl}/api/auth/jwks`,
    resource,
    issuer,
    challengeScopes: ["artifacts:read", "artifacts:write"],
  };
  singleAudienceVerifier = createMcpBearerVerifier(auth, bearerOptions);
  dualAudienceVerifier = createMultiAudienceBearerVerifier(auth, [
    bearerOptions,
    { ...bearerOptions, resource: apiResource, challengeScopes: [...API_RESOURCE_SCOPES] },
  ]);
  app.route("/", createLibraryApp({ database, auth, storage, bearerVerifier: dualAudienceVerifier }));
  app.route(
    "/",
    createMcpApp(auth, {
      ...bearerOptions,
      allowedHosts: [new URL(baseUrl).host],
      allowedOrigins: [config.publicOrigin],
    }),
  );
  owner = await identity();
  reader = await identity();
  stranger = await identity();
  narrowToken = await earnToken(owner.cookie, "artifacts:write");
  apiToken = await earnToken(owner.cookie, "artifacts:read", apiResource);
  artifactId = await seed();
  markdownId = await seed("markdown");
  deletedId = await seed();
  assert.equal((await markArtifactDeleted(database.db, deletedId, owner.id)).ok, true);
  const grant = await post(`/api/artifacts/${artifactId}/shares`, { email: reader.email }, owner.cookie);
  assert.equal(grant.status, 201);
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  try {
    if (storage && database) {
      const own = new Set([
        ...usedKeys,
        ...(await database.pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions"`)).rows.map(
          (row) => row.storageKey,
        ),
      ]);
      let remaining = 0;
      for (const key of own) {
        await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
        const left = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })).then(
          () => true,
          () => false,
        );
        if (left) remaining += 1;
      }
      assert.equal(remaining, 0, "every own S3 key was deleted");
      const leftover = [...(await revisionKeys())].filter((key) => !baselineKeys.has(key));
      assert.deepEqual(leftover, [], "this run left no revision object behind");
      storage.destroy();
    }
  } finally {
    if (database) await database.close();
    if (admin) {
      await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
      const left = await admin.query<{ count: number }>(
        "select count(*)::int as count from pg_database where datname = $1",
        [databaseName],
      );
      assert.equal(left.rows[0]?.count, 0);
      await admin.end();
    }
  }
});

test("owner bearer renders the byte-identical cookie viewer, including browser Origin", async () => {
  const cookie = await viewer(undefined, owner.cookie);
  const bearer = await viewer(owner.token, undefined, artifactId, config.publicOrigin);
  assert.equal(cookie.status, 200);
  assert.equal(bearer.status, 200);
  assert.equal(withoutManagement(await bearer.text()), withoutManagement(await cookie.text()));
  for (const header of ["content-type", "content-security-policy", "x-content-type-options", "cache-control"]) {
    assert.equal(bearer.headers.get(header), cookie.headers.get(header));
  }
  assert.equal(bearer.headers.get("set-cookie"), null);
});

test("embed=1 bearer renders chrome-less: no viewer bar at all", async () => {
  const response = await request(`/artifact/${artifactId}?embed=1`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.doesNotMatch(page, /<a\b|<b>|<header|class="vbar-|>Focus<|Sandboxed:/);
  assert.match(page, /sandbox="allow-scripts"/);
  const cookie = await request(`/artifact/${artifactId}?embed=1`, { headers: { cookie: owner.cookie } });
  assert.equal(cookie.status, 200);
  assert.equal(await cookie.text(), page);
});

test("only embed=1 changes the browser viewer", async () => {
  const normal = await viewer(owner.token);
  assert.equal(normal.status, 200);
  const page = await normal.text();
  assert.match(page, /href="\/" aria-label="Back to library"/);
  assert.match(page, /<b>Bearer viewer<\/b>/);
  for (const query of ["embed=0", "embed=true", "embed=", "embed=01"]) {
    const response = await request(`/artifact/${artifactId}?${query}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), page);
  }
});

test("the v1-audience bearer renders the same viewer page as the MCP-audience one, embed included", async () => {
  const cookie = await viewer(undefined, owner.cookie);
  const api = await viewer(apiToken);
  const legacy = await viewer(owner.token);
  assert.deepEqual([cookie.status, api.status, legacy.status], [200, 200, 200]);
  const page = withoutManagement(await cookie.text());
  assert.equal(withoutManagement(await api.text()), page);
  assert.equal(withoutManagement(await legacy.text()), page);
  const embedded = await request(`/artifact/${artifactId}?embed=1`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(embedded.status, 200);
  assert.match(await embedded.text(), /sandbox="allow-scripts"/);
});

test("a v1-audience token without artifacts:read keeps the insufficient_scope refusal", async () => {
  const writeOnly = await earnToken(owner.cookie, "artifacts:write", apiResource);
  const response = await viewer(writeOnly, owner.cookie);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer error="insufficient_scope", scope="artifacts:read"');
  assert.deepEqual(await response.json(), { error: "insufficient_scope" });
});

test("markdown embed omits back navigation and title and escapes the document", async () => {
  const response = await request(`/artifact/${markdownId}?embed=1`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.doesNotMatch(page, /<a\b|<b>|<header|class="vbar-|Rendered document:/);
  assert.doesNotMatch(page, /<iframe\b|sandbox=/);
  assert.match(page, /&lt;h1&gt;Bearer viewer/);
  assert.doesNotMatch(page, /sandbox="[^"]*allow-scripts/);
  const normal = await viewer(owner.token, undefined, markdownId);
  assert.equal(normal.status, 200);
  const normalPage = await normal.text();
  assert.match(normalPage, /href="\/" aria-label="Back to library"/);
  assert.match(normalPage, /<b>Bearer viewer<\/b>/);
  const zero = await request(`/artifact/${markdownId}?embed=0`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(zero.status, 200);
  assert.equal(await zero.text(), normalPage);
});

test("embed does not change authentication or artifact permissions", async () => {
  for (const token of [undefined, "not-a-jwt", narrowToken]) {
    const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
    const normal = await request(`/artifact/${artifactId}`, { headers });
    const embedded = await request(`/artifact/${artifactId}?embed=1`, { headers });
    assert.equal(embedded.status, 401);
    assert.equal(await embedded.text(), await normal.text());
    assert.equal(embedded.headers.get("www-authenticate"), normal.headers.get("www-authenticate"));
  }
  const denied = await request(`/artifact/${artifactId}?embed=1`, {
    headers: { authorization: `Bearer ${stranger.token}`, cookie: owner.cookie },
  });
  const missing = await viewer(owner.token, undefined, randomUUID());
  assert.equal(denied.status, 404);
  assert.equal(await denied.text(), await missing.text());
});

test("public viewers ignore embed: they are browser-facing pages", async () => {
  for (const id of [artifactId, markdownId]) {
    const created = await post(`/api/artifacts/${id}/links`, {}, owner.cookie);
    assert.equal(created.status, 201);
    const { token } = (await created.json()) as { token: string };
    const normal = await request(`/share/${token}`);
    assert.equal(normal.status, 200);
    const page = await normal.text();
    assert.doesNotMatch(page, /<a\b|<b>/);
    const embedded = await request(`/share/${token}?embed=1`);
    assert.equal(embedded.status, 200);
    assert.equal(await embedded.text(), page);
  }
});

test("a shared reader sees the same artifact bytes and cannot comment", async () => {
  const response = await viewer(reader.token);
  assert.equal(response.status, 200);
  const cookie = await viewer(undefined, owner.cookie);
  assert.equal(cookie.status, 200);
  const readerPage = await response.text();
  const ownerPage = await cookie.text();
  const srcdoc = (html: string) => /srcdoc="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.equal(srcdoc(readerPage), srcdoc(ownerPage));
  const canComment = (html: string) =>
    JSON.parse(/id="viewer-comments-data">([^<]*)/.exec(html)?.[1] ?? "{}").canComment;
  assert.equal(canComment(readerPage), false);
  assert.equal(canComment(ownerPage), true);
});

test("unrelated bearer cannot borrow an owner cookie and is indistinguishable from missing", async () => {
  const denied = await viewer(stranger.token, owner.cookie);
  const missing = await viewer(owner.token, undefined, randomUUID());
  assert.equal(denied.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await denied.text(), await missing.text());
  for (const header of ["content-type", "content-security-policy", "cache-control"])
    assert.equal(denied.headers.get(header), missing.headers.get(header));
});

test("soft-deleted artifacts stay unreadable to the owner bearer", async () => {
  const response = await viewer(owner.token, undefined, deletedId);
  const missing = await viewer(owner.token, undefined, randomUUID());
  assert.equal(response.status, 404);
  assert.equal(await response.text(), await missing.text());
});

test("garbage, expired and foreign tokens refuse even with a valid cookie", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await signedToken({
    sub: owner.id,
    scope: "artifacts:read",
    aud: resource,
    iss: issuer,
    iat: now - 120,
    exp: now - 60,
  });
  const foreign = await signedToken({
    sub: owner.id,
    scope: "artifacts:read",
    aud: `${resource}/foreign`,
    iss: issuer,
    exp: now + 60,
  });
  const foreignIssuer = await signedToken({
    sub: owner.id,
    scope: "artifacts:read",
    aud: resource,
    iss: `${issuer}/foreign`,
    exp: now + 60,
  });
  const noSubject = await signedToken({ scope: "artifacts:read", aud: resource, iss: issuer, exp: now + 60 });
  for (const token of ["not-a-jwt", "", expired, foreign, foreignIssuer, noSubject]) {
    const response = await viewer(token, owner.cookie);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.text()).includes("<iframe"), false);
  }
});

test("write-only token gets 401 insufficient_scope naming artifacts:read", async () => {
  const response = await viewer(narrowToken, owner.cookie);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer error="insufficient_scope", scope="artifacts:read"');
  assert.deepEqual(await response.json(), { error: "insufficient_scope" });
});

test("no header and no session keeps the exact cookie-path refusal", async () => {
  const response = await viewer();
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '{"error":"unauthorized"}');
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("bearer does not authenticate sibling cookie-only library endpoints", async () => {
  for (const path of ["/api/artifacts", "/api/artifacts/shared", `/api/artifacts/${artifactId}`]) {
    const response = await request(path, { headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});

test("MCP still verifies bearers and preserves its Host/Origin guard", async () => {
  const call = (token: string, origin?: string) =>
    request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const valid = await call(owner.token, config.publicOrigin);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { jsonrpc: "2.0", id: 1, result: { tools: [] } });
  const invalid = await call("not-a-jwt");
  assert.equal(invalid.status, 401);
  assert.ok((invalid.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
  const foreign = await call(owner.token, "http://evil.example");
  assert.equal(foreign.status, 403);
  await foreign.arrayBuffer();
});

test("a refusal from every audience keeps the single-audience challenge bytes", async () => {
  const now = Math.floor(Date.now() / 1000);
  const foreignAudience = await signedToken({
    sub: owner.id,
    scope: "artifacts:read",
    aud: `${resource}/foreign`,
    iss: issuer,
    exp: now + 60,
  });
  const read = async (response: Response) => ({
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: await response.text(),
  });
  for (const token of ["not-a-jwt", foreignAudience]) {
    let handled = 0;
    const handler = () => {
      handled += 1;
      return new Response("handled", { status: 200 });
    };
    const ask = () =>
      new Request(`${baseUrl}/artifact/${artifactId}`, { headers: { authorization: `Bearer ${token}` } });
    const baseline = await read(await singleAudienceVerifier(ask(), handler));
    const dual = await read(await dualAudienceVerifier(ask(), handler));
    assert.deepEqual(dual, baseline);
    assert.equal(dual.status, 401);
    assert.equal(handled, 0, "a refused token never reaches the handler");
  }
});

test("an api/v1-audience bearer stays off /mcp and off the cookie-only library reads", async () => {
  const mcp = await request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: config.publicOrigin,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 401);
  assert.ok((mcp.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
  assert.equal((await mcp.text()).includes('"tools"'), false, "no tool list is served to a foreign audience");
  for (const path of ["/api/artifacts", "/api/artifacts/shared", `/api/artifacts/${artifactId}`]) {
    const response = await request(path, { headers: { authorization: `Bearer ${apiToken}` } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
});

test("a stranger api/v1 token gets the same 404 as a missing artifact and cannot borrow an owner cookie", async () => {
  const strangerApiToken = await earnToken(stranger.cookie, "artifacts:read", apiResource);
  const denied = await viewer(strangerApiToken, owner.cookie);
  const missing = await viewer(owner.token, undefined, randomUUID());
  assert.deepEqual([denied.status, missing.status], [404, 404]);
  assert.equal(await denied.text(), await missing.text());
});

test("a granted recipient's api/v1 token reaches the viewer byte-identical to their cookie page", async () => {
  const readerApiToken = await earnToken(reader.cookie, "artifacts:read", apiResource);
  const bearer = await viewer(readerApiToken);
  const cookie = await viewer(undefined, reader.cookie);
  assert.deepEqual([bearer.status, cookie.status], [200, 200]);
  assert.equal(await bearer.text(), await cookie.text());
});

test("a multi-audience verifier without an audience refuses to be built", () => {
  assert.throws(() => createMultiAudienceBearerVerifier(auth, []), TypeError);
});
