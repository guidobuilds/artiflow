import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { artifactMetadataSchema, type ArtifactMetadata } from "@artiflow/contracts/artifacts";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier, Pool } from "pg";

import { ARTIFACT_VIEWER_RESOURCE_URI, createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import { markArtifactDeleted } from "../apps/api/src/domain/commits.ts";
import { REVISION_KEY_PREFIX } from "../apps/api/src/adapters/storage/s3.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import {
  MAX_CHUNK_BYTES,
  MAX_COMMENT_BODY,
  MAX_COMMENT_QUOTE,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createMcpApp } from "../apps/api/src/mcp/mount.ts";
import { publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { countLeftoverTestDatabases, startOAuthHarness, type OAuthHarness } from "./helpers/oauth.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const S3_VARS = [
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
];
const ENV_READY = Boolean(DATABASE_URL) && S3_VARS.every((name) => process.env[name]);
const config = ENV_READY ? loadConfig(process.env) : undefined;
const RESOURCE = config ? publicResource(config) : "";
const ISSUER = config ? publicIssuer(config) : "";
const ACCEPT_BOTH = "application/json, text/event-stream";
const CHUNK = 4096;
const TOOL_NAMES = [
  "artifact_add_comment",
  "artifact_commit",
  "artifact_edit_lines",
  "artifact_get",
  "artifact_get_markdown",
  "artifact_list_comments",
  "artifact_put_chunk",
  "artifact_reply_comment",
  "artifact_resolve_comment",
  "artifact_start_upload",
  "artifact_unresolve_comment",
  "artifact_update_metadata",
  "artifact_write",
  "asset_upload",
  "document_apply",
  "document_create",
  "document_diff",
  "document_outline",
  "document_publish",
  "document_query",
  "document_read",
  "scene_apply",
  "scene_outline",
  "scene_read",
];

type ToolResult = {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: ToolPayload;
  _meta?: { ui?: { resourceUri?: string } };
};
type ToolPayload = Record<string, unknown>;

let harness: OAuthHarness;
let admin: Pool;
let database: Database;
let pool: Pool;
let storage: Storage;
let databaseName = "";
let ownerId = "";
let writeToken = "";
let readToken = "";
let foreignToken = "";
const usedKeys: string[] = [];

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const revisionKeyOf = async (revisionId: unknown): Promise<string> => {
  const row = await pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions" where "id" = $1`, [
    String(revisionId),
  ]);
  const storageKey = row.rows[0]?.storageKey;
  assert.ok(typeof storageKey === "string", "the revision row names its own storage key");
  return storageKey;
};
const recordRevisionKey = async (revisionId: unknown): Promise<void> => {
  usedKeys.push(await revisionKeyOf(revisionId));
};
const revisionObjects = async (): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await storage.client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: REVISION_KEY_PREFIX, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return keys;
};
const payload = (): Uint8Array => randomBytes(3 * CHUNK + 17);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const payloadOf = (result: ToolResult): ToolPayload => JSON.parse(result.content?.[0]?.text ?? "{}") as ToolPayload;

const rpc = async (token: string, body: unknown) => {
  const response = await harness.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { result?: { tools?: { name?: string }[] }; error?: { message?: string } };
};

