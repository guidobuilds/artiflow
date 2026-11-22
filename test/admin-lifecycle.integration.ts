import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signWithKey } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { and, eq } from "drizzle-orm";

import {
  artifactComments,
  artifactPublicLinks,
  artifactRevisions,
  artifacts,
  artifactShares,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { oauthAccessToken, oauthRefreshToken } from "../apps/api/src/adapters/postgres/db/oauth-schema.ts";
import { account, session, user } from "../apps/api/src/adapters/postgres/db/schema.ts";
import { createAuthHolder } from "../apps/api/src/auth-holder.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { accountIsActive } from "../apps/api/src/identity/accounts.ts";
import { createMcpBearerVerifier, createMultiAudienceBearerVerifier } from "../apps/api/src/mcp/mount.ts";
import { API_RESOURCE_SCOPES, publicApiResource, publicIssuer, publicResource } from "../apps/api/src/oauth.ts";
import { hashLinkToken } from "../apps/api/src/routes/sharing.ts";
import { createPkce } from "./helpers/oauth.ts";
import { trustedSession, type TrustedFixture, type TrustedSession } from "./helpers/trusted-accounts.ts";
import {
  adminPost,
  adminRequest,
  assertStatus,
  startAdminHarness,
  type AdminHarness,
} from "./helpers/admin-harness.ts";

const TEST_TIMEOUT_MS = 30_000;
const integration = (name: string, fn: () => Promise<void>) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

const SIGN_IN_PATH = "/api/auth/sign-in/email";
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const REDIRECT_URI = "http://127.0.0.1:5173/oauth/callback";

let harness: AdminHarness | null = null;
let fixture: TrustedFixture | null = null;
let administrator: TrustedSession | null = null;

function target(): AdminHarness {
  assert.ok(harness, "the harness started");
  return harness;
}

function fixtureOf(): TrustedFixture {
  assert.ok(fixture, "the fixture started");
  return fixture;
}

function actor(): TrustedSession {
  assert.ok(administrator, "the administrator exists");
  return administrator;
}

function statusPath(userId: string): string {
  return `/api/admin/users/${userId}/status`;
}

function setStatus(userId: string, status: "active" | "deactivated"): Promise<Response> {
  return adminPost(target(), statusPath(userId), { status }, actor().cookie);
}

function withOrigin(path: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      origin: target().config.publicOrigin,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

function signIn(email: string, password: string): Promise<Response> {
  return adminRequest(
    target(),
    SIGN_IN_PATH,
    withOrigin(SIGN_IN_PATH, { method: "POST", body: JSON.stringify({ email, password }) }),
  );
}

function sessionCookieOf(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.includes("session_token")) ?? ""
  );
}

function bearer(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return adminRequest(target(), path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });
}

type TokenResponse = { access_token: string; refresh_token?: string };

type EarnedToken = { accessToken: string; refreshToken: string | null; clientId: string };

async function earnToken(cookie: string, scope: string, resource: string): Promise<EarnedToken> {
  const registration = await adminRequest(target(), "/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "lifecycle integration",
      redirect_uris: [REDIRECT_URI],
      application_type: "native",
      token_endpoint_auth_method: "none",
      resources: [resource],
    }),
  });
  if (registration.status !== 201)
    throw new Error(`registration failed: HTTP ${registration.status} — ${await registration.text()}`);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const pkce = createPkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    resource,
    state: randomUUID(),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  const authorized = await adminRequest(target(), `/api/auth/oauth2/authorize?${params}`, {
    headers: { cookie },
    redirect: "manual",
  });
  if (authorized.status !== 200)
    throw new Error(`authorize failed: HTTP ${authorized.status} — ${await authorized.text()}`);
  const { url } = (await authorized.json()) as { url: string };
  const consent = await adminPost(
    target(),
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: url.slice("/consent?".length) },
    cookie,
  );
  if (consent.status !== 200) throw new Error(`consent failed: HTTP ${consent.status} — ${await consent.text()}`);
  const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get("code") ?? "";
  assert.ok(code.length > 0, "the consent answer carries an authorization code");
  const exchanged = await adminRequest(target(), "/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: pkce.verifier,
      resource,
    }).toString(),
  });
  if (exchanged.status !== 200)
    throw new Error(`exchange failed: HTTP ${exchanged.status} — ${await exchanged.text()}`);
  const issued = (await exchanged.json()) as TokenResponse;
  return { accessToken: issued.access_token, refreshToken: issued.refresh_token ?? null, clientId };
}

