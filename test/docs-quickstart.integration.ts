import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { ARTIFACT_KINDS } from "@artiflow/domain/kinds";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { MAX_CHUNK_BYTES } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import { createMcpApp, createMcpBearerVerifier } from "../apps/api/src/mcp/mount.ts";
import { publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import { createShareViewerApp, createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { VIEWER_CSP } from "../apps/api/src/viewer/html.ts";
import { startOAuthHarness, type OAuthHarness } from "./helpers/oauth.ts";

const QUICKSTART = fileURLToPath(new URL("../apps/web/src/content/docs/docs/start/quickstart.md", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const S3_VARS = [
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
];
const ENV_READY = Boolean(DATABASE_URL) && S3_VARS.every((name) => process.env[name]);
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=test/integration-config.example";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type QuickstartSample = { arguments: Record<string, unknown>; text: string; bytes: Buffer };
type ToolResult = {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};
type Created = { artifactId: string; revisionId: string; revisionNumber: number; sizeBytes: number; sha256: string };
type Reply = { status: number; headers: Headers; text: string; json: Record<string, unknown> | null };

let harness: OAuthHarness;
let admin: Pool;
let database: Database;
let blobStore: Storage;
let storage: Storage;
let databaseName = "";
let cookie = "";
let writeToken = "";
let mcpBaseUrl = "";
let publicOrigin = "";
let sample: QuickstartSample;
let created: Created | undefined;
let namespacePrefix = "";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const namespaceObjects = async (): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await blobStore.client.send(
      new ListObjectsV2Command({
        Bucket: blobStore.bucket,
        Prefix: namespacePrefix,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return keys.sort();
};
const revisionKeyOf = async (revisionId: string): Promise<string> => {
  const row = await database.pool.query<{ storageKey: string }>(
    `select "storageKey" from "artifactRevisions" where "id" = $1`,
    [revisionId],
  );
  const storageKey = row.rows[0]?.storageKey;
  assert.ok(typeof storageKey === "string", "the revision row names its own storage key");
  return namespacePrefix + storageKey;
};

function namespacedBlobStore(base: Storage, prefix: string): Storage {
  const client = new Proxy(base.client, {
    get(target, property, receiver) {
      if (property !== "send") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (command: { input?: { Key?: unknown } }) => {
        const key = command.input?.Key;
        if (command.input !== undefined && typeof key === "string") {
          (command.input as { Key: string }).Key = `${prefix}${key}`;
        }
        return target.send(command as never);
      };
    },
  });
  return { ...base, client };
}

function loadQuickstart(): QuickstartSample {
  const source = readFileSync(QUICKSTART, "utf8");
  const fences = [...source.matchAll(/```json title="artifact_write"\n([\s\S]*?)\n```/g)];
  assert.equal(fences.length, 1, "the quickstart carries exactly one artifact_write payload");
  const body = fences[0]?.[1];
  if (typeof body !== "string") assert.fail("the quickstart payload fence is empty");
  const callArguments = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(callArguments).sort(), ["kind", "text", "title"]);
  assert.equal(callArguments.kind, "html");
  assert.equal(callArguments.title, "Pricing comparison");
  const text = callArguments.text;
  if (typeof text !== "string") assert.fail("the quickstart payload has no text");
  return { arguments: callArguments, text, bytes: Buffer.from(text, "utf8") };
}

const unescapeAttribute = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const srcdocOf = (html: string): string => {
  const srcdoc = /srcdoc="([^"]*)"/.exec(html)?.[1];
  if (srcdoc === undefined) assert.fail("the artifact page has no srcdoc frame");
  return unescapeAttribute(srcdoc);
};

const read = async (path: string, init: RequestInit = {}): Promise<Reply> => {
  const response = await harness.request(path, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
};

const mutate = (method: "POST" | "DELETE", path: string, body: unknown): Promise<Reply> =>
  read(path, {
    method,
    headers: { cookie, origin: publicOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const createdArtifact = (): Created => {
  if (created === undefined) assert.fail("the quickstart replay did not produce an artifact");
  return created;
};

const payloadOf = (result: ToolResult): Record<string, unknown> => {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") assert.fail("the tool result carries no JSON text");
  return JSON.parse(text) as Record<string, unknown>;
};

const connect = async (): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBaseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${writeToken}` } },
  });
  const client = new Client({ name: "artiflow-docs-quickstart", version: "0.0.0" });
  await client.connect(transport);
  return client;
};

const callTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

const integration = (name: string, run: () => Promise<void>) => test(name, { skip: SKIP, timeout: 60_000 }, run);

before(async () => {
  if (!ENV_READY) return;
  const config = loadConfig(process.env);
  publicOrigin = config.publicOrigin;
  sample = loadQuickstart();
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_docs_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^artiflow_docs_test_[0-9a-f]{32}$/);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const ownUrl = new URL(DATABASE_URL);
  ownUrl.pathname = `/${databaseName}`;
  database = createDatabase(ownUrl.toString());
  await migrate(drizzle(database.pool), { migrationsFolder: MIGRATIONS });
  blobStore = createStorage(config.storage);
  namespacePrefix = `docs-quickstart/${randomUUID().replaceAll("-", "")}/`;
  storage = namespacedBlobStore(blobStore, namespacePrefix);
  assert.deepEqual(await namespaceObjects(), [], "the run-specific storage namespace starts empty");
  const RESOURCE = publicResource(config);
  const ISSUER = publicIssuer(config);
  harness = await startOAuthHarness(config, {
    mount: ({ auth, baseUrl }) => {
      mcpBaseUrl = baseUrl;
      const mcpAuth = {
        jwksUrl: `${baseUrl}/api/auth/jwks`,
        resource: RESOURCE,
        issuer: ISSUER,
        challengeScopes: ["artifacts:read", "artifacts:write"],
      };
      const app = new Hono();
      app.route("/", createSharingApp({ database, auth, publicOrigin }));
      app.route("/", createShareViewerApp({ database, storage }));
      app.route(
        "/",
        createLibraryApp({
          database,
          auth,
          storage,
          deletion: { publicOrigin },
          bearerVerifier: createMcpBearerVerifier(auth, mcpAuth),
        }),
      );
      app.route(
        "/",
        createMcpApp(auth, {
          allowedHosts: [new URL(baseUrl).host, new URL(publicOrigin).host],
          allowedOrigins: [publicOrigin],
          ...mcpAuth,
          mcpServerFactory: createArtifactTools({
            backend: createMcpBackend(database, storage),
            requireScope: "artifacts:write",
            readScope: "artifacts:read",
          }),
        }),
      );
      return app;
    },
  });
  cookie = await harness.credentialSessionCookie();
  const token = await harness.authorizeToken(
    await harness.seedPublicClient(),
    cookie,
    "artifacts:read artifacts:write",
  );
  writeToken = token.access_token;
  assert.equal(writeToken.length > 0, true, "the harness issued an access token");
  const subject = (
    JSON.parse(Buffer.from(writeToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
    }
  ).sub;
  if (typeof subject !== "string" || subject === "") assert.fail("the access token carries no subject claim");
  await database.pool.query(
    `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Docs Quickstart Owner', $2, false)`,
    [subject, `${subject}@example.test`],
  );
});

after(async () => {
  if (!ENV_READY) return;
  if (blobStore !== undefined && namespacePrefix !== "") {
    for (const key of await namespaceObjects()) {
      await blobStore.client.send(new DeleteObjectCommand({ Bucket: blobStore.bucket, Key: key }));
    }
    assert.deepEqual(await namespaceObjects(), [], "this run's namespaced objects are gone");
  }
  if (blobStore !== undefined) blobStore.destroy();
  if (database !== undefined) await database.close();
  if (admin !== undefined && databaseName !== "") {
    await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
    const leftover = await admin.query<{ present: boolean }>(
      "select exists (select 1 from pg_database where datname = $1) as present",
      [databaseName],
    );
    assert.equal(leftover.rows[0]?.present, false, "this run's database by exact name is gone");
    await admin.end();
  }
  if (harness !== undefined) await harness.close();
});

integration("the documented artifact_write call returns revision 1 for the exact documented bytes", async () => {
  const client = await connect();
  try {
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === "artifact_write"),
      true,
    );
    const result = await callTool(client, "artifact_write", sample.arguments);
    assert.equal(result.isError ?? false, false, JSON.stringify(payloadOf(result)));
    const payload = payloadOf(result);
    assert.deepEqual(Object.keys(payload).sort(), [
      "artifactId",
      "observedSizeBytes",
      "revisionId",
      "revisionNumber",
      "sha256",
      "sizeBytes",
    ]);
    assert.match(String(payload.artifactId), UUID_RE);
    assert.match(String(payload.revisionId), UUID_RE);
    assert.equal(payload.revisionNumber, 1);
    assert.equal(payload.sizeBytes, sample.bytes.length);
    assert.equal(payload.observedSizeBytes, sample.bytes.length);
    assert.equal(payload.sha256, sha256Of(sample.bytes));
    assert.deepEqual(result.structuredContent, payload, "the viewer channel carries the same result");

    const readBack = await callTool(client, "artifact_get", { artifactId: String(payload.artifactId) });
    assert.equal(readBack.isError ?? false, false, JSON.stringify(payloadOf(readBack)));
    const stored = payloadOf(readBack);
    assert.equal(stored.revisionId, payload.revisionId);
    assert.equal(stored.sha256, payload.sha256);
    assert.equal(stored.sizeBytes, payload.sizeBytes);
    const decoded = Buffer.from(String(stored.contentBase64), "base64");
    assert.equal(decoded.equals(sample.bytes), true, "the stored bytes are the documented page");
    assert.equal(sha256Of(decoded), String(payload.sha256));

    created = {
      artifactId: String(payload.artifactId),
      revisionId: String(payload.revisionId),
      revisionNumber: 1,
      sizeBytes: sample.bytes.length,
      sha256: String(payload.sha256),
    };
    assert.deepEqual(
      await namespaceObjects(),
      [await revisionKeyOf(String(payload.revisionId))],
      "the documented call stored exactly one object, under the key its revision row names",
    );
  } finally {
    await client.close();
  }

  const owned = await read("/api/artifacts", { headers: { cookie } });
  assert.equal(owned.status, 200);
  const rows = owned.json?.artifacts as { id: string; title: string; kind: string; revisionCount: number }[];
  const current = createdArtifact();
  assert.deepEqual(
    rows.map((row) => [row.id, row.title, row.kind, row.revisionCount]),
    [[current.artifactId, "Pricing comparison", "html", 1]],
  );
});

integration("the signed-in artifact page renders the documented page inside one sandboxed frame", async () => {
  const artifactId = createdArtifact().artifactId;
  const page = await read(`/artifact/${artifactId}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=UTF-8");
  assert.equal(page.headers.get("content-security-policy"), VIEWER_CSP);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("cache-control"), "no-store");
  const ownedFrame = srcdocOf(page.text);
  assert.equal(ownedFrame.startsWith(sample.text), true, "the stored page leads the frame");
  assert.equal(ownedFrame.slice(sample.text.length).includes("data-artiflow-bridge"), true);
  assert.equal(page.text.includes('sandbox="allow-scripts"'), true);
  assert.equal(page.text.includes("allow-same-origin"), false);
  assert.equal(page.text.match(/<iframe /g)?.length, 1);
  assert.equal(/<link\b|<img\b/.test(page.text), false, "no external image, font or stylesheet is loaded");
  assert.equal(page.text.includes("<b>Pricing comparison</b>"), true, "the bar names the artifact");
  assert.equal(page.text.includes('<span class="vbar-version">v1</span>'), true, "the bar shows the revision");
  assert.equal(page.text.includes('title="Focus mode (F)"'), true);
  assert.equal(page.text.includes('event.key === "Escape"'), true);
  for (const term of ["connect-src *", " ws:", " data:", "'unsafe-eval'", "frame-ancestors"])
    assert.equal(page.headers.get("content-security-policy")?.includes(term), false, term);
  assert.equal(
    page.text.includes(`"/api/artifacts/${artifactId}"`),
    true,
    "the poller reads the widened owner-or-current-grant metadata route",
  );

  const anonymous = await read(`/artifact/${artifactId}`);
  assert.deepEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }]);
});

integration("a public link opens without a session and revoking it denies access again", async () => {
  const artifactId = createdArtifact().artifactId;
  const linksPath = `/api/artifacts/${artifactId}/links`;
  const createdLink = await mutate("POST", linksPath, {});
  assert.equal(createdLink.status, 201);
  const link = createdLink.json ?? {};
  assert.deepEqual(Object.keys(link).sort(), ["id", "showComments", "token", "url"]);
  assert.equal(link.showComments, false);
  assert.match(String(link.id), UUID_RE);
  assert.match(String(link.token), LINK_TOKEN_RE);
  assert.equal(link.url, `${publicOrigin}/share/${String(link.token)}`);
  const sharePath = new URL(String(link.url)).pathname;

  const anonymous = await read(sharePath);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("content-type"), "text/html; charset=UTF-8");
  assert.equal(anonymous.headers.get("content-security-policy"), VIEWER_CSP);
  assert.equal(anonymous.headers.get("x-content-type-options"), "nosniff");
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  assert.equal(anonymous.headers.get("x-robots-tag"), "noindex");
  const publicFrame = srcdocOf(anonymous.text);
  assert.equal(publicFrame.startsWith(sample.text), true, "the stored page leads the public frame");
  assert.equal(publicFrame.slice(sample.text.length).includes("data-artiflow-bridge"), true);
  assert.equal(anonymous.text.includes('href="/"'), false, "the public page carries no back link");
  assert.equal(anonymous.text.includes("<b>"), false, "the public page does not name the artifact");

  const live = (await read(linksPath, { headers: { cookie } })).json?.links as {
    id: string;
    revokedAt: string | null;
  }[];
  assert.deepEqual(
    live.map((row) => [row.id, row.revokedAt]),
    [[link.id, null]],
    "the live link is listed for the owner",
  );

  const off = await mutate("DELETE", `${linksPath}/${String(link.id)}`, {});
  assert.deepEqual([off.status, off.json], [200, { ok: true }]);

  const revoked = await read(sharePath);
  assert.equal(revoked.status, 404);
  assert.equal(revoked.headers.get("cache-control"), "no-store");
  const unknown = await read(`/share/${"A".repeat(43)}`);
  assert.equal(unknown.status, 404);
  assert.equal(revoked.text, unknown.text, "a revoked link is indistinguishable from an unknown token");

  const stillOwner = await read(`/artifact/${artifactId}`, { headers: { cookie } });
  assert.equal(stillOwner.status, 200, "revocation withdraws public access only");
  const relisted = (await read(linksPath, { headers: { cookie } })).json?.links as {
    revokedAt: string | null;
  }[];
  assert.equal(typeof relisted[0]?.revokedAt, "string");
});

integration("the documented limits refuse an oversized write and an unsupported kind without writing", async () => {
  const client = await connect();
  try {
    const oversized = "a".repeat(MAX_CHUNK_BYTES + 1);
    const refused = await callTool(client, "artifact_write", { text: oversized, title: "Oversized" });
    assert.equal(refused.isError, true);
    const payload = payloadOf(refused);
    assert.equal(payload.error, "too_large");
    assert.equal(payload.maxBytes, MAX_CHUNK_BYTES);
    assert.equal(payload.observedBytes, MAX_CHUNK_BYTES + 1);
    const unsupported = await callTool(client, "artifact_write", {
      text: "x",
      kind: "spreadsheet",
      title: "Unsupported kind",
    });
    assert.equal(unsupported.isError, true);
    const message = unsupported.content?.[0]?.text ?? "";
    assert.match(message, /Invalid arguments for tool artifact_write/);
    for (const kind of ARTIFACT_KINDS) assert.equal(message.includes(kind), true, kind);
  } finally {
    await client.close();
  }

  assert.deepEqual(
    await namespaceObjects(),
    [await revisionKeyOf(createdArtifact().revisionId)],
    "the refused writes added no object: only the documented revision is stored",
  );
  const rows = (await read("/api/artifacts", { headers: { cookie } })).json?.artifacts as { id: string }[];
  assert.deepEqual(
    rows.map((row) => row.id),
    [createdArtifact().artifactId],
    "a refused write creates no artifact",
  );
});