const callTool = async (token: string, name: string, args: ToolPayload): Promise<ToolResult> => {
  const body = await rpc(token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  assert.equal(typeof body.result, "object", `tools/call failed: ${body.error?.message ?? "no result"}`);
  return body.result as ToolResult;
};

const expectOk = (result: ToolResult): ToolPayload => {
  assert.equal(result.isError ?? false, false, JSON.stringify(payloadOf(result)));
  return payloadOf(result);
};

const expectError = (result: ToolResult, error: string): ToolPayload => {
  assert.equal(result.isError, true, `expected a typed ${error} tool error`);
  const payloadBody = payloadOf(result);
  assert.equal(payloadBody.error, error);
  return payloadBody;
};

const startUpload = (bytes: Uint8Array, extra: ToolPayload = {}): Promise<ToolResult> =>
  callTool(writeToken, "artifact_start_upload", {
    declaredSizeBytes: bytes.length,
    declaredSha256: digestOf(bytes),
    ...extra,
  });

const stageChunks = async (uploadId: string, bytes: Uint8Array, only?: number): Promise<void> => {
  for (let index = 0; index * CHUNK < bytes.length; index += 1) {
    const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    if (only !== undefined && index !== only) continue;
    const staged = expectOk(
      await callTool(writeToken, "artifact_put_chunk", { uploadId, chunkIndex: index, contentBase64: b64(part) }),
    );
    assert.equal(staged.sha256, digestOf(part));
    usedKeys.push(String(staged.storageKey));
  }
};

const toolTest = (name: string, run: () => Promise<void>) =>
  test(
    name,
    { skip: ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local", timeout: 60_000 },
    run,
  );

before(async () => {
  if (!config) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_artifact_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_artifact_test_[0-9a-f]{32}$/.test(databaseName), true);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(DATABASE_URL);
  testUrl.pathname = `/${databaseName}`;
  database = createDatabase(testUrl.toString());
  pool = database.pool;
  const _sdb = database.db;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  const endpoint = new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "");
  assert.equal(
    ["127.0.0.1", "localhost"].includes(endpoint.hostname) || process.env.ARTIFLOW_TEST_S3 === "1",
    true,
    "test storage must be loopback or ARTIFLOW_TEST_S3=1",
  );
  storage = createStorage({
    endpoint: endpoint.origin,
    region: (process.env.ARTIFLOW_S3_REGION ?? "us-east-1").trim() || "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  const tools = createArtifactTools({ backend: createMcpBackend(database, storage), readScope: "artifacts:read" });
  harness = await startOAuthHarness(config, {
    mount: ({ auth, baseUrl }) =>
      createMcpApp(auth, {
        allowedHosts: [new URL(baseUrl).host, new URL(config.publicOrigin).host],
        allowedOrigins: [config.publicOrigin],
        jwksUrl: `${baseUrl}/api/auth/jwks`,
        resource: RESOURCE,
        issuer: ISSUER,
        challengeScopes: ["artifacts:read", "artifacts:write"],
        mcpServerFactory: tools,
      }),
  });
  const client = await harness.seedPublicClient();
  const cookie = await harness.credentialSessionCookie();
  writeToken = (await harness.authorizeToken(client, cookie, "artifacts:read artifacts:write")).access_token;
  readToken = (await harness.authorizeToken(client, cookie, "artifacts:read")).access_token;
  foreignToken = (await harness.authorizeToken(client, await harness.credentialSessionCookie(), "artifacts:read"))
    .access_token;
  const claims = JSON.parse(Buffer.from(writeToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    sub?: string;
  };
  ownerId = claims.sub ?? "";
  assert.equal(ownerId.length > 0, true, "access token carries a subject claim");
  await pool.query(
    `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Artifact Tools Owner', $2, false)`,
    [ownerId, `${ownerId}@example.test`],
  );
});

after(async () => {
  if (!ENV_READY) return;
  let remaining = 0;
  for (const key of usedKeys) {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    const status = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })).then(
      () => 200,
      (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode,
    );
    if (status !== 404) remaining += 1;
  }
  assert.equal(remaining, 0, "every own S3 key was deleted");
  storage.destroy();
  await harness.close();
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  await admin.end();
  assert.equal(await countLeftoverTestDatabases(), 0);
});

toolTest("tools/list advertises every artifact and document tool and a read-only token cannot write", async () => {
  const body = await rpc(writeToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual((body.result?.tools ?? []).map((tool) => tool.name).sort(), TOOL_NAMES);
  const bytes = payload();
  const denied = expectError(
    await callTool(readToken, "artifact_start_upload", {
      declaredSizeBytes: bytes.length,
      declaredSha256: digestOf(bytes),
    }),
    "insufficient_scope",
  );
  assert.equal(String(denied.message).includes('error="insufficient_scope"'), true);
  assert.equal(denied.scope, "artifacts:write");
  expectError(
    await callTool(readToken, "artifact_put_chunk", {
      uploadId: "upload-readonly",
      chunkIndex: 0,
      contentBase64: b64(bytes.subarray(0, 8)),
    }),
    "insufficient_scope",
  );
  expectError(await callTool(readToken, "artifact_commit", { uploadId: "upload-readonly" }), "insufficient_scope");
});

toolTest("artifact_start_upload is idempotent per uploadId and refuses a changed declaration", async () => {
  const bytes = payload();
  const uploadId = `upload-${randomUUID()}`;
  const declared = { declaredSizeBytes: bytes.length, declaredSha256: digestOf(bytes) };
  const first = expectOk(await startUpload(bytes, { uploadId, title: "Tool artifact" }));
  assert.equal(first.uploadId, uploadId);
  assert.equal(first.status, "open");
  const again = expectOk(await startUpload(bytes, { uploadId, ...declared }));
  assert.equal(again.uploadId, uploadId);
  expectError(await startUpload(randomBytes(bytes.length), { uploadId }), "conflict");
});

toolTest("artifact_put_chunk digests received bytes, is idempotent and conflicts on different bytes", async () => {
  const bytes = payload();
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(bytes, { uploadId })).uploadId, uploadId);
  await stageChunks(uploadId, bytes, 0);
  const first = bytes.subarray(0, CHUNK);
  const replayed = expectOk(
    await callTool(writeToken, "artifact_put_chunk", { uploadId, chunkIndex: 0, contentBase64: b64(first) }),
  );
  assert.equal(replayed.sha256, digestOf(first));
  const different = randomBytes(CHUNK);
  expectError(
    await callTool(writeToken, "artifact_put_chunk", { uploadId, chunkIndex: 0, contentBase64: b64(different) }),
    "conflict",
  );
  expectError(
    await callTool(writeToken, "artifact_put_chunk", {
      uploadId,
      chunkIndex: 1,
      contentBase64: b64(randomBytes(MAX_CHUNK_BYTES + 1)),
    }),
    "validation",
  );
  expectError(
    await callTool(writeToken, "artifact_put_chunk", { uploadId, chunkIndex: 0, contentBase64: "not base64 !!" }),
    "validation",
  );
});