function refreshTokenRequest(refreshToken: string, clientId: string, resource: string): Promise<Response> {
  return adminRequest(target(), "/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource,
    }).toString(),
  });
}

type OwnedContent = { artifactId: string; revisionId: string; linkToken: string; commentIds: string[] };

async function seedOwnedContent(ownerId: string, readerId: string, title: string): Promise<OwnedContent> {
  const db = target().database.db;
  const now = new Date();
  const artifactId = `artifact-${randomUUID()}`;
  const revisionId = randomUUID();
  await db.insert(artifacts).values({
    id: artifactId,
    ownerId,
    title,
    kind: "markdown",
    observedSizeBytes: 24,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(artifactRevisions).values({
    id: revisionId,
    artifactId,
    revision: 1,
    sizeBytes: 24,
    sha256: createHash("sha256").update(artifactId).digest("hex"),
    storageKey: `lifecycle/${artifactId}`,
    createdAt: now,
  });
  await db.update(artifacts).set({ currentRevisionId: revisionId }).where(eq(artifacts.id, artifactId));
  const commentIds = [randomUUID(), randomUUID()];
  const anchor = { kind: "text-range", startLine: 1, startCol: 1, endLine: 1, endCol: 2, quotedText: "#" };
  await db.insert(artifactComments).values([
    {
      id: commentIds[0],
      artifactId,
      authorId: ownerId,
      anchor,
      body: "Kept after deactivation",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: commentIds[1],
      artifactId,
      authorId: readerId,
      anchor,
      body: "Written by the reader",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(artifactShares).values({
    artifactId,
    sharedWithUserId: readerId,
    grantedByUserId: ownerId,
    role: "reader",
    createdAt: now,
  });
  const linkToken = randomBytes(32).toString("base64url");
  await db.insert(artifactPublicLinks).values({
    id: randomUUID(),
    artifactId,
    tokenHash: hashLinkToken(linkToken),
    createdAt: now,
  });
  return { artifactId, revisionId, linkToken, commentIds };
}

async function contentOf(content: OwnedContent): Promise<{
  artifacts: number;
  revisions: number;
  comments: number;
  grants: number;
}> {
  const db = target().database.db;
  const artifactRows = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, content.artifactId));
  const revisionRows = await db
    .select({ id: artifactRevisions.id })
    .from(artifactRevisions)
    .where(eq(artifactRevisions.artifactId, content.artifactId));
  const commentRows = await db
    .select({ id: artifactComments.id })
    .from(artifactComments)
    .where(eq(artifactComments.artifactId, content.artifactId));
  const shareRows = await db
    .select({ id: artifactShares.id })
    .from(artifactShares)
    .where(eq(artifactShares.artifactId, content.artifactId));
  return {
    artifacts: artifactRows.length,
    revisions: revisionRows.length,
    comments: commentRows.length,
    grants: shareRows.length,
  };
}

async function sessionCountOf(userId: string): Promise<number> {
  const rows = await target().database.db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
  return rows.length;
}

async function storedStatus(
  userId: string,
): Promise<{ status: string; deactivatedAt: Date | null; deactivatedBy: string | null }> {
  const rows = await target()
    .database.db.select({ status: user.status, deactivatedAt: user.deactivatedAt, deactivatedBy: user.deactivatedBy })
    .from(user)
    .where(eq(user.id, userId));
  const row = rows[0];
  assert.ok(row, "the account exists");
  return row;
}

async function publicLinkStatus(token: string): Promise<number> {
  const response = await adminRequest(target(), `/share/${token}?meta=1`);
  return response.status;
}

async function withAuditCapture<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    const lines = written
      .flatMap((chunk) => chunk.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

type TokenSigner = { jwksUrl: string; sign(claims: Record<string, unknown>): string; close(): Promise<void> };

async function startTokenSigner(): Promise<TokenSigner> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = `lifecycle-${randomUUID()}`;
  const document = JSON.stringify({
    keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }],
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(document);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return {
    jwksUrl: `http://127.0.0.1:${port}/jwks`,
    sign(claims) {
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid, typ: "at+jwt" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signature = signWithKey(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function waitForLockedWriters(pool: AdminHarness["database"]["pool"], expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const counted = await pool.query<{ blocked: string }>(
      "select count(*)::text as blocked from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    const blocked = Number(counted.rows[0]?.blocked ?? "0");
    if (blocked >= expected) return;
    if (Date.now() > deadline)
      throw new Error(`only ${blocked} of ${expected} writers reached the account row before the deadline`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

before(async () => {
  harness = await startAdminHarness(loadConfig(process.env));
  fixture = { database: harness.database, baseUrl: harness.baseUrl, origin: harness.config.publicOrigin };
  administrator = await trustedSession(fixtureOf(), { role: "administrator", name: "Lifecycle Administrator" });
});

after(async () => {
  await harness?.close();
  harness = null;
});

integration("a member is refused on the status endpoint and the account keeps its state", async () => {
  const member = await trustedSession(fixtureOf(), { name: "Lifecycle Member" });
  const response = await adminPost(target(), statusPath(member.userId), { status: "deactivated" }, member.cookie);
  assertStatus(response, 403, "changing an account state is an administration action");
  assert.deepEqual(await response.json(), { error: "administrator_required" });
  assert.deepEqual(await storedStatus(member.userId), { status: "active", deactivatedAt: null, deactivatedBy: null });
  assert.equal(await sessionCountOf(member.userId), 1, "the refused request cut nothing");
});

integration("a deactivated account cannot sign in with its password", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Password Victim" });
  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  const credentials = await target()
    .database.db.select({ providerId: account.providerId, password: account.password })
    .from(account)
    .where(and(eq(account.userId, victim.userId), eq(account.providerId, "credential")));
  assert.equal(credentials.length, 1, "the credential row survives deactivation");
  assert.equal(typeof credentials[0]?.password, "string", "the stored password hash survives deactivation");

  const refused = await signIn(victim.email, victim.password);
  assert.equal(refused.status, 401, "the password no longer signs in");
  assert.equal(sessionCookieOf(refused), "", "no session cookie is issued");
  assert.equal(await sessionCountOf(victim.userId), 0, "no session row is created for a deactivated account");
});

integration("a live session stops working when the account is deactivated", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Session Victim" });
  const before = await adminRequest(target(), "/api/artifacts", { headers: { cookie: victim.cookie } });
  assertStatus(before, 200, "the live session reads before deactivation");
  assert.equal(await sessionCountOf(victim.userId), 1);

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");
  assert.equal(await sessionCountOf(victim.userId), 0, "deactivation deletes the account's sessions");

  const after = await adminRequest(target(), "/api/artifacts", { headers: { cookie: victim.cookie } });
  assertStatus(after, 401, "the revoked session no longer reads");
  assert.deepEqual(await after.json(), { error: "unauthorized" });
});

integration("a bearer token issued before deactivation stops working on both bearer surfaces", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Bearer Victim" });
  const apiResource = publicApiResource(target().config);
  const mcpResource = `${target().config.publicOrigin}/mcp`;
  const apiToken = await earnToken(victim.cookie, "artifacts:read offline_access", apiResource);
  const mcpToken = await earnToken(victim.cookie, "artifacts:read artifacts:write offline_access", mcpResource);
  assert.notEqual(apiToken.refreshToken, null, "the account holds a refresh token");

  assertStatus(await bearer(apiToken.accessToken, "/api/v1/artifacts"), 200, "the API token reads before deactivation");
  assertStatus(
    await bearer(mcpToken.accessToken, "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: target().config.publicOrigin,
      },
      body: TOOLS_LIST,
    }),
    200,
    "the MCP token reaches the server before deactivation",
  );
  assertStatus(
    await refreshTokenRequest(apiToken.refreshToken ?? "", apiToken.clientId, apiResource),
    200,
    "the refresh token mints a token before deactivation",
  );

  const refreshBefore = await target()
    .database.db.select({ revoked: oauthRefreshToken.revoked })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, victim.userId));
  assert.equal(refreshBefore.length >= 1, true, "the account holds issued refresh tokens");
  assert.equal(
    refreshBefore.every((row) => row.revoked === null),
    true,
    "the refresh tokens are usable before deactivation",
  );

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  const refusedApi = await bearer(apiToken.accessToken, "/api/v1/artifacts");
  assertStatus(refusedApi, 401, "the API token is refused after deactivation");
  assert.deepEqual(await refusedApi.json(), { error: "invalid_token" });

  const refusedMcp = await bearer(mcpToken.accessToken, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: target().config.publicOrigin,
    },
    body: TOOLS_LIST,
  });
  assertStatus(refusedMcp, 401, "the MCP token is refused after deactivation");
  assert.equal((await refusedMcp.text()).includes('"tools"'), false, "no tool list for a deactivated account");

  const refusedRefresh = await refreshTokenRequest(apiToken.refreshToken ?? "", apiToken.clientId, apiResource);
  assert.notEqual(refusedRefresh.status, 200, "the refresh token mints nothing after deactivation");

  const accessRows = await target()
    .database.db.select({ revoked: oauthAccessToken.revoked })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, victim.userId));
  assert.equal(
    accessRows.every((row) => row.revoked !== null),
    true,
    "no issued access token row of the account is left unrevoked",
  );
  const refreshRows = await target()
    .database.db.select({ revoked: oauthRefreshToken.revoked })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, victim.userId));
  assert.equal(
    refreshRows.every((row) => row.revoked !== null),
    true,
    "no refresh token of the account is left usable",
  );
});

