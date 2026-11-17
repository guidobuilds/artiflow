import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";

import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { markArtifactDeleted } from "../apps/api/src/domain/commits.ts";
import { newRevisionStorageKey, putRevisionBytes } from "../apps/api/src/adapters/storage/s3.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import { createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { NOT_FOUND_PAGE, VIEWER_CSP } from "../apps/api/src/viewer/html.ts";
import { fetchSharedArtifacts, parseSharedArtifactList } from "../apps/dashboard/src/auth-client.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const S3_VARS = [
  "ARTIFLOW_S3_ENDPOINT",
  "ARTIFLOW_S3_BUCKET",
  "ARTIFLOW_S3_ACCESS_KEY_ID",
  "ARTIFLOW_S3_SECRET_ACCESS_KEY",
];
const ENV_READY = Boolean(DATABASE_URL) && S3_VARS.every((name) => process.env[name]);
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local";
let config: ReturnType<typeof loadConfig>;

type Owner = { cookie: string; userId: string; email: string };
type Artifact = { id: string; sha256: string | null };
type Reply = { status: number; text: string; json: Record<string, unknown> | null; headers: Headers };

let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "";
let a: Owner, b: Owner, c: Owner, shared: Artifact, shape: Artifact, doomed: Artifact, revoked: Artifact;
const usedKeys: string[] = [];

const read = async (path: string, init: RequestInit = {}, owner?: Owner): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, ...(owner ? { cookie: owner.cookie } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    headers: response.headers,
  };
};
const listed = (reply: Reply): Record<string, unknown>[] => (reply.json?.artifacts ?? []) as Record<string, unknown>[];
const ids = (reply: Reply): unknown[] => listed(reply).map((artifact) => artifact.id);
const sharers = (reply: Reply): unknown[] => listed(reply).map((artifact) => artifact.sharedBy);

const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: config.publicOrigin },
    { name, email: `i5c2-${randomUUID()}@example.test` },
  );
  return { cookie: owner.cookie, email: owner.email, userId: owner.userId };
};
const seed = async (owner: Owner, title: string, withBytes = false): Promise<Artifact> => {
  const id = randomUUID();
  await pool.query(`insert into artifacts ("id", "ownerId", "title") values ($1, $2, $3)`, [id, owner.userId, title]);
  if (!withBytes) return { id, sha256: null };
  const bytes = new TextEncoder().encode(`<!doctype html><p>${title}</p><script>document.title = "pwn"</script>`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = newRevisionStorageKey();
  assert.equal(
    (await putRevisionBytes({ storage, storageKey, sha256, bytes })).ok,
    true,
    "owned S3 accepts one revision body",
  );
  usedKeys.push(storageKey);
  const revisionId = randomUUID();
  await pool.query(
    `insert into "artifactRevisions" ("id", "artifactId", "revision", "sizeBytes", "sha256", "storageKey") values ($1, $2, 1, $3, $4, $5)`,
    [revisionId, id, bytes.length, sha256, storageKey],
  );
  await pool.query(`update artifacts set "currentRevisionId" = $2, "observedSizeBytes" = $3 where "id" = $1`, [
    id,
    revisionId,
    bytes.length,
  ]);
  return { id, sha256 };
};
const grant = async (artifactId: string, email: string): Promise<string> => {
  const reply = await read(
    `/api/artifacts/${artifactId}/shares`,
    {
      method: "POST",
      headers: { origin: config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    },
    a,
  );
  assert.deepEqual([reply.status, reply.json?.sharedWith], [201, { email }], "the real grant route creates the row");
  return reply.json?.id as string;
};

before(async () => {
  if (!ENV_READY) return;
  config = loadConfig(process.env);
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_shared_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  database = createDatabase(new URL(`/${databaseName}`, DATABASE_URL).toString());
  pool = database.pool;
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
  const auth = createAuth(config, database);
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createSharingApp({ database, auth, publicOrigin: config.publicOrigin }));
  app.route("/", createLibraryApp({ database, auth, storage }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  a = await seedOwner("Shared Owner A");
  b = await seedOwner("Shared Recipient B");
  c = await seedOwner("Shared Stranger C");
  shared = await seed(a, "Shared artifact", true);
  shape = await seed(a, "Owner list shape artifact");
  doomed = await seed(a, "Doomed artifact");
  revoked = await seed(a, "Revoked artifact");
});

after(async () => {
  if (!ENV_READY) return;
  for (const key of usedKeys) {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    assert.equal(
      await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })).then(
        () => true,
        () => false,
      ),
      false,
      "every own S3 key was deleted",
    );
  }
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_shared_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "(a) the recipient lists what was shared with them, with the owner's email as sharedBy",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const before = await read("/api/artifacts/shared", {}, b);
    assert.deepEqual([before.status, before.json], [200, { artifacts: [] }], "nothing is listed before any grant");
    await grant(shared.id, b.email);
    const after = await read("/api/artifacts/shared", {}, b);
    assert.deepEqual(
      [after.status, ids(after), sharers(after)],
      [200, [shared.id], [{ email: a.email }]],
      "one row, named by the sharer's email",
    );
    const row = listed(after)[0] ?? {};
    assert.deepEqual(
      [row.title, row.revisionCount, typeof row.observedSizeBytes, typeof row.createdAt, "grantedByUserId" in row],
      ["Shared artifact", 1, "number", "string", false],
      "same column shape as the owner list, plus sharedBy",
    );
    assert.deepEqual([after.text.includes(a.userId), after.text.includes(b.userId)], [false, false]);
  },
);

