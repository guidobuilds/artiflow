import assert from "node:assert/strict";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { REVISION_KEY_PREFIX } from "../apps/api/src/adapters/storage/s3.ts";
import { createApiApp } from "../apps/api/src/app.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { publicApiResource, publicIssuer } from "../apps/api/src/oauth.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { v1ArtifactBytesResponseSchema, createArtifactResponseSchema } from "@artiflow/contracts/artifacts";
import { createPkce } from "./helpers/oauth.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const config = loadConfig(process.env);
const apiResource = publicApiResource(config);
const issuer = publicIssuer(config);
const markdown = `# Bearer v1 ${randomUUID()}\n\nBody line.\n`;
const digest = createHash("sha256").update(markdown).digest("hex");

type Session = { cookie: string; id: string };
let admin: Pool, database: Database, storage: Storage, server: ReturnType<typeof serve>;
let owner: Session,
  ownerWide: string,
  ownerRead: string,
  ownerId = "",
  documentId = "",
  databaseName = "";
let baseUrl = "";
const usedKeys: string[] = [];
let baselineKeys = new Set<string>();
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
  fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
const postWithOrigin = (path: string, body: unknown, cookie?: string) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.publicOrigin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

async function earnToken(cookie: string, scope: string, withResource: string): Promise<string> {
  const redirectUri = "http://127.0.0.1:5173/oauth/callback";
  const registration = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "API v1 integration",
      redirect_uris: [redirectUri],
      application_type: "native",
      token_endpoint_auth_method: "none",
      resources: [withResource],
    }),
  });
  if (registration.status !== 201)
    throw new Error(`registration failed: HTTP ${registration.status} — ${await registration.text()}`);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const pkce = createPkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    resource: withResource,
    state: randomUUID(),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  const authorized = await request(`/api/auth/oauth2/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
  if (authorized.status !== 200)
    throw new Error(`authorize failed: HTTP ${authorized.status} — ${await authorized.text()}`);
  const { url } = (await authorized.json()) as { url: string };
  assert.ok(url.startsWith("/consent?"));
  const consent = await postWithOrigin(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: url.slice("/consent?".length) },
    cookie,
  );
  if (consent.status !== 200) throw new Error(`consent failed: HTTP ${consent.status} — ${await consent.text()}`);
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
      resource: withResource,
    }).toString(),
  });
  if (exchanged.status !== 200)
    throw new Error(`exchange failed: HTTP ${exchanged.status} — ${await exchanged.text()}`);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

async function seedSession(): Promise<Session> {
  const account = await trustedSession(
    { database, baseUrl, origin: config.publicOrigin },
    { name: "API v1 integration", email: `v1-${randomUUID()}@example.test` },
  );
  return { cookie: account.cookie, id: account.userId };
}

async function seedMarkdownOwnership(ownerIdText: string): Promise<string> {
  const bytes = Buffer.from(markdown);
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(
    (
      await createUpload(database.db, {
        ownerId: ownerIdText,
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
        ownerId: ownerIdText,
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
    ownerId: ownerIdText,
    uploadId,
    bytes,
    title: "Bearer v1",
    kind: "markdown",
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
  admin = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_v1_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^artiflow_v1_test_[0-9a-f]{32}$/);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  storage = createStorage(config.storage);
  baselineKeys = await revisionKeys();
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const value = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(value));
    });
    probe.once("error", reject);
  });
  const internalOrigin = `http://127.0.0.1:${port}`;
  const app = createApiApp({ config: { ...config, internalOrigin, apiPort: port }, database, storage });
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${port}`;
  owner = await seedSession();
  ownerId = owner.id;
  documentId = await seedMarkdownOwnership(ownerId);
  ownerWide = await earnToken(owner.cookie, "artifacts:read artifacts:write comments:write shares:manage", apiResource);
  ownerRead = await earnToken(owner.cookie, "artifacts:read", apiResource);
});

after(async () => {
  await server?.close();
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
    await database?.close();
    await admin?.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
    await admin?.end();
  }
});

test("reads list, detail and document for the resource-bound token", async () => {
  const empty = await request("/api/v1/artifacts", bearer(ownerRead));
  if (empty.status !== 200) throw new Error(`v1 list failed: HTTP ${empty.status} — ${await empty.text()}`);
  const list = (await empty.json()) as { artifacts: { id: string }[] };
  assert.ok(list.artifacts.some((row) => row.id === documentId));
  const detail = await request(`/api/v1/artifacts/${documentId}`, bearer(ownerRead));
  assert.equal(detail.status, 200);
  const document = await request(`/api/v1/artifacts/${documentId}/document`, bearer(ownerRead));
  assert.equal(document.status, 200);
  const body = (await document.json()) as { text: string; revisionId: string };
  assert.equal(body.text, markdown);
  assert.ok(body.revisionId.length > 0);
});

test("document save under artifacts:write advances the revision", async () => {
  const read = await request(`/api/v1/artifacts/${documentId}/document`, bearer(ownerWide));
  const { revisionId } = (await read.json()) as { revisionId: string };
  const next = `${markdown}\nExtra line.\n`;
  const save = await request(`/api/v1/artifacts/${documentId}/document`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ text: next, expectedRevisionId: revisionId }),
  });
  if (save.status !== 200) throw new Error(`save failed: HTTP ${save.status} — ${await save.text()}`);
  const saved = (await save.json()) as { revisionNumber: number };
  assert.equal(saved.revisionNumber, 2);
});

test("a read-only token is refused the write with an insufficient-scope challenge", async () => {
  const response = await request(`/api/v1/artifacts/${documentId}/document`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerRead}` },
    body: JSON.stringify({ text: "should not land", expectedRevisionId: "whatever" }),
  });
  assert.equal(response.status, 403);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /scope="artifacts:write"/);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/127\.0\.0\.1:5173\/\.well-known\/oauth-protected-resource\/api\/v1"/,
  );
  const current = await request(`/api/v1/artifacts/${documentId}/document`, bearer(ownerRead));
  assert.equal(((await current.json()) as { text: string }).text.includes("should not land"), false);
});