integration("deactivation revokes the public links of the artifacts the account owns and only those", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Link Victim" });
  const bystander = await trustedSession(fixtureOf(), { name: "Link Bystander" });
  const owned = await seedOwnedContent(victim.userId, bystander.userId, "Shared by the victim");
  const foreign = await seedOwnedContent(bystander.userId, victim.userId, "Owned by the bystander");
  assert.equal(await publicLinkStatus(owned.linkToken), 200, "the owned link resolves before deactivation");
  assert.equal(await publicLinkStatus(foreign.linkToken), 200, "the foreign link resolves before deactivation");

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  assert.equal(await publicLinkStatus(owned.linkToken), 404, "the owned public link stops resolving");
  assert.equal(await publicLinkStatus(foreign.linkToken), 200, "a link of another owner keeps resolving");

  const ownedLink = await target()
    .database.db.select({ revokedAt: artifactPublicLinks.revokedAt })
    .from(artifactPublicLinks)
    .where(eq(artifactPublicLinks.tokenHash, hashLinkToken(owned.linkToken)));
  assert.equal(ownedLink[0]?.revokedAt instanceof Date, true, "the owned link row records the revocation");
});

integration("deactivation keeps the artifacts, revisions, comments and issued grants", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Content Victim" });
  const reader = await trustedSession(fixtureOf(), { name: "Content Reader" });
  const owned = await seedOwnedContent(victim.userId, reader.userId, "Content that stays");
  const before = await contentOf(owned);

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  assert.deepEqual(await contentOf(owned), before, "nothing the account owns is deleted");
  assert.deepEqual(before, { artifacts: 1, revisions: 1, comments: 2, grants: 1 });

  const detail = await adminRequest(target(), `/api/artifacts/${owned.artifactId}`, {
    headers: { cookie: reader.cookie },
  });
  assertStatus(detail, 200, "the person it shared with still reads the artifact");
  assert.equal(((await detail.json()) as { id: string }).id, owned.artifactId);

  const shared = await adminRequest(target(), "/api/artifacts/shared", { headers: { cookie: reader.cookie } });
  assertStatus(shared, 200, "the shared library still lists the artifact");
  const listed = (await shared.json()) as { artifacts: { id: string }[] };
  assert.equal(
    listed.artifacts.some((row) => row.id === owned.artifactId),
    true,
    "the grant issued before deactivation still applies",
  );
});

