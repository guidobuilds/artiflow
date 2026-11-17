#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ensureFixtureSession } from "./fixture-accounts.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  RUNTIME = path.join(ROOT, ".runtime");
const BASE = "http://127.0.0.1:5173",
  RESOURCE = `${BASE}/mcp`;
const CREDS = path.join(RUNTIME, "e2e-credentials.json"),
  STATE = path.join(RUNTIME, "e2e-state.json");
const TITLE = "I6b e2e artifact",
  ARTIFACT_PREFIX = "2b000000-0000-4000-8000-";
const SCOPES = "artifacts:read artifacts:write offline_access";
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
const OWNER = {
  name: "e2e owner",
  email: "e2e-owner@example.test",
  password: "e2e-throwaway-owner-6d1c93fa-loopback-only",
};
const RECIPIENT = {
  name: "e2e recipient",
  email: "e2e-recipient@example.test",
  password: "e2e-throwaway-recipient-2ab74e05-loopback-only",
};
const MUTATION = { origin: BASE, "content-type": "application/json" };
const PAYLOAD = Buffer.from(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#fbf8f1;color:#191c26;max-width:38rem;margin:4rem auto;padding:0 1rem}h1{font-size:2rem}</style></head>
<body><h1 id="e2e-artifact">${TITLE}</h1><p>Committed through the real OAuth and MCP flow by scripts/e2e-full-cycle.mjs.</p>
<!-- padding ${"fedcba9876543210".repeat(112)} --></body></html>`,
  "utf8",
);
const TOOLS = ["artifact_commit", "artifact_get", "artifact_put_chunk", "artifact_start_upload"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    return assert.fail(`${what} is not valid JSON`);
  }
};
const readPrivate = (file) =>
  fs.existsSync(file) ? parseJson(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)) : null;
function writePrivate(file, value) {
  fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
const request = (pathname, init = {}) => fetch(`${BASE}${pathname}`, { ...init, signal: AbortSignal.timeout(20_000) });
const srcdocOf = (html) =>
  (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
async function ensureUser(user) {
  const { cookie } = await ensureFixtureSession({ base: BASE, origin: BASE, credentials: user });
  return cookie;
}
async function ensureClient(credentials, cookie) {
  if (credentials.clientId && credentials.clientSecret && credentials.redirectUri) return;
  const redirectUri = `${BASE}/oauth/callback`;
  const response = await request("/api/auth/oauth2/create-client", {
    method: "POST",
    headers: { ...MUTATION, cookie },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "I6b E2E CLI",
      application_type: "native",
      token_endpoint_auth_method: "client_secret_basic",
    }),
  });
  assert.equal(response.status, 201, `create-client answered ${response.status}`);
  const created = await response.json();
  assert.ok(created.client_id && created.client_secret, "create-client did not return a confidential client");
  Object.assign(credentials, { clientId: created.client_id, clientSecret: created.client_secret, redirectUri });
  writePrivate(CREDS, credentials);
}
async function earnToken(cookie, credentials) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    scope: SCOPES,
    state: randomUUID(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const authorize = await request(`/api/auth/oauth2/authorize?${params}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(authorize.status, 200, `authorize answered ${authorize.status}`);
  let target = (await authorize.json()).url ?? "";
  if (target.startsWith("/consent?")) {
    const consent = await request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { ...MUTATION, cookie },
      body: JSON.stringify({ accept: true, oauth_query: target.slice("/consent?".length) }),
    });
    assert.equal(consent.status, 200, `consent answered ${consent.status}`);
    target = (await consent.json()).url ?? "";
  }
  const code = URL.parse(target)?.searchParams.get("code") ?? "";
  assert.ok(code, "authorization returned no code");
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const token = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: credentials.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(token.status, 200, `token answered ${token.status}`);
  const accessToken = (await token.json()).access_token;
  assert.ok(typeof accessToken === "string" && accessToken.length > 0, "token response carried no access token");
  return accessToken;
}
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((part) => part.type === "text")?.text ?? "";
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return result.isError ? { error: body.error ?? "refused", message: String(body.message ?? "") } : body;
}
const rows = [];
async function step(name, run) {
  const started = Date.now();
  try {
    const value = await run();
    rows.push({ step: name, status: "PASS", ms: Date.now() - started });
    return value;
  } catch (error) {
    rows.push({ step: name, status: "FAIL", ms: Date.now() - started });
    throw error;
  }
}
const report = () =>
  rows.map((row) => `  ${row.step.padEnd(22)} ${row.status.padEnd(4)} ${String(row.ms).padStart(6)}ms`).join("\n");