test("the MCP-audience token is invalid on the API resource and vice versa", async () => {
  const mcpToken = await earnToken(
    owner.cookie,
    "artifacts:read artifacts:write offline_access",
    publicIssuerResource(),
  );
  const response = await request("/api/v1/artifacts", { headers: { authorization: `Bearer ${mcpToken}` } });
  assert.equal(response.status, 401);
  const mcp = await request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerRead}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: config.publicOrigin,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 401);
  assert.ok((mcp.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
  assert.equal((await mcp.text()).includes('"tools"'), false, "no tool list for a foreign audience");
});
function publicIssuerResource(): string {
  return `${config.publicOrigin}/mcp`;
}

test("comments write under comments:write, resolve and delete included", async () => {
  const created = await request(`/api/v1/artifacts/${documentId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({
      anchor: { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 9, quotedText: "# Bearer" },
      body: "Looks good",
    }),
  });
  if (created.status !== 201)
    throw new Error(`comment create failed: HTTP ${created.status} — ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  assert.ok(id.length > 0);
  const resolved = await request(`/api/v1/artifacts/${documentId}/comments/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  if (resolved.status !== 200) throw new Error(`resolve failed: HTTP ${resolved.status} — ${await resolved.text()}`);
  const removed = await request(`/api/v1/artifacts/${documentId}/comments/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  if (removed.status !== 200)
    throw new Error(`comment delete failed: HTTP ${removed.status} — ${await removed.text()}`);
});

test("share management under shares:manage creates and lists a public link", async () => {
  const created = await request(`/api/v1/artifacts/${documentId}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  if (created.status !== 201) throw new Error(`link create failed: HTTP ${created.status} — ${await created.text()}`);
  const revealed = (await created.json()) as { id: string; token: string };
  const links = await request(`/api/v1/artifacts/${documentId}/links`, bearer(ownerWide));
  assert.equal(links.status, 200);
  const rows = (await links.json()) as { links: { id: string }[] };
  assert.ok(rows.links.some((row) => row.id === revealed.id));
  assert.equal(JSON.stringify(rows).includes('"token"'), false, "listed links never carry the raw token");
});

test("creation by HTTP under artifacts:write returns MCP-shaped results and reaches the surface", async () => {
  const text = `<!doctype html><h1>Created by SDK ${randomUUID()}</h1>`;
  const created = await request("/api/v1/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ text }),
  });
  if (created.status !== 201) throw new Error(`create failed: HTTP ${created.status} — ${await created.text()}`);
  const value = (await created.json()) as {
    artifactId: string;
    revisionId: string;
    revisionNumber: number;
    sizeBytes: number;
    observedSizeBytes: number;
    sha256: string;
  };
  assert.equal(value.revisionNumber, 1);
  const detail = await request(`/api/v1/artifacts/${value.artifactId}`, bearer(ownerWide));
  assert.equal(detail.status, 200);
  const viewer = await request(`/artifact/${value.artifactId}`, { headers: { cookie: owner.cookie } });
  assert.equal(viewer.status, 200);
});

test("an over-cap creation is refused before any storage write", async () => {
  const text = "x".repeat(17 * 1024 * 1024);
  const response = await request("/api/v1/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 413);
  const body = (await response.json()) as { error: string; maxBytes: number };
  assert.equal(body.error, "too_large");
});

test("artifact delete under artifacts:write is the soft-delete the cookie surface serves", async () => {
  const id = await seedMarkdownOwnership(ownerId);
  const removed = await request(`/api/v1/artifacts/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  assert.equal(removed.status, 200);
  const gone = await request(`/api/v1/artifacts/${id}`, bearer(ownerWide));
  assert.equal(gone.status, 404);
});

const bytesPath = (id: string, revisionId?: string): string =>
  `/api/v1/artifacts/${id}/bytes${revisionId === undefined ? "" : `?revisionId=${encodeURIComponent(revisionId)}`}`;

const createHtml = async (text: string): Promise<{ artifactId: string; revisionId: string; sha256: string }> => {
  const created = await request("/api/v1/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ text }),
  });
  if (created.status !== 201) throw new Error(`create failed: HTTP ${created.status} — ${await created.text()}`);
  return (await created.json()) as { artifactId: string; revisionId: string; sha256: string };
};

test("the bytes read returns the current revision, digest-verified and schema-parsed", async () => {
  const text = `<!doctype html><h1>Bytes ${randomUUID()}</h1>`;
  const created = await createHtml(text);
  const response = await request(bytesPath(created.artifactId), bearer(ownerRead));
  if (response.status !== 200) throw new Error(`bytes read failed: HTTP ${response.status} — ${await response.text()}`);
  const bytes = v1ArtifactBytesResponseSchema.parse(await response.json());
  assert.deepEqual(Object.keys(bytes).sort(), [
    "artifactId",
    "contentBase64",
    "kind",
    "revisionId",
    "revisionNumber",
    "sha256",
    "sizeBytes",
  ]);
  assert.deepEqual(
    [bytes.artifactId, bytes.revisionId, bytes.revisionNumber, bytes.kind],
    [created.artifactId, created.revisionId, 1, "html"],
  );
  assert.deepEqual([bytes.sha256, bytes.sizeBytes], [created.sha256, Buffer.byteLength(text)]);
  assert.equal(Buffer.from(bytes.contentBase64, "base64").toString("utf8"), text);
});

test("the pinned revisionId selector reads exactly that revision and never falls back to latest", async () => {
  const id = await seedMarkdownOwnership(ownerId);
  const read = await request(`/api/v1/artifacts/${id}/document`, bearer(ownerWide));
  const first = (await read.json()) as { revisionId: string; revisionNumber: number };
  const saved = await request(`/api/v1/artifacts/${id}/document`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ text: `${markdown}Pinned second revision.\n`, expectedRevisionId: first.revisionId }),
  });
  if (saved.status !== 200) throw new Error(`save failed: HTTP ${saved.status} — ${await saved.text()}`);
  const second = (await saved.json()) as { revisionId: string };
  assert.notEqual(second.revisionId, first.revisionId);

  const pinned = await request(bytesPath(id, first.revisionId), bearer(ownerRead));
  if (pinned.status !== 200) throw new Error(`pinned read failed: HTTP ${pinned.status} — ${await pinned.text()}`);
  const pinnedBytes = v1ArtifactBytesResponseSchema.parse(await pinned.json());
  assert.deepEqual(
    [pinnedBytes.revisionId, pinnedBytes.revisionNumber, pinnedBytes.sha256, pinnedBytes.kind],
    [first.revisionId, first.revisionNumber, digest, "markdown"],
  );
  assert.equal(Buffer.from(pinnedBytes.contentBase64, "base64").toString("utf8"), markdown);

  const latest = await request(bytesPath(id), bearer(ownerRead));
  assert.equal(((await latest.json()) as { revisionId: string }).revisionId, second.revisionId);

  const unknown = await request(bytesPath(id, randomUUID()), bearer(ownerRead));
  assert.deepEqual([unknown.status, await unknown.text()], [404, `{"error":"not_found"}`]);
  const other = await createHtml(`<!doctype html><p>Other ${randomUUID()}</p>`);
  const foreignRevision = await request(bytesPath(id, other.revisionId), bearer(ownerRead));
  assert.deepEqual([foreignRevision.status, await foreignRevision.text()], [404, `{"error":"not_found"}`]);
  const malformed = await request(bytesPath(id, "not-a-revision-id"), bearer(ownerRead));
  assert.deepEqual([malformed.status, await malformed.text()], [404, `{"error":"not_found"}`]);
});