integration("reactivation allows a fresh sign-in and restores neither sessions nor revoked links", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Reactivation Victim" });
  const reader = await trustedSession(fixtureOf(), { name: "Reactivation Reader" });
  const owned = await seedOwnedContent(victim.userId, reader.userId, "Links stay revoked");

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");
  assert.equal(await publicLinkStatus(owned.linkToken), 404);
  assert.equal(await sessionCountOf(victim.userId), 0);
  const staleCookie = victim.cookie;

  assertStatus(await setStatus(victim.userId, "active"), 200, "the administrator reactivates the account");
  assert.deepEqual(await storedStatus(victim.userId), { status: "active", deactivatedAt: null, deactivatedBy: null });
  assert.equal(await sessionCountOf(victim.userId), 0, "reactivation writes no session");

  const stale = await adminRequest(target(), "/api/artifacts", { headers: { cookie: staleCookie } });
  assertStatus(stale, 401, "the session cut by deactivation is not restored");

  assert.equal(await publicLinkStatus(owned.linkToken), 404, "the revoked public link is not restored");

  const fresh = await signIn(victim.email, victim.password);
  assertStatus(fresh, 200, "the reactivated account signs in again");
  const cookie = sessionCookieOf(fresh);
  assert.equal(cookie.length > 0, true, "a fresh session cookie is issued");
  assertStatus(
    await adminRequest(target(), "/api/artifacts", { headers: { cookie } }),
    200,
    "the fresh session reads the library",
  );
});