toolTest("artifact_commit concatenates staged bytes into a byte-exact revision", async () => {
  const bytes = payload();
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(bytes, { uploadId })).uploadId, uploadId);
  await stageChunks(uploadId, bytes);
  const committed = expectOk(await callTool(writeToken, "artifact_commit", { uploadId }));
  assert.equal(committed.sizeBytes, bytes.length);
  assert.equal(committed.observedSizeBytes, bytes.length);
  assert.equal(committed.revisionNumber, 1);
  assert.equal(committed.sha256, digestOf(bytes));
  const structuredUpload = `upload-${randomUUID()}`;
  const structuredBytes = payload();
  assert.equal(expectOk(await startUpload(structuredBytes, { uploadId: structuredUpload })).uploadId, structuredUpload);
  await stageChunks(structuredUpload, structuredBytes);
  const structuredCommit = await callTool(writeToken, "artifact_commit", { uploadId: structuredUpload });
  expectOk(structuredCommit);
  const rawCommit = structuredCommit as unknown as { structuredContent?: ToolPayload };
  assert.deepEqual(rawCommit.structuredContent, {
    artifactId: expectOk(structuredCommit).artifactId,
    revisionId: expectOk(structuredCommit).revisionId,
    revisionNumber: 1,
    sizeBytes: structuredBytes.length,
    observedSizeBytes: structuredBytes.length,
    sha256: digestOf(structuredBytes),
  });
  await recordRevisionKey(expectOk(structuredCommit).revisionId);
  await recordRevisionKey(committed.revisionId);
  const stored = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: await revisionKeyOf(committed.revisionId) }),
  );
  const storedBytes = Buffer.concat(
    await (async () => {
      const parts: Buffer[] = [];
      for await (const part of stored.Body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
      return parts;
    })(),
  );
  assert.equal(storedBytes.equals(Buffer.from(bytes)), true, "stored revision bytes are byte-exact");
  const rows = await pool.query<{ id: string }>(
    `select "currentRevisionId" as id from "artifacts" where "id" = $1 and "ownerId" = $2`,
    [String(committed.artifactId), ownerId],
  );
  assert.deepEqual(
    rows.rows.map((row) => row.id),
    [String(committed.revisionId)],
  );
});

toolTest("artifact_commit refuses a lying declared digest and a stale expected revision", async () => {
  const before = await pool.query<{ count: number }>(`select count(*)::int as count from "artifacts"`);
  const lying = payload();
  const lyingUpload = `upload-${randomUUID()}`;
  assert.equal(
    expectOk(await startUpload(lying, { uploadId: lyingUpload, declaredSha256: digestOf(randomBytes(8)) })).uploadId,
    lyingUpload,
  );
  await stageChunks(lyingUpload, lying);
  const mismatch = expectError(
    await callTool(writeToken, "artifact_commit", { uploadId: lyingUpload }),
    "digest_mismatch",
  );
  assert.equal(mismatch.observedSha256, digestOf(lying));
  const after = await pool.query<{ count: number }>(`select count(*)::int as count from "artifacts"`);
  assert.equal(after.rows[0]?.count, before.rows[0]?.count, "a digest mismatch creates no artifact row");
  const bytes = payload();
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(bytes, { uploadId })).uploadId, uploadId);
  await stageChunks(uploadId, bytes);
  const committed = expectOk(await callTool(writeToken, "artifact_commit", { uploadId }));
  await recordRevisionKey(committed.revisionId);
  const stale = payload();
  const staleUpload = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(stale, { uploadId: staleUpload })).uploadId, staleUpload);
  await stageChunks(staleUpload, stale);
  const objectsBefore = await revisionObjects();
  const concurrent = expectError(
    await callTool(writeToken, "artifact_commit", {
      uploadId: staleUpload,
      artifactId: String(committed.artifactId),
      expectedRevisionId: randomUUID(),
    }),
    "concurrent_commit",
  );
  assert.equal(concurrent.currentRevisionId, String(committed.revisionId));
  const orphans = (await revisionObjects()).filter((key) => !objectsBefore.includes(key));
  assert.equal(orphans.length, 1, "a refused commit leaves exactly one unreferenced object");
  usedKeys.push(...orphans);
});

const rowCounts = async (): Promise<Record<string, unknown>> => {
  const result = await pool.query(
    `select (select count(*)::int from "artifacts") as "artifacts", (select count(*)::int from "artifactRevisions") as "revisions", (select count(*)::int from "artifactUploads") as "uploads", (select count(*)::int from "artifactChunks") as "chunks"`,
  );
  return result.rows[0] ?? {};
};

toolTest("artifact_commit rejects an artifact id the dashboard cannot address", async () => {
  const bytes = payload();
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(bytes, { uploadId })).uploadId, uploadId);
  await stageChunks(uploadId, bytes);
  const staged = await rowCounts();
  const objectsBefore = await revisionObjects();
  const refused = expectError(
    await callTool(writeToken, "artifact_commit", { uploadId, artifactId: "i5d-disposable-01" }),
    "invalid_artifact_id",
  );
  assert.equal(String(refused.message).includes("lowercase"), true, "the message states the required shape");
  expectError(
    await callTool(writeToken, "artifact_commit", { uploadId, artifactId: randomUUID().toUpperCase() }),
    "invalid_artifact_id",
  );
  assert.deepEqual(await rowCounts(), staged, "a rejected id writes no artifact, revision, upload or chunk row");
  assert.deepEqual(await revisionObjects(), objectsBefore, "a rejected id writes no revision object");
  const given = randomUUID();
  const committed = expectOk(await callTool(writeToken, "artifact_commit", { uploadId, artifactId: given }));
  await recordRevisionKey(committed.revisionId);
  assert.equal(committed.artifactId, given);
});

const commitBytes = async (bytes: Uint8Array, kind?: "markdown"): Promise<ToolPayload> => {
  const uploadId = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(bytes, { uploadId })).uploadId, uploadId);
  await stageChunks(uploadId, bytes);
  const committed = expectOk(await callTool(writeToken, "artifact_commit", { uploadId, ...(kind ? { kind } : {}) }));
  await recordRevisionKey(committed.revisionId);
  return committed;
};