test("tampered stored bytes are a typed refusal that carries no content", async () => {
  const text = `<!doctype html><h1>Tamper ${randomUUID()}</h1>`;
  const created = await createHtml(text);
  const storageKey = await revisionKeyOf(created.revisionId);
  const tampered = Buffer.from(`${text} `, "utf8");
  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: storageKey,
      Body: tampered,
      ContentLength: tampered.length,
      ContentType: "text/html; charset=utf-8",
    }),
  );
  assert.notEqual(createHash("sha256").update(tampered).digest("hex"), created.sha256);
  const response = await request(bytesPath(created.artifactId), bearer(ownerRead));
  assert.equal(response.status, 500);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, { error: "artifact_unavailable", reason: "digest_mismatch" });
  assert.deepEqual(["contentBase64" in body, "sha256" in body], [false, false], "no bytes and no digest claim");
});

test("the bytes read is one 404 for strangers and missing artifacts, and a current grant reads it", async () => {
  const stranger = await seedSession();
  const strangerToken = await earnToken(stranger.cookie, "artifacts:read", apiResource);
  const refused = `{"error":"not_found"}`;
  const foreign = await request(bytesPath(documentId), bearer(strangerToken));
  assert.deepEqual([foreign.status, await foreign.text()], [404, refused], "no grant, no bytes");
  const missing = await request(bytesPath(randomUUID()), bearer(strangerToken));
  assert.deepEqual([missing.status, await missing.text()], [404, refused], "missing reads exactly like foreign");

  const email =
    (await database.pool.query<{ email: string }>(`select "email" from "user" where "id" = $1`, [stranger.id])).rows[0]
      ?.email ?? "";
  assert.ok(email.length > 0);
  const grant = await request(`/api/v1/artifacts/${documentId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: JSON.stringify({ email }),
  });
  assert.equal(grant.status, 201, "the grant is stored");
  const granted = await request(bytesPath(documentId), bearer(strangerToken));
  if (granted.status !== 200) throw new Error(`granted read failed: HTTP ${granted.status}`);
  assert.equal(v1ArtifactBytesResponseSchema.parse(await granted.json()).artifactId, documentId);
});

test("a soft-deleted artifact has no readable bytes", async () => {
  const id = await seedMarkdownOwnership(ownerId);
  assert.equal((await request(bytesPath(id), bearer(ownerRead))).status, 200);
  const removed = await request(`/api/v1/artifacts/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  assert.equal(removed.status, 200);
  const gone = await request(bytesPath(id), bearer(ownerRead));
  assert.deepEqual([gone.status, await gone.text()], [404, `{"error":"not_found"}`], "deleted is the same refusal");
});

test("the bytes read is scope-gated by the table before the handler runs", async () => {
  const commentsOnly = await earnToken(owner.cookie, "comments:write", apiResource);
  const refused = await request(bytesPath(documentId), bearer(commentsOnly));
  assert.equal(refused.status, 403);
  assert.match(refused.headers.get("www-authenticate") ?? "", /scope="artifacts:read"/);
});

const putUpdate = (id: string, body: unknown, token = ownerWide) =>
  request(`/api/v1/artifacts/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const currentRevisionOf = async (id: string): Promise<{ count: string; currentRevisionId: string | null }> =>
  (
    await database.pool.query<{ count: string; currentRevisionId: string | null }>(
      `select count(*)::text as count,
              (select "currentRevisionId" from "artifacts" where "id" = $1) as "currentRevisionId"
         from "artifactRevisions" where "artifactId" = $1`,
      [id],
    )
  ).rows[0] as { count: string; currentRevisionId: string | null };

test("an HTML update appends a revision through the same commit flow as creation", async () => {
  const created = await createHtml(`<!doctype html><h1>Before ${randomUUID()}</h1>`);
  const text = `<!doctype html><h1>After ${randomUUID()}</h1>`;
  const updated = await putUpdate(created.artifactId, {
    text,
    kind: "html",
    expectedRevisionId: created.revisionId,
    title: "Renamed by update",
  });
  if (updated.status !== 200) throw new Error(`update failed: HTTP ${updated.status} — ${await updated.text()}`);
  const value = createArtifactResponseSchema.parse(await updated.json());
  assert.deepEqual(
    [value.artifactId, value.revisionNumber, value.sizeBytes, value.observedSizeBytes],
    [created.artifactId, 2, Buffer.byteLength(text), Buffer.byteLength(text)],
  );
  assert.equal(value.sha256, createHash("sha256").update(text).digest("hex"));
  assert.notEqual(value.revisionId, created.revisionId);
  const read = await request(bytesPath(created.artifactId), bearer(ownerRead));
  const bytes = v1ArtifactBytesResponseSchema.parse(await read.json());
  assert.deepEqual([bytes.revisionId, bytes.sha256], [value.revisionId, value.sha256]);
  assert.equal(Buffer.from(bytes.contentBase64, "base64").toString("utf8"), text);
  assert.equal((await currentRevisionOf(created.artifactId)).count, "2");
  const detail = (await (await request(`/api/v1/artifacts/${created.artifactId}`, bearer(ownerRead))).json()) as {
    kind: string;
    title: string | null;
  };
  assert.deepEqual([detail.kind, detail.title], ["html", "Renamed by update"], "the optional title renames");
});

test("a stale expectedRevisionId is a conflict that commits nothing", async () => {
  const created = await createHtml(`<!doctype html><h1>CAS ${randomUUID()}</h1>`);
  const keysBefore = await revisionKeys();
  const response = await putUpdate(created.artifactId, {
    text: "<!doctype html><p>loser</p>",
    kind: "html",
    expectedRevisionId: randomUUID(),
  });
  assert.deepEqual(
    [response.status, await response.json()],
    [409, { error: "concurrent_commit", currentRevisionId: created.revisionId }],
    "the typed refusal carries the pointer a retry must use",
  );
  assert.deepEqual(
    [...(await revisionKeys())].filter((key) => !keysBefore.has(key)),
    [],
    "no bytes written",
  );
  assert.deepEqual(await currentRevisionOf(created.artifactId), { count: "1", currentRevisionId: created.revisionId });
  const bytes = v1ArtifactBytesResponseSchema.parse(
    await (await request(bytesPath(created.artifactId), bearer(ownerRead))).json(),
  );
  assert.deepEqual([bytes.revisionId, bytes.revisionNumber], [created.revisionId, 1]);
});

test("an update of a markdown artifact is wrong_kind, never a converted document", async () => {
  const id = await seedMarkdownOwnership(ownerId);
  const read = (await (await request(`/api/v1/artifacts/${id}/document`, bearer(ownerWide))).json()) as {
    revisionId: string;
  };
  const response = await putUpdate(id, {
    text: "<!doctype html><p>Not a document</p>",
    kind: "html",
    expectedRevisionId: read.revisionId,
  });
  assert.deepEqual([response.status, await response.json()], [409, { error: "wrong_kind" }]);
  const after = (await (await request(`/api/v1/artifacts/${id}/document`, bearer(ownerWide))).json()) as {
    revisionId: string;
    text: string;
  };
  assert.deepEqual([after.revisionId, after.text], [read.revisionId, markdown], "the document is untouched");
});

test("an update without expectedRevisionId is refused instead of overwriting", async () => {
  const created = await createHtml(`<!doctype html><h1>Guard ${randomUUID()}</h1>`);
  const missing = await putUpdate(created.artifactId, { text: "<!doctype html><p>blind</p>", kind: "html" });
  assert.deepEqual([missing.status, await missing.json()], [400, { error: "expected_revision_id_required" }]);
  const converted = await putUpdate(created.artifactId, {
    text: "<!doctype html><p>x</p>",
    kind: "markdown",
    expectedRevisionId: created.revisionId,
  });
  assert.deepEqual([converted.status, await converted.json()], [400, { error: "invalid_request" }]);
  assert.deepEqual(await currentRevisionOf(created.artifactId), { count: "1", currentRevisionId: created.revisionId });
});

test("a foreign artifact is not_found for the update and a read-only token never reaches it", async () => {
  const stranger = await seedSession();
  const strangerWrite = await earnToken(stranger.cookie, "artifacts:write", apiResource);
  const foreign = await putUpdate(
    documentId,
    { text: "<!doctype html><p>not mine</p>", kind: "html", expectedRevisionId: randomUUID() },
    strangerWrite,
  );
  assert.deepEqual([foreign.status, await foreign.json()], [404, { error: "not_found" }], "no existence leak");
  const readOnly = await putUpdate(
    documentId,
    { text: "<!doctype html><p>x</p>", kind: "html", expectedRevisionId: randomUUID() },
    ownerRead,
  );
  assert.equal(readOnly.status, 403);
  assert.match(readOnly.headers.get("www-authenticate") ?? "", /scope="artifacts:write"/);
});

test("an update of a soft-deleted artifact is gone", async () => {
  const created = await createHtml(`<!doctype html><h1>Deleted ${randomUUID()}</h1>`);
  const removed = await request(`/api/v1/artifacts/${created.artifactId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerWide}` },
    body: "{}",
  });
  assert.equal(removed.status, 200);
  const response = await putUpdate(created.artifactId, {
    text: "<!doctype html><p>after delete</p>",
    kind: "html",
    expectedRevisionId: created.revisionId,
  });
  assert.deepEqual([response.status, await response.json()], [404, { error: "gone" }]);
});

test("an MCP-only client registration stays unlinked from the API resource (opt-in honored)", async () => {
  const response = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP only integration",
      redirect_uris: ["http://127.0.0.1:5173/oauth/callback"],
      application_type: "native",
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.status, 201);
  const { client_id: clientId } = (await response.json()) as { client_id: string };
  const pkce = createPkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:5173/oauth/callback",
    scope: "artifacts:read",
    resource: apiResource,
    state: randomUUID(),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  const authorized = await request(`/api/auth/oauth2/authorize?${params}`, {
    headers: { cookie: owner.cookie },
    redirect: "manual",
  });
  const location = authorized.headers.get("location") ?? (await authorized.text());
  assert.equal(
    authorized.status === 200 && location.includes("consent"),
    false,
    "consent must not start for an unlinked resource",
  );
  assert.match(`${authorized.status} ${location}`, /invalid_target|access_denied/);
});

test("issuer stays the auth server; the api resource identifier is not the issuer", () => {
  assert.equal(issuer, `${config.publicOrigin}/api/auth`);
  assert.equal(apiResource, `${config.publicOrigin}/api/v1`);
});