const { loadConfig } = await import("../apps/api/src/config.ts");
const { createStorage } = await import("../apps/api/src/storage/client.ts");
const { Pool } = await import("pg");
const storage = createStorage(loadConfig(process.env).storage);
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
async function keys(prefix) {
  const found = [];
  let token;
  do {
    const page = await storage.client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) found.push(object.Key);
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return found;
}
const COUNT_SQL = {
  users: `select count(*)::int as n from "user"`,
  clients: `select count(*)::int as n from "oauthClient"`,
  consents: `select count(*)::int as n from "oauthConsent"`,
  artifacts: `select count(*)::int as n from "artifacts"`,
  liveArtifacts: `select count(*)::int as n from "artifacts" where "deletedAt" is null`,
  revisions: `select count(*)::int as n from "artifactRevisions"`,
  uploads: `select count(*)::int as n from "artifactUploads"`,
  shares: `select count(*)::int as n from "artifactShares"`,
  links: `select count(*)::int as n from "artifactPublicLinks"`,
};
const dbCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(COUNT_SQL).map(async ([key, sql]) => [key, Number((await db.query(sql)).rows[0].n)]),
    ),
  );
const revisionStorageKey = async (artifactId) =>
  (
    await db.query(
      `select "storageKey" from "artifactRevisions" where "artifactId" = $1 order by "revision" desc limit 1`,
      [artifactId],
    )
  ).rows[0]?.storageKey;

const before = await dbCounts();
const keysBefore = await keys("artifacts/"),
  stagingBefore = await keys("staging/");
const state = readPrivate(STATE) ?? { runs: 0 };
const artifactId = `${ARTIFACT_PREFIX}${String(state.runs + 1).padStart(12, "0")}`;
const runId = state.runs + 1;
writePrivate(STATE, { runs: runId, artifactId });
const credentials = readPrivate(CREDS) ?? {};
const digest = sha256(PAYLOAD),
  stagingKey = `staging/${digest}`;
let mcp,
  revisionKey,
  keysAfterCommit = [],
  report4 = {};