type CommentThread = {
  id: string;
  parentId: string | null;
  authorId: string;
  author: { id: string; name: string; image: string | null };
  anchor: unknown;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  replies: CommentThread[];
};
const commentsOf = async (artifactId: unknown): Promise<CommentThread[]> =>
  expectOk(await callTool(readToken, "artifact_list_comments", { artifactId })).comments as CommentThread[];
const COMMENT_ANCHOR = { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 6, quotedText: "hello" };

toolTest("artifact_write commits authored text in one call and binds the MCP Apps viewer", async () => {
  const text = `<!doctype html><html><head><meta charset="utf-8"><title>Write tool</title></head><body><h1 id="write-tool">authored inline</h1></body></html>`;
  const bytes = new TextEncoder().encode(text);
  const created = expectOk(await callTool(writeToken, "artifact_write", { text, title: "Write tool page" }));
  assert.equal(created.revisionNumber, 1);
  assert.equal(created.sha256, digestOf(bytes));
  assert.equal(created.sizeBytes, bytes.length);
  assert.equal(created.observedSizeBytes, bytes.length);
  const listed = await rpc(writeToken, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  const writeTool = (listed.result?.tools ?? []).find((tool) => tool.name === "artifact_write") as
    { _meta?: { ui?: { resourceUri?: string } } } | undefined;
  assert.equal(
    writeTool?._meta?.ui?.resourceUri,
    ARTIFACT_VIEWER_RESOURCE_URI,
    "a creation tool binds the viewer like artifact_commit",
  );
  const read = expectOk(await callTool(writeToken, "artifact_get", { artifactId: String(created.artifactId) }));
  assert.equal(
    Buffer.from(String(read.contentBase64), "base64").equals(Buffer.from(bytes)),
    true,
    "write path is byte-exact",
  );
  await recordRevisionKey(created.revisionId);

  const doc = "# Write tool doc\n\nline two";
  const markdown = expectOk(
    await callTool(writeToken, "artifact_write", { text: doc, kind: "markdown", title: "Write tool doc" }),
  );
  await recordRevisionKey(markdown.revisionId);
  expectError(
    await callTool(writeToken, "artifact_write", { text: doc, kind: "markdown", artifactId: "not-a-uuid" }),
    "invalid_artifact_id",
  );
  const lines = expectOk(
    await callTool(writeToken, "artifact_get_markdown", { artifactId: String(markdown.artifactId) }),
  );
  assert.equal(lines.lineCount, 3);

  const revised = "# Write tool doc\n\nline two changed";
  const updated = expectOk(
    await callTool(writeToken, "artifact_write", {
      text: revised,
      kind: "markdown",
      artifactId: String(markdown.artifactId),
      expectedRevisionId: String(markdown.revisionId),
    }),
  );
  assert.equal(updated.revisionNumber, 2);
  await recordRevisionKey(updated.revisionId);
  const objectsBefore = await revisionObjects();
  expectError(
    await callTool(writeToken, "artifact_write", {
      text: revised,
      kind: "markdown",
      artifactId: String(markdown.artifactId),
      expectedRevisionId: String(markdown.revisionId),
    }),
    "concurrent_commit",
  );
  expectError(
    await callTool(writeToken, "artifact_write", {
      text,
      kind: "markdown",
      artifactId: String(created.artifactId),
      expectedRevisionId: String(created.revisionId),
    }),
    "conflict",
  );
  const orphans = (await revisionObjects()).filter((key) => !objectsBefore.includes(key));
  assert.equal(orphans.length, 2, "each refused write that got past the put leaves its bytes behind");
  usedKeys.push(...orphans);
  expectError(await callTool(writeToken, "artifact_write", { text: "a".repeat(MAX_CHUNK_BYTES + 1) }), "too_large");
  expectError(await callTool(readToken, "artifact_write", { text }), "insufficient_scope");
});

toolTest("MCP comments list, add, reply and resolve roots without creating document revisions", async () => {
  const created = await commitBytes(new TextEncoder().encode("hello\nworld"), "markdown");
  const artifactId = created.artifactId;
  assert.deepEqual(await commentsOf(artifactId), []);
  const id = expectOk(
    await callTool(writeToken, "artifact_add_comment", {
      artifactId,
      anchor: COMMENT_ANCHOR,
      body: "Root",
    }),
  ).id;
  const roots = await commentsOf(artifactId);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0], {
    id,
    parentId: null,
    authorId: ownerId,
    author: { id: ownerId, name: roots[0]!.author.name, image: null },
    anchor: COMMENT_ANCHOR,
    body: "Root",
    resolvedAt: null,
    createdAt: roots[0]!.createdAt,
    replies: [],
  });
  assert.ok(Number.isFinite(Date.parse(roots[0]!.createdAt)));
  const replyId = expectOk(
    await callTool(writeToken, "artifact_reply_comment", { artifactId, commentId: id, body: "Reply" }),
  ).id;
  const replied = await commentsOf(artifactId);
  assert.equal(replied[0]!.replies.length, 1);
  assert.equal(replied[0]!.replies[0]!.id, replyId);
  assert.equal(replied[0]!.replies[0]!.parentId, id);
  assert.equal(replied[0]!.replies[0]!.body, "Reply");
  expectError(
    await callTool(writeToken, "artifact_reply_comment", { artifactId, commentId: replyId, body: "Nested" }),
    "nested_reply",
  );
  for (const name of ["artifact_resolve_comment", "artifact_unresolve_comment"]) {
    const denied = expectError(
      await callTool(writeToken, name, { artifactId, commentId: replyId }),
      "reply_is_not_root",
    );
    assert.equal(denied.status, 400);
  }
  assert.deepEqual(await commentsOf(artifactId), replied);
  expectOk(await callTool(writeToken, "artifact_resolve_comment", { artifactId, commentId: id }));
  assert.ok(Number.isFinite(Date.parse((await commentsOf(artifactId))[0]!.resolvedAt!)));
  expectOk(await callTool(writeToken, "artifact_unresolve_comment", { artifactId, commentId: id }));
  assert.deepEqual(await commentsOf(artifactId), replied);
  const doc = expectOk(await callTool(readToken, "artifact_get_markdown", { artifactId }));
  assert.equal(doc.revisionId, created.revisionId);
  assert.deepEqual(doc.lines, ["hello", "world"]);
});