integration("asking for the state the account already holds is refused and changes nothing", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Idempotent Victim" });
  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  const repeated = await withAuditCapture(() => setStatus(victim.userId, "deactivated"));
  assertStatus(repeated.result, 409, "the same target state is a conflict");
  assert.deepEqual(await repeated.result.json(), { error: "status_unchanged" });
  assert.deepEqual(
    repeated.lines.filter((line) => line.event === "user.deactivated" || line.event === "user.reactivated"),
    [],
    "a refused change records nothing",
  );
  const stored = await storedStatus(victim.userId);
  assert.equal(stored.status, "deactivated", "the stored state is the one it already had");
  assert.equal(stored.deactivatedBy, actor().userId, "the metadata of the first change survives the refusal");

  assertStatus(await setStatus(victim.userId, "active"), 200, "the administrator reactivates the account");
  const reactivated = await setStatus(victim.userId, "active");
  assertStatus(reactivated, 409, "reactivating an active account is a conflict");
  assert.deepEqual(await reactivated.json(), { error: "status_unchanged" });
});

integration("the endpoint refuses an unknown subject and a body that names no state", async () => {
  const missing = await setStatus(randomUUID(), "deactivated");
  assertStatus(missing, 404, "an unknown account is not found");
  assert.deepEqual(await missing.json(), { error: "user_not_found" });

  const victim = await trustedSession(fixtureOf(), { name: "Malformed Body Victim" });
  const malformed = await adminPost(target(), statusPath(victim.userId), { state: "deactivated" }, actor().cookie);
  assertStatus(malformed, 400, "a body that names no known state is refused");
  assert.deepEqual(await malformed.json(), { error: "invalid_body" });
  assert.equal((await storedStatus(victim.userId)).status, "active", "the refused body changes nothing");
});