test(
  "(b) a stranger sees an empty list and (c) a grant never changes the owner list shape",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    assert.deepEqual(
      [(await read("/api/artifacts/shared", {}, c)).json],
      [{ artifacts: [] }],
      "a non-recipient gets an empty list, not a 404",
    );
    const ownerChars = await read("/api/artifacts", {}, a);
    assert.equal(ownerChars.text.includes("sharedBy"), false, "the owner list carries no recipient field");
    await grant(shape.id, b.email);
    const afterward = await read("/api/artifacts", {}, a);
    assert.deepEqual(
      [afterward.status, afterward.text === ownerChars.text, ids(afterward).includes(shape.id)],
      [200, true, true],
      "granting is byte-invisible to the owner list",
    );
    assert.deepEqual([ids(await read("/api/artifacts", {}, b))], [[]], "a shared artifact is not an owned one");
  },
);

test(
  "(d) a soft-deleted share and (e) a revoked grant both leave the recipient list",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    await grant(doomed.id, b.email);
    await grant(revoked.id, b.email);
    const both = ids(await read("/api/artifacts/shared", {}, b));
    assert.deepEqual(
      [both.includes(doomed.id), both.includes(revoked.id)],
      [true, true],
      "both grants are listed while live",
    );
    const grantId =
      (
        await pool.query<{ id: string }>(
          `select "id" from "artifactShares" where "artifactId" = $1 and "sharedWithUserId" = $2`,
          [revoked.id, b.userId],
        )
      ).rows[0]?.id ?? "";
    const revoke = await read(
      `/api/artifacts/${revoked.id}/shares/${grantId}`,
      { method: "DELETE", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: "{}" },
      a,
    );
    assert.deepEqual([revoke.status, revoke.json], [200, { ok: true }]);
    assert.equal((await markArtifactDeleted(database.db, doomed.id, a.userId)).ok, true);
    const after = ids(await read("/api/artifacts/shared", {}, b));
    assert.deepEqual(
      [after.includes(doomed.id), after.includes(revoked.id), after.includes(shared.id)],
      [false, false, true],
      "the surviving grant is the only row left",
    );
  },
);

test(
  "(g) the recipient opens the shared viewer byte-identically; a stranger gets the identical 404",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const own = await read(`/artifact/${shared.id}`, {}, a);
    const recipient = await read(`/artifact/${shared.id}`, {}, b);
    assert.deepEqual(
      [own.status, recipient.status, recipient.text === own.text],
      [200, 200, true],
      "the granted recipient receives the owner's exact wrapper page",
    );
    assert.deepEqual(
      [
        recipient.headers.get("content-type"),
        recipient.headers.get("content-security-policy"),
        recipient.headers.get("x-content-type-options"),
        recipient.headers.get("cache-control"),
      ],
      ["text/html; charset=UTF-8", VIEWER_CSP, "nosniff", "no-store"],
    );
    assert.equal(
      recipient.headers.get("content-security-policy")?.endsWith("connect-src 'self'"),
      true,
      "the recipient's page carries the same same-origin-only policy as the owner's",
    );
    assert.ok(recipient.text.includes(`/api/artifacts/${shared.id}`), "the poller targets this artifact's metadata");
    assert.deepEqual(
      [recipient.text.includes(`sandbox="allow-scripts"`), recipient.text.includes("allow-same-origin")],
      [true, false],
      "same opaque-origin sandbox as the owner viewer",
    );
    const stranger = await read(`/artifact/${shared.id}`, {}, c);
    const missing = await read(`/artifact/${randomUUID()}`, {}, c);
    assert.deepEqual(
      [stranger.status, missing.status, stranger.text === missing.text, stranger.text],
      [404, 404, true, NOT_FOUND_PAGE],
      "the canRead gate keeps foreign and missing indistinguishable, now as the branded 404 page",
    );
  },
);