toolTest("MCP comment refusals leave threads unchanged: anchors, caps, scopes, ownership and kind", async () => {
  const created = await commitBytes(new TextEncoder().encode("hello\nworld"), "markdown");
  const artifactId = created.artifactId;
  const args = { artifactId, anchor: COMMENT_ANCHOR, body: "Root" };
  for (const [extra, error] of [
    [{ anchor: { ...COMMENT_ANCHOR, quotedText: "wrong" } }, "anchor_mismatch"],
    [{ anchor: { ...COMMENT_ANCHOR, endLine: 99, endCol: 99 } }, "validation"],
    [{ anchor: { ...COMMENT_ANCHOR, endCol: 1 } }, "validation"],
    [
      { anchor: { kind: "element", selector: "p", point: { x: 0.5, y: 0.5 }, textHint: "", viewportWidth: 800 } },
      "unsupported_anchor_kind",
    ],
    [{ anchor: { kind: "page-point", x: 0.5, y: 10, viewportWidth: 800 } }, "unsupported_anchor_kind"],
    [{ body: " " }, "validation"],
    [{ body: "x".repeat(MAX_COMMENT_BODY + 1) }, "too_large"],
  ] as const) {
    expectError(await callTool(writeToken, "artifact_add_comment", { ...args, ...extra }), error);
    assert.deepEqual(await commentsOf(artifactId), []);
  }
  for (const anchor of [
    { ...COMMENT_ANCHOR, startCol: 0 },
    { ...COMMENT_ANCHOR, quotedText: "" },
    { ...COMMENT_ANCHOR, quotedText: "x".repeat(MAX_COMMENT_QUOTE + 1) },
    { kind: "text-range" },
  ] as const) {
    const rejected = await callTool(writeToken, "artifact_add_comment", { artifactId, anchor, body: "Root" });
    assert.equal(rejected.isError, true, "a malformed anchor never reaches the handler");
    assert.deepEqual(await commentsOf(artifactId), []);
  }
  expectError(await callTool(foreignToken, "artifact_list_comments", { artifactId }), "not_found");
  for (const badId of ["not-a-uuid", randomUUID().toUpperCase()]) {
    expectError(
      await callTool(writeToken, "artifact_add_comment", { ...args, artifactId: badId }),
      "invalid_artifact_id",
    );
  }
  const id = expectOk(await callTool(writeToken, "artifact_add_comment", args)).id;
  const before = await commentsOf(artifactId);
  for (const name of [
    "artifact_add_comment",
    "artifact_reply_comment",
    "artifact_resolve_comment",
    "artifact_unresolve_comment",
  ]) {
    expectError(await callTool(readToken, name, { ...args, commentId: id }), "insufficient_scope");
  }
  for (const body of [" ", "x".repeat(MAX_COMMENT_BODY + 1)]) {
    expectError(
      await callTool(writeToken, "artifact_reply_comment", { artifactId, commentId: id, body }),
      body.trim() ? "too_large" : "validation",
    );
  }
  const other = await commitBytes(new TextEncoder().encode("other"), "markdown");
  for (const name of ["artifact_reply_comment", "artifact_resolve_comment", "artifact_unresolve_comment"]) {
    expectError(
      await callTool(writeToken, name, { artifactId: other.artifactId, commentId: id, body: "Reply" }),
      "comment_not_found",
    );
    expectError(await callTool(writeToken, name, { artifactId, commentId: "bad", body: "Reply" }), "validation");
  }
  const html = await commitBytes(new TextEncoder().encode("<p>html</p>"));
  expectError(
    await callTool(writeToken, "artifact_add_comment", { ...args, artifactId: html.artifactId }),
    "unsupported_anchor_kind",
  );
  const htmlThreads = expectOk(await callTool(readToken, "artifact_list_comments", { artifactId: html.artifactId }))
    .comments as CommentThread[];
  assert.deepEqual(htmlThreads, [], "the refused anchor wrote nothing");
  const htmlComment = expectOk(
    await callTool(writeToken, "artifact_add_comment", {
      artifactId: html.artifactId,
      anchor: { kind: "page-point", x: 0.4, y: 120, viewportWidth: 1000 },
      body: "Positioned note",
    }),
  ).id;
  const positioned = expectOk(await callTool(readToken, "artifact_list_comments", { artifactId: html.artifactId }))
    .comments as CommentThread[];
  assert.deepEqual(positioned[0]!.anchor, { kind: "page-point", x: 0.4, y: 120, viewportWidth: 1000 });
  expectOk(
    await callTool(writeToken, "artifact_resolve_comment", { artifactId: html.artifactId, commentId: htmlComment }),
  );
  assert.deepEqual(await commentsOf(artifactId), before);
  assert.equal(
    expectOk(await callTool(readToken, "artifact_get_markdown", { artifactId })).revisionId,
    created.revisionId,
  );
});