integration("each change records one event naming the actor and the person", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Audited Victim" });

  const deactivated = await withAuditCapture(() => setStatus(victim.userId, "deactivated"));
  assertStatus(deactivated.result, 200, "the audited deactivation is applied");
  const deactivationEvents = deactivated.lines.filter((line) => line.event === "user.deactivated");
  assert.equal(deactivationEvents.length, 1, "one deactivation records exactly one event");
  const deactivation = deactivationEvents[0] ?? {};
  assert.equal(deactivation.actorId, actor().userId);
  assert.equal(deactivation.actorRole, "administrator");
  assert.equal(deactivation.subjectId, victim.userId);
  assert.equal(deactivation.outcome, "applied");
  assert.equal(JSON.stringify(deactivation).includes("password"), false, "no credential reaches the line");

  const reactivated = await withAuditCapture(() => setStatus(victim.userId, "active"));
  assertStatus(reactivated.result, 200, "the audited reactivation is applied");
  const reactivationEvents = reactivated.lines.filter((line) => line.event === "user.reactivated");
  assert.equal(reactivationEvents.length, 1, "one reactivation records exactly one event");
  assert.equal((reactivationEvents[0] ?? {}).subjectId, victim.userId);
  assert.equal((reactivationEvents[0] ?? {}).actorId, actor().userId);
});

integration("the response names the account and its new state", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Answer Victim" });
  const response = await setStatus(victim.userId, "deactivated");
  assertStatus(response, 200, "the administrator deactivates the account");
  assert.deepEqual(await response.json(), { user: { id: victim.userId, status: "deactivated" } });
  assert.equal((await storedStatus(victim.userId)).status, "deactivated");
  assert.equal((await storedStatus(victim.userId)).deactivatedBy, actor().userId);
});

integration("deactivation revokes only the tokens issued to the account it deactivates", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Token Scope Victim" });
  const bystander = await trustedSession(fixtureOf(), { name: "Token Scope Bystander" });
  const resource = publicApiResource(target().config);
  const victimToken = await earnToken(victim.cookie, "artifacts:read offline_access", resource);
  const bystanderToken = await earnToken(bystander.cookie, "artifacts:read offline_access", resource);

  const issuedAt = new Date();
  const storedToken = (userId: string | null) => ({
    id: randomUUID(),
    token: `lifecycle-${randomUUID()}`,
    clientId: victimToken.clientId,
    userId,
    expiresAt: new Date(issuedAt.getTime() + 900_000),
    createdAt: issuedAt,
    scopes: ["artifacts:read"],
  });
  const victimAccess = storedToken(victim.userId);
  const bystanderAccess = storedToken(bystander.userId);
  const subjectlessAccess = storedToken(null);
  await target().database.db.insert(oauthAccessToken).values([victimAccess, bystanderAccess, subjectlessAccess]);

  assertStatus(await setStatus(victim.userId, "deactivated"), 200, "the administrator deactivates the account");

  const revokedOf = async (id: string): Promise<Date | null> => {
    const rows = await target()
      .database.db.select({ revoked: oauthAccessToken.revoked })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.id, id));
    assert.ok(rows[0], "the stored token row survives");
    return rows[0].revoked;
  };
  assert.notEqual(await revokedOf(victimAccess.id), null, "the access token of the deactivated account is revoked");
  assert.equal(await revokedOf(bystanderAccess.id), null, "another account's access token is not revoked");
  assert.equal(
    await revokedOf(subjectlessAccess.id),
    null,
    "an access token that belongs to no account is not revoked",
  );

  const victimRefresh = await target()
    .database.db.select({ revoked: oauthRefreshToken.revoked })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, victim.userId));
  assert.equal(victimRefresh.length > 0, true, "the victim holds issued refresh tokens");
  assert.equal(
    victimRefresh.every((row) => row.revoked !== null),
    true,
    "no refresh token of the deactivated account stays usable",
  );

  const bystanderRefresh = await target()
    .database.db.select({ revoked: oauthRefreshToken.revoked })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, bystander.userId));
  assert.equal(bystanderRefresh.length > 0, true, "another account holds issued refresh tokens");
  assert.equal(
    bystanderRefresh.every((row) => row.revoked === null),
    true,
    "another account's refresh tokens are not revoked",
  );
  assertStatus(
    await refreshTokenRequest(bystanderToken.refreshToken ?? "", bystanderToken.clientId, resource),
    200,
    "another account still mints a token from its refresh token",
  );
});