console.log(`[e2e] run ${runId} artifact ${artifactId} payload ${PAYLOAD.length} bytes sha256 ${digest}`);
try {
  await step("health", async () => assert.equal((await request("/api/health")).status, 200, "app not healthy"));
  const ownerCookie = await step("owner-user", () => ensureUser(OWNER));
  await step("owner-client", () => ensureClient(credentials, ownerCookie));
  const token = await step("token-pkce-consent", () => earnToken(ownerCookie, credentials));
  mcp = await step("mcp-tools", async () => {
    const client = new Client({ name: "artiflow-e2e-full-cycle", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      TOOLS,
      "the live MCP server does not expose the four artifact tools",
    );
    return client;
  });
  await step("mcp-commit", async () => {
    const started = await callTool(mcp, "artifact_start_upload", {
      declaredSizeBytes: PAYLOAD.length,
      declaredSha256: digest,
      title: TITLE,
    });
    assert.ok(started.uploadId, `start_upload refused: ${started.message}`);
    const staged = await callTool(mcp, "artifact_put_chunk", {
      uploadId: started.uploadId,
      chunkIndex: 0,
      contentBase64: PAYLOAD.toString("base64"),
    });
    assert.ok(!staged.error, `put_chunk refused: ${staged.message}`);
    const committed = await callTool(mcp, "artifact_commit", { uploadId: started.uploadId, artifactId, title: TITLE });
    if (committed.error) {
      assert.match(
        committed.message,
        /artifact_already_exists/,
        `commit refused: ${committed.error} ${committed.message}`,
      );
      assert.equal(
        (await callTool(mcp, "artifact_get", { artifactId })).sha256,
        digest,
        "existing artifact digest mismatch",
      );
    } else assert.equal(committed.sha256, digest, "commit digest differs from the local digest");
    revisionKey = await revisionStorageKey(artifactId);
    assert.match(revisionKey ?? "", /^artifacts\/[a-z0-9][a-z0-9-]{0,127}$/, "the revision row names no revision key");
    keysAfterCommit = await keys("artifacts/");
  });
  await step("mcp-read", async () => {
    const read = await callTool(mcp, "artifact_get", { artifactId });
    assert.equal(read.sha256, digest, "artifact_get digest mismatch");
    assert.equal(
      Buffer.from(String(read.contentBase64), "base64").equals(PAYLOAD),
      true,
      "artifact_get bytes are not byte-exact",
    );
  });
  const ownerView = await step("library-owner", async () => {
    const listed = await request("/api/artifacts", { headers: { cookie: ownerCookie } });
    assert.equal(listed.status, 200, `library list answered ${listed.status}`);
    const entry = ((await listed.json()).artifacts ?? []).find((artifact) => artifact.id === artifactId);
    assert.ok(entry, "the owner library does not list the committed artifact");
    assert.deepEqual(
      [entry.title, entry.sha256, entry.observedSizeBytes],
      [TITLE, digest, PAYLOAD.length],
      "library entry facts drifted",
    );
    const meta = await request(`/api/artifacts/${artifactId}`, { headers: { cookie: ownerCookie } });
    assert.deepEqual(
      [meta.status, (await meta.json()).revision?.sha256],
      [200, digest],
      "metadata 200 with the current revision",
    );
    const viewer = await request(`/artifact/${artifactId}`, { headers: { cookie: ownerCookie } });
    assert.deepEqual(
      [
        viewer.status,
        viewer.headers.get("content-security-policy"),
        viewer.headers.get("x-content-type-options"),
        viewer.headers.get("cache-control"),
      ],
      [200, CSP, "nosniff", "no-store"],
      "owner viewer headers",
    );
    const html = await viewer.text();
    assert.equal(srcdocOf(html), PAYLOAD.toString("utf8"), "the wrapper srcdoc is not the exact payload");
    assert.deepEqual(
      [
        html.includes('sandbox="allow-scripts"'),
        html.includes("allow-same-origin"),
        html.match(/<iframe /g)?.length,
        html.includes("<h1"),
      ],
      [true, false, 1, false],
      "sandbox or escaping drifted",
    );
    return html;
  });
  const recipientCookie = await step("recipient-user", () => ensureUser(RECIPIENT));
  const grantId = await step("share-grant", async () => {
    const granted = await request(`/api/artifacts/${artifactId}/shares`, {
      method: "POST",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: JSON.stringify({ email: RECIPIENT.email }),
    });
    assert.equal(granted.status, 201, `share answered ${granted.status}`);
    const created = await granted.json();
    assert.equal(created.sharedWith?.email, RECIPIENT.email, "grant does not name the recipient");
    return created.id;
  });
  await step("share-recipient-read", async () => {
    const listed = await request("/api/artifacts/shared", { headers: { cookie: recipientCookie } });
    assert.equal(listed.status, 200, `shared list answered ${listed.status}`);
    const entry = ((await listed.json()).artifacts ?? []).find((artifact) => artifact.id === artifactId);
    assert.ok(entry, "the recipient shared list does not show the granted artifact");
    assert.equal(entry.sharedBy?.email, OWNER.email, "the shared row does not name the sharer");
    const viewer = await request(`/artifact/${artifactId}`, { headers: { cookie: recipientCookie } });
    assert.equal(viewer.status, 200, `recipient viewer answered ${viewer.status}`);
    assert.equal(await viewer.text(), ownerView, "the recipient wrapper body differs from the owner wrapper body");
  });
  await step("share-revoke", async () => {
    const revoked = await request(`/api/artifacts/${artifactId}/shares/${grantId}`, {
      method: "DELETE",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: "{}",
    });
    assert.deepEqual([revoked.status, await revoked.json()], [200, { ok: true }], "grant revoke");
    const listed = await request("/api/artifacts/shared", { headers: { cookie: recipientCookie } });
    assert.equal(
      ((await listed.json()).artifacts ?? []).some((artifact) => artifact.id === artifactId),
      false,
      "a revoked grant is still listed",
    );
    const viewer = await request(`/artifact/${artifactId}`, { headers: { cookie: recipientCookie } });
    const missing = await request(`/artifact/${randomUUID()}`, { headers: { cookie: recipientCookie } });
    assert.deepEqual(
      [viewer.status, missing.status, (await viewer.text()) === (await missing.text())],
      [404, 404, true],
      "a revoked viewer must 404 exactly like a missing artifact",
    );
  });
  const link = await step("link-create", async () => {
    const created = await request(`/api/artifacts/${artifactId}/links`, {
      method: "POST",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: "{}",
    });
    assert.equal(created.status, 201, `link create answered ${created.status}`);
    const body = await created.json();
    assert.ok(typeof body.token === "string" && body.token.length === 43, "a link token is 43 base64url chars");
    assert.equal(body.url, `${BASE}/share/${body.token}`, "link url contract");
    const publicView = await request(`/share/${body.token}`);
    assert.deepEqual(
      [
        publicView.status,
        publicView.headers.get("content-security-policy"),
        publicView.headers.get("x-robots-tag"),
        publicView.headers.get("cache-control"),
      ],
      [200, CSP, "noindex", "no-store"],
      "anonymous public viewer headers",
    );
    assert.equal(await publicView.text(), ownerView, "the public wrapper body differs from the owner wrapper body");
    return { id: body.id, token: body.token };
  });
  const rotated = await step("link-rotate", async () => {
    const created = await request(`/api/artifacts/${artifactId}/links/${link.id}/rotate`, {
      method: "POST",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: "{}",
    });
    assert.equal(created.status, 201, `link rotate answered ${created.status}`);
    const body = await created.json();
    assert.notEqual(body.token, link.token, "the rotated token equals the previous one");
    assert.deepEqual(
      [(await request(`/share/${link.token}`)).status, (await request(`/share/${body.token}`)).status],
      [404, 200],
      "rotation did not move the live token",
    );
    return { id: body.id, token: body.token };
  });
  await step("link-revoke", async () => {
    const revoked = await request(`/api/artifacts/${artifactId}/links/${rotated.id}`, {
      method: "DELETE",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: "{}",
    });
    assert.deepEqual([revoked.status, await revoked.json()], [200, { ok: true }], "link revoke");
    assert.deepEqual(
      [(await request(`/share/${rotated.token}`)).status, (await request(`/share/${link.token}`)).status],
      [404, 404],
      "a revoked link still resolves",
    );
  });
  await step("delete", async () => {
    const deleted = await request(`/api/artifacts/${artifactId}`, {
      method: "DELETE",
      headers: { ...MUTATION, cookie: ownerCookie },
      body: "{}",
    });
    assert.deepEqual([deleted.status, await deleted.json()], [200, { ok: true }], "confirmed artifact delete");
    const gone = await callTool(mcp, "artifact_get", { artifactId });
    assert.ok(gone.error, "artifact_get must refuse a deleted artifact");
    assert.equal(
      (await request(`/artifact/${artifactId}`, { headers: { cookie: ownerCookie } })).status,
      404,
      "a deleted artifact view must 404",
    );
    const listed = await request("/api/artifacts", { headers: { cookie: ownerCookie } });
    assert.equal(
      ((await listed.json()).artifacts ?? []).some((artifact) => artifact.id === artifactId),
      false,
      "a deleted artifact is still listed",
    );
    assert.deepEqual(
      [
        (await request(`/api/artifacts/${artifactId}/shares`, { headers: { cookie: ownerCookie } })).status,
        (await request(`/api/artifacts/${artifactId}/links`, { headers: { cookie: ownerCookie } })).status,
      ],
      [404, 404],
      "management rows must not answer for a deleted artifact",
    );
  });
  await step("storage-bytes", async () => {
    assert.equal(keysBefore.includes(revisionKey), false, "the run's revision key already existed before commit");
    assert.equal(keysAfterCommit.includes(revisionKey), true, "commit stored no revision bytes");
    const keysAfter = await keys("artifacts/");
    assert.equal(keysAfter.includes(revisionKey), false, "the product DELETE did not remove the revision bytes");
    assert.deepEqual(keysAfter, keysBefore, "revision keys other than this run's must be untouched");
    const stagingAdded = (await keys("staging/")).filter((key) => !stagingBefore.includes(key));
    assert.deepEqual(
      stagingAdded.filter((key) => key !== stagingKey),
      [],
      "unexpected staging objects appeared",
    );
    report4 = { revisionKeyRemoved: true, revisionKeysAfter: keysAfter.length, stagingAdded: stagingAdded.length };
  });
  await mcp.close();
  const after = await dbCounts();
  assert.equal(after.liveArtifacts, before.liveArtifacts, "the cycle must leave no extra live artifact");
  console.log(report());
  console.log(
    `[e2e] storage ${JSON.stringify(report4)} db delta ${JSON.stringify(Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])))}`,
  );
  console.log("E2E-FULL-CYCLE PASS");
} catch (error) {
  console.log(report());
  throw error;
} finally {
  if (mcp) await mcp.close().catch(() => undefined);
  storage.destroy();
  await db.end().catch(() => undefined);
}