toolTest("a markdown commit persists kind and artifact_get_markdown reads numbered lines", async () => {
  const DOC = ["# Notes", "", "intro", "| a | b |", "| 1 | 2 |", "tail"].join("\n");
  const bytes = new TextEncoder().encode(DOC);
  const uploadId = `upload-${randomUUID()}`;
  expectOk(await startUpload(bytes, { uploadId }));
  await stageChunks(uploadId, bytes);
  const created = expectOk(
    await callTool(writeToken, "artifact_commit", { uploadId, kind: "markdown", title: "Notes" }),
  );
  await recordRevisionKey(created.revisionId);
  const full = expectOk(await callTool(writeToken, "artifact_get_markdown", { artifactId: created.artifactId }));
  assert.deepEqual([full.lineCount, full.from, full.to], [6, 1, 6]);
  assert.deepEqual(full.lines, DOC.split("\n"));
  const markdownRead = expectOk(await callTool(readToken, "artifact_get", { artifactId: created.artifactId }));
  assert.equal(markdownRead.kind, "markdown", "artifact_get reports the stored kind");
  const window = expectOk(
    await callTool(writeToken, "artifact_get_markdown", { artifactId: created.artifactId, from: 4, to: 5 }),
  );
  assert.deepEqual([window.from, window.to, window.lines], [4, 5, ["| a | b |", "| 1 | 2 |"]]);
  const clamped = expectOk(
    await callTool(writeToken, "artifact_get_markdown", { artifactId: created.artifactId, from: 5, to: 99 }),
  );
  assert.deepEqual([clamped.from, clamped.to, clamped.lines], [5, 6, ["| 1 | 2 |", "tail"]]);
  expectError(
    await callTool(writeToken, "artifact_get_markdown", { artifactId: created.artifactId, from: 9, to: 10 }),
    "validation",
  );
  const htmlBytes = new TextEncoder().encode("<p>not a document</p>");
  const htmlUpload = `upload-${randomUUID()}`;
  expectOk(await startUpload(htmlBytes, { uploadId: htmlUpload }));
  await stageChunks(htmlUpload, htmlBytes);
  const html = expectOk(await callTool(writeToken, "artifact_commit", { uploadId: htmlUpload }));
  await recordRevisionKey(html.revisionId);
  expectError(await callTool(writeToken, "artifact_get_markdown", { artifactId: html.artifactId }), "wrong_kind");
  assert.equal(
    expectOk(await callTool(readToken, "artifact_get", { artifactId: html.artifactId })).kind,
    "html",
    "an html artifact keeps its kind on the read payload too",
  );
  const broken = new Uint8Array([0x61, 0xf0, 0x28, 0x8c, 0x28]);
  const brokenUpload = `upload-${randomUUID()}`;
  expectOk(await startUpload(broken, { uploadId: brokenUpload }));
  await stageChunks(brokenUpload, broken);
  expectError(
    await callTool(writeToken, "artifact_commit", { uploadId: brokenUpload, kind: "markdown" }),
    "validation",
  );
});

toolTest("artifact_edit_lines applies guarded patches atomically and refuses stale reads", async () => {
  const DOC = ["# Notes", "", "intro", "| a | b |", "| 1 | 2 |", "tail"].join("\n");
  const bytes = new TextEncoder().encode(DOC);
  const uploadId = `upload-${randomUUID()}`;
  expectOk(await startUpload(bytes, { uploadId }));
  await stageChunks(uploadId, bytes);
  const created = expectOk(await callTool(writeToken, "artifact_commit", { uploadId, kind: "markdown" }));
  await recordRevisionKey(created.revisionId);
  const edited = expectOk(
    await callTool(writeToken, "artifact_edit_lines", {
      artifactId: created.artifactId,
      expectedRevisionId: created.revisionId,
      ops: [
        { op: "replace", from: 4, to: 4, expect: ["| a | b |"], text: ["| a | b | c |"] },
        { op: "insert", after: 6, text: ["", "appended"] },
      ],
    }),
  );
  assert.equal(edited.revisionNumber, 2);
  await recordRevisionKey(edited.revisionId);
  const reread = expectOk(await callTool(writeToken, "artifact_get_markdown", { artifactId: created.artifactId }));
  assert.deepEqual(reread.lines, ["# Notes", "", "intro", "| a | b | c |", "| 1 | 2 |", "tail", "", "appended"]);
  const mismatch = expectError(
    await callTool(writeToken, "artifact_edit_lines", {
      artifactId: created.artifactId,
      expectedRevisionId: String(edited.revisionId),
      ops: [{ op: "replace", from: 4, to: 4, expect: ["| stale |"], text: ["x"] }],
    }),
    "expectation_mismatch",
  );
  assert.deepEqual(mismatch.window, { from: 4, to: 4, lines: ["| a | b | c |"] });
  const stale = expectError(
    await callTool(writeToken, "artifact_edit_lines", {
      artifactId: created.artifactId,
      expectedRevisionId: String(created.revisionId),
      ops: [{ op: "replace", from: 1, to: 1, text: ["x"] }],
    }),
    "concurrent_edit",
  );
  assert.equal(stale.currentRevisionId, edited.revisionId);
  expectError(
    await callTool(writeToken, "artifact_edit_lines", {
      artifactId: created.artifactId,
      expectedRevisionId: String(edited.revisionId),
      ops: [{ op: "replace", from: 1, to: 99, text: ["x"] }],
    }),
    "validation",
  );
});