integration("a bearer token without a subject is refused on both audiences", async () => {
  const signer = await startTokenSigner();
  try {
    const config = target().config;
    const auth = createAuthHolder({ config, database: target().database }).auth;
    const isAccountActive = (userId: string) => accountIsActive(target().database.db, userId);
    const mcpOptions = {
      jwksUrl: signer.jwksUrl,
      resource: publicResource(config),
      issuer: publicIssuer(config),
      challengeScopes: ["artifacts:read", "artifacts:write"],
      isAccountActive,
    };
    const apiOptions = {
      ...mcpOptions,
      resource: publicApiResource(config),
      challengeScopes: [...API_RESOURCE_SCOPES],
    };
    const issuedAt = Math.floor(Date.now() / 1000);
    const claimsFor = (audience: string) => ({
      iss: publicIssuer(config),
      aud: audience,
      azp: `lifecycle-${randomUUID()}`,
      scope: "artifacts:read",
      iat: issuedAt,
      exp: issuedAt + 900,
    });
    const requestFor = (token: string) =>
      new Request(`${config.publicOrigin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    let reached = 0;
    const accepted = () => {
      reached += 1;
      return new Response("accepted", { status: 200 });
    };

    const mcpAnswer = await createMcpBearerVerifier(auth, mcpOptions)(
      requestFor(signer.sign(claimsFor(publicResource(config)))),
      accepted,
    );
    assert.equal(reached, 0, "an MCP token without a subject never reaches the server");
    assertStatus(mcpAnswer, 401, "the MCP audience refuses a token without a subject");
    assert.deepEqual(await mcpAnswer.json(), { error: "invalid_token" });

    const apiAnswer = await createMcpBearerVerifier(auth, apiOptions)(
      requestFor(signer.sign(claimsFor(publicApiResource(config)))),
      accepted,
    );
    assert.equal(reached, 0, "an API token without a subject never reaches the handler");
    assertStatus(apiAnswer, 401, "the API audience refuses a token without a subject");
    assert.deepEqual(await apiAnswer.json(), { error: "invalid_token" });

    const bothAnswer = await createMultiAudienceBearerVerifier(auth, [mcpOptions, apiOptions])(
      requestFor(signer.sign(claimsFor(publicApiResource(config)))),
      accepted,
    );
    assert.equal(reached, 0, "no audience of the shared verifier accepts a token without a subject");
    assertStatus(bothAnswer, 401, "the shared verifier refuses a token without a subject");
  } finally {
    await signer.close();
  }
});

integration("two concurrent deactivations apply one change and record one event", async () => {
  const victim = await trustedSession(fixtureOf(), { name: "Concurrent Victim" });
  const pool = target().database.pool;
  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query(`select 1 from "user" where id = $1 for update`, [victim.userId]);
    const captured = await withAuditCapture(async () => {
      const pending = Promise.all([setStatus(victim.userId, "deactivated"), setStatus(victim.userId, "deactivated")]);
      try {
        await waitForLockedWriters(pool, 2);
      } finally {
        await holder.query("rollback");
      }
      return await pending;
    });

    const answers = captured.result;
    const applied = answers.filter((response) => response.status === 200);
    const refused = answers.filter((response) => response.status === 409);
    assert.equal(
      applied.length,
      1,
      `exactly one concurrent deactivation applies (statuses ${answers.map((response) => response.status).join(",")})`,
    );
    assert.equal(refused.length, 1, "the losing writer is refused as unchanged");
    assert.deepEqual(await refused[0]?.json(), { error: "status_unchanged" });
    assert.deepEqual(await applied[0]?.json(), { user: { id: victim.userId, status: "deactivated" } });

    const events = captured.lines.filter((line) => line.event === "user.deactivated");
    assert.equal(events.length, 1, "one applied change records exactly one event");
    assert.equal(events[0]?.subjectId, victim.userId);
    assert.equal(events[0]?.actorId, actor().userId);

    const stored = await storedStatus(victim.userId);
    assert.equal(stored.status, "deactivated", "the stored state is the one both requests asked for");
    assert.equal(stored.deactivatedBy, actor().userId);
  } finally {
    holder.release();
  }
});