test(
  "(h) no session is a 401 on the shared route, and no method but GET is served",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const anonymous = await read("/api/artifacts/shared");
    assert.deepEqual(
      [anonymous.status, anonymous.json],
      [401, { error: "unauthorized" }],
      "the cookie session is the only identity",
    );
    const post = await read(
      "/api/artifacts/shared",
      { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: "{}" },
      a,
    );
    assert.deepEqual([post.status, post.json], [405, { error: "method_not_allowed" }], "the listing is read-only");
  },
);

test("(f) the shared list is bounded at 200 newest first", { skip: SKIP, timeout: 60_000 }, async () => {
  await pool.query(
    `insert into artifacts ("id", "ownerId", "title", "createdAt") select gen_random_uuid()::text, $1, 'bound-' || g, now() + (g || ' seconds')::interval from generate_series(1, 205) g`,
    [a.userId],
  );
  await pool.query(
    `insert into "artifactShares" ("artifactId", "sharedWithUserId", "grantedByUserId") select "id", $2, $1 from artifacts where "title" like 'bound-%'`,
    [a.userId, b.userId],
  );
  const reply = await read("/api/artifacts/shared", {}, b);
  const rows = listed(reply);
  assert.deepEqual([reply.status, rows.length], [200, 200], "exactly 200 rows out of 205 live grants");
  assert.deepEqual(
    [rows[0]?.title, rows[199]?.title, rows.some((row) => row.title === "bound-5")],
    ["bound-205", "bound-6", false],
    "newest first, and the overflow tail is cut",
  );
});

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
function useFetch(reply: () => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = {
  id: "art-1",
  title: "Shared artifact",
  createdAt: "2026-10-19T08:30:00.000Z",
  observedSizeBytes: 1536,
  revisionCount: 2,
  revisionNumber: 3,
  sharedBy: { email: "owner@example.test" },
  grantedByUserId: "u-secret",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("shared rows are display-only: sharedBy is required and nothing to manage travels with them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T11:00:00.000Z") });
  const calls = useFetch(() => json({ artifacts: [row] }));
  const result = await fetchSharedArtifacts();
  const rows = result.ok ? result.value : [];
  assert.deepEqual(rows, [
    {
      id: "art-1",
      title: "Shared artifact",
      kind: "html",
      createdLabel: "2026-10-19",
      createdAt: "2026-10-19T08:30:00.000Z",
      updatedAt: null,
      sizeLabel: "1.5 KB",
      versionsLabel: "2 versions",
      verLabel: "v3",
      relLabel: "2h",
      viewerHref: "/artifact/art-1",
      sharedBy: "owner@example.test",
    },
  ]);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    "createdAt",
    "createdLabel",
    "id",
    "kind",
    "relLabel",
    "sharedBy",
    "sizeLabel",
    "title",
    "updatedAt",
    "verLabel",
    "versionsLabel",
    "viewerHref",
  ]);
  assert.equal(JSON.stringify(rows).includes("u-secret"), false, "the sharer's userId is never displayed");
  assert.deepEqual(
    [calls[0]?.url, calls[0]?.init.method, calls[0]?.init.cache, calls[0]?.init.credentials],
    ["/api/artifacts/shared", "GET", "no-store", "same-origin"],
  );
});

test("an empty or unreadable shared list stays hidden instead of rendering an empty section", async () => {
  useFetch(() => json({ artifacts: [] }));
  assert.deepEqual(
    await fetchSharedArtifacts(),
    { ok: true, value: [] },
    "zero rows is the honest empty answer the page hides",
  );
  assert.equal(
    parseSharedArtifactList({ artifacts: [{ ...row, sharedBy: {} }] }),
    null,
    "a row without a sharer email unverifies the whole list",
  );
  assert.equal(parseSharedArtifactList({ artifacts: [{ id: "art-1" }] }), null);
  useFetch(() => json({ error: "unauthorized" }, 401));
  const denied = await fetchSharedArtifacts();
  assert.deepEqual(
    [denied.ok, denied.ok === false && denied.signInRequired],
    [false, true],
    "no session is a sign-in question, not an empty list",
  );
  useFetch(() => json({ message: "db password secret-value" }, 500));
  const failed = await fetchSharedArtifacts();
  assert.deepEqual([failed.ok, failed.ok === false && failed.error.includes("secret-value")], [false, false]);
});