toolTest("artifact_get returns the current revision and pins an earlier revision byte-exactly", async () => {
  const first = payload();
  const second = payload();
  const created = await commitBytes(first);
  const updateUpload = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(second, { uploadId: updateUpload })).uploadId, updateUpload);
  await stageChunks(updateUpload, second);
  const updated = expectOk(
    await callTool(writeToken, "artifact_commit", {
      uploadId: updateUpload,
      artifactId: String(created.artifactId),
      expectedRevisionId: String(created.revisionId),
    }),
  );
  await recordRevisionKey(updated.revisionId);
  assert.equal(updated.revisionNumber, 2);
  const current = expectOk(await callTool(readToken, "artifact_get", { artifactId: String(created.artifactId) }));
  assert.equal(current.revisionId, String(updated.revisionId));
  assert.equal(current.sha256, digestOf(second));
  assert.equal(current.sizeBytes, second.length);
  assert.equal(
    Buffer.from(String(current.contentBase64), "base64").equals(Buffer.from(second)),
    true,
    "current revision bytes are byte-exact",
  );
  const pinned = expectOk(
    await callTool(readToken, "artifact_get", {
      artifactId: String(created.artifactId),
      revisionId: String(created.revisionId),
    }),
  );
  assert.equal(pinned.revisionId, String(created.revisionId));
  assert.equal(
    Buffer.from(String(pinned.contentBase64), "base64").equals(Buffer.from(first)),
    true,
    "pinned revision bytes are byte-exact",
  );
  expectError(await callTool(readToken, "artifact_get", { artifactId: randomUUID() }), "not_found");
  expectError(
    await callTool(readToken, "artifact_get", { artifactId: String(created.artifactId), revisionId: randomUUID() }),
    "not_found",
  );
});

toolTest("artifact_get hides a foreign artifact and reports a deleted one as gone", async () => {
  const committed = await commitBytes(payload());
  const artifactId = String(committed.artifactId);
  expectError(await callTool(foreignToken, "artifact_get", { artifactId }), "not_found");
  const other = await commitBytes(payload());
  expectError(
    await callTool(readToken, "artifact_get", { artifactId, revisionId: String(other.revisionId) }),
    "not_found",
  );
  assert.equal((await markArtifactDeleted(database.db, artifactId, ownerId)).ok, true);
  expectError(await callTool(readToken, "artifact_get", { artifactId }), "gone");
});

toolTest("artifact_get metadataOnly returns exactly the row projection and reads no storage", async () => {
  const bytes = payload();
  const committed = await commitBytes(bytes);
  const artifactId = String(committed.artifactId);
  const result = await callTool(readToken, "artifact_get", { artifactId, metadataOnly: true });
  const metadata = expectOk(result) as ArtifactMetadata;
  assert.deepEqual(artifactMetadataSchema.parse(metadata), metadata, "the reply is exactly the metadata schema");
  assert.deepEqual(Object.keys(metadata).sort(), [
    "artifactId",
    "kind",
    "revisionId",
    "revisionNumber",
    "sha256",
    "sizeBytes",
    "title",
  ]);
  assert.deepEqual(metadata, {
    artifactId,
    revisionId: String(committed.revisionId),
    revisionNumber: 1,
    kind: "html",
    sha256: digestOf(bytes),
    sizeBytes: bytes.length,
    title: null,
  });
  assert.deepEqual(result.structuredContent, metadata, "structuredContent carries the same projection");
  assert.equal(JSON.stringify(result).includes("contentBase64"), false, "the metadata reply carries no bytes");
  await storage.client.send(
    new DeleteObjectCommand({ Bucket: storage.bucket, Key: await revisionKeyOf(committed.revisionId) }),
  );
  expectError(await callTool(readToken, "artifact_get", { artifactId }), "not_found");
  assert.deepEqual(expectOk(await callTool(readToken, "artifact_get", { artifactId, metadataOnly: true })), metadata);
});

toolTest("artifact_update_metadata renames in place and no revision is created", async () => {
  const bytes = payload();
  const committed = await commitBytes(bytes);
  const artifactId = String(committed.artifactId);
  const renamed = expectOk(
    await callTool(writeToken, "artifact_update_metadata", { artifactId, title: "Renamed doc" }),
  );
  assert.deepEqual(renamed, {
    artifactId,
    title: "Renamed doc",
    currentRevisionId: String(committed.revisionId),
    revisionCount: 1,
  });
  const metadata = expectOk(await callTool(readToken, "artifact_get", { artifactId, metadataOnly: true }));
  assert.equal(metadata.title, "Renamed doc");
  assert.equal(metadata.revisionNumber, 1);
  expectOk(await callTool(writeToken, "artifact_update_metadata", { artifactId, title: "Renamed doc" }));
  expectError(await callTool(writeToken, "artifact_update_metadata", { artifactId, title: "   " }), "invalid_title");
  expectError(
    await callTool(readToken, "artifact_update_metadata", { artifactId, title: "Nope" }),
    "insufficient_scope",
  );
  const stale = expectError(
    await callTool(writeToken, "artifact_update_metadata", {
      artifactId,
      title: "Never",
      expectedRevisionId: "stale-" + "0".repeat(24),
    }),
    "concurrent_commit",
  );
  assert.equal(stale.currentRevisionId, String(committed.revisionId));
  const final = expectOk(await callTool(readToken, "artifact_get", { artifactId, metadataOnly: true }));
  assert.equal(final.title, "Renamed doc", "a losing CAS never renames");
  assert.deepEqual(await revisionObjects(), await revisionObjects(), "no storage activity");
});

toolTest("artifact_get keeps the legacy envelope byte-exact when metadataOnly is absent or false", async () => {
  const bytes = payload();
  const committed = await commitBytes(bytes);
  const artifactId = String(committed.artifactId);
  const legacyText = JSON.stringify({
    artifactId,
    revisionId: String(committed.revisionId),
    kind: "html",
    sha256: digestOf(bytes),
    sizeBytes: bytes.length,
    contentBase64: b64(bytes),
  });
  for (const args of [{ artifactId }, { artifactId, metadataOnly: false }]) {
    const result = await callTool(readToken, "artifact_get", args);
    expectOk(result);
    assert.equal(result.content?.[0]?.text, legacyText, `${JSON.stringify(args)} keeps the legacy envelope`);
    assert.equal(result.structuredContent, undefined, "the legacy reply carries no structured content");
  }
});

toolTest("artifact_get metadataOnly pins revisionId and reports the pinned row's own numbers", async () => {
  const first = payload();
  const second = payload();
  const created = await commitBytes(first);
  const updateUpload = `upload-${randomUUID()}`;
  assert.equal(expectOk(await startUpload(second, { uploadId: updateUpload })).uploadId, updateUpload);
  await stageChunks(updateUpload, second);
  const updated = expectOk(
    await callTool(writeToken, "artifact_commit", {
      uploadId: updateUpload,
      artifactId: String(created.artifactId),
      expectedRevisionId: String(created.revisionId),
    }),
  );
  await recordRevisionKey(updated.revisionId);
  const pinned = expectOk(
    await callTool(readToken, "artifact_get", {
      artifactId: String(created.artifactId),
      revisionId: String(created.revisionId),
      metadataOnly: true,
    }),
  );
  assert.deepEqual(pinned, {
    artifactId: String(created.artifactId),
    revisionId: String(created.revisionId),
    revisionNumber: 1,
    kind: "html",
    sha256: digestOf(first),
    sizeBytes: first.length,
    title: null,
  });
  const current = expectOk(
    await callTool(readToken, "artifact_get", { artifactId: String(created.artifactId), metadataOnly: true }),
  );
  assert.deepEqual(current, {
    artifactId: String(created.artifactId),
    revisionId: String(updated.revisionId),
    revisionNumber: 2,
    kind: "html",
    sha256: digestOf(second),
    sizeBytes: second.length,
    title: null,
  });
  expectError(
    await callTool(readToken, "artifact_get", {
      artifactId: String(created.artifactId),
      revisionId: randomUUID(),
      metadataOnly: true,
    }),
    "not_found",
  );
});

toolTest("artifact_get keeps the ownership and deletion refusals for every metadataOnly value", async () => {
  const committed = await commitBytes(payload());
  const artifactId = String(committed.artifactId);
  const other = await commitBytes(payload());
  for (const metadataOnly of [undefined, false, true]) {
    const args = { artifactId, ...(metadataOnly === undefined ? {} : { metadataOnly }) };
    expectError(await callTool(foreignToken, "artifact_get", args), "not_found");
  }
  expectError(
    await callTool(readToken, "artifact_get", {
      artifactId,
      revisionId: String(other.revisionId),
      metadataOnly: true,
    }),
    "not_found",
  );
  assert.equal((await markArtifactDeleted(database.db, artifactId, ownerId)).ok, true);
  for (const args of [{ artifactId }, { artifactId, metadataOnly: false }, { artifactId, metadataOnly: true }]) {
    expectError(await callTool(readToken, "artifact_get", args), "gone");
  }
});

toolTest("artifact_get refuses a non-boolean metadataOnly instead of ignoring it", async () => {
  const committed = await commitBytes(payload());
  const body = await rpc(writeToken, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "artifact_get", arguments: { artifactId: String(committed.artifactId), metadataOnly: "true" } },
  });
  const result = body.result as ToolResult | undefined;
  assert.equal(result?.isError, true, "a string metadataOnly is refused, never coerced to a legacy read");
  const refused = result?.content?.[0]?.text ?? "";
  assert.match(refused, /Invalid arguments for tool artifact_get/);
  assert.match(refused, /metadataOnly/);
  assert.equal(JSON.stringify(result).includes("contentBase64"), false);
});

toolTest("the official SDK client creates, commits and reads back over the MCP transport", async () => {
  const bytes = payload();
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${writeToken}` } },
  });
  const client = new Client({ name: "artiflow-sdk-roundtrip", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
    const call = async (name: string, args: ToolPayload): Promise<ToolResult> =>
      (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    const uploadId = `upload-${randomUUID()}`;
    const started = expectOk(
      await call("artifact_start_upload", {
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: digestOf(bytes),
      }),
    );
    assert.equal(started.uploadId, uploadId);
    for (let index = 0; index * CHUNK < bytes.length; index += 1) {
      const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
      usedKeys.push(
        String(
          expectOk(await call("artifact_put_chunk", { uploadId, chunkIndex: index, contentBase64: b64(part) }))
            .storageKey,
        ),
      );
    }
    const committed = expectOk(await call("artifact_commit", { uploadId }));
    await recordRevisionKey(committed.revisionId);
    const read = expectOk(
      await call("artifact_get", {
        artifactId: String(committed.artifactId),
        revisionId: String(committed.revisionId),
      }),
    );
    assert.equal(read.sha256, digestOf(bytes));
    assert.equal(
      Buffer.from(String(read.contentBase64), "base64").equals(Buffer.from(bytes)),
      true,
      "SDK roundtrip is byte-exact",
    );
  } finally {
    await client.close();
  }
});
