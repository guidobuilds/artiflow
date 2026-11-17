import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { canReadArtifact, createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SKIP = DATABASE_URL ? false : "DATABASE_URL missing; run with --env-file=.env.local";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Owner = { cookie: string; userId: string; email: string };
type Reply = { status: number; text: string; json: Record<string, unknown> | null };

let database: Database;
let admin: Pool, pool: Pool, sharing: Hono, server: ReturnType<typeof serve>;
let baseUrl = "",
  databaseName = "",
  publicOrigin = "";
let a: Owner,
  b: Owner,
  c: Owner,
  artifactId = "",
  doomedId = "";

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
  };
};
const send = (
  method: string,
  path: string,
  body: unknown,
  owner?: Owner,
  headers: Record<string, string> = {},
): Promise<Reply> =>
  read(
    path,
    {
      method,
      headers: { origin: publicOrigin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    owner,
  );
const sharesPath = (id = artifactId): string => `/api/artifacts/${id}/shares`;
const listed = async (id: string, owner?: Owner): Promise<Record<string, unknown>[]> =>
  ((await read(sharesPath(id), {}, owner)).json?.shares ?? []) as Record<string, unknown>[];
const listedAll = (reply: Reply): Record<string, unknown>[] => (reply.json?.shares ?? []) as Record<string, unknown>[];

const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name, email: `i5b1-${randomUUID()}@example.test` },
  );
  return { cookie: owner.cookie, email: owner.email, userId: owner.userId };
};
const seed = async (owner: Owner, title: string): Promise<string> => {
  const id = randomUUID();
  await pool.query(`insert into artifacts ("id", "ownerId", "title") values ($1, $2, $3)`, [id, owner.userId, title]);
  return id;
};

before(async () => {
  if (SKIP) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_shares_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  database = createDatabase(new URL(`/${databaseName}`, DATABASE_URL).toString());
  pool = database.pool;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  const config = loadConfig(process.env);
  publicOrigin = config.publicOrigin;
  const auth = createAuth(config, database);
  sharing = createSharingApp({ database, auth, publicOrigin });
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", sharing);
  app.all("/api/artifacts/*", (c) => c.json({ error: "method_not_allowed" }, 405));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  a = await seedOwner("Shares Owner A");
  b = await seedOwner("Shares Recipient B");
  c = await seedOwner("Shares Stranger C");
  artifactId = await seed(a, "Shared artifact");
  doomedId = await seed(a, "Doomed artifact");
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_shares_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "the owner grants, lists, revokes and loses the grant, one row per recipient",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const created = await send("POST", sharesPath(), { email: b.email }, a);
    assert.deepEqual(
      [
        created.status,
        created.json?.sharedWith,
        UUID_RE.test(created.json?.id as string),
        typeof created.json?.createdAt,
      ],
      [201, { email: b.email }, true, "string"],
    );
    const id = created.json?.id as string;
    const duplicate = await send("POST", sharesPath(), { email: b.email }, a);
    assert.deepEqual(
      [duplicate.status, duplicate.json],
      [409, { error: "already_shared" }],
      "a repeated grant is a conflict",
    );
    const list = await read(sharesPath(), {}, a);
    assert.deepEqual(
      [
        list.status,
        listedAll(list).map((share) => [
          share.id,
          share.sharedWithUserId,
          (share.sharedWith as Record<string, string>).email,
        ]),
      ],
      [200, [[id, b.userId, b.email]]],
    );
    assert.deepEqual(
      [await send("DELETE", `${sharesPath()}/${id}`, {}, a)],
      [{ status: 200, text: '{"ok":true}', json: { ok: true } }],
    );
    assert.deepEqual(
      [(await read(sharesPath(), {}, a)).json, (await send("DELETE", `${sharesPath()}/${id}`, {}, a)).json],
      [{ shares: [] }, { error: "not_found" }],
      "revocation is explicit, not idempotent",
    );
    assert.deepEqual(
      [
        (await send("DELETE", `${sharesPath()}/${randomUUID()}`, {}, a)).status,
        (await send("DELETE", `${sharesPath()}/not-a-uuid`, {}, a)).status,
      ],
      [404, 404],
      "unknown and malformed grant ids answer alike",
    );
  },
);

test(
  "recipient email resolution is case-insensitive even though the column is not",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const exact = await pool.query<{ count: number }>(`select count(*)::int as count from "user" where "email" = $1`, [
      b.email.toUpperCase(),
    ]);
    assert.equal(exact.rows[0]?.count, 0, "a case-sensitive lookup would miss the registered recipient");
    const upper = await send("POST", sharesPath(doomedId), { email: `  ${b.email.toUpperCase()}  ` }, a);
    assert.deepEqual(
      [upper.status, upper.json?.sharedWith],
      [201, { email: b.email }],
      "the stored email is returned, not the supplied casing",
    );
    assert.equal(
      (await send("POST", sharesPath(doomedId), { email: b.email }, a)).status,
      409,
      "normalizing cannot bypass the uniqueness constraint",
    );
  },
);

test(
  "self-share is a typed 400, an unregistered email is 404 recipient_not_found",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const self = await send("POST", sharesPath(), { email: a.email.toUpperCase() }, a);
    assert.deepEqual([self.status, self.json], [400, { error: "invalid_recipient" }]);
    const unknown = await send("POST", sharesPath(), { email: `nobody-${randomUUID()}@example.test` }, a);
    assert.deepEqual(
      [unknown.status, unknown.json],
      [404, { error: "recipient_not_found" }],
      "distinct from the artifact not_found shape",
    );
    for (const body of [{}, { email: "" }, { email: 42 }, { email: "   " }])
      assert.equal((await send("POST", sharesPath(), body, a)).status, 400, `invalid body ${JSON.stringify(body)}`);
  },
);

test(
  "a foreign owner and a missing artifact answer identically on all three endpoints",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const grantId = (await send("POST", sharesPath(), { email: c.email }, a)).json?.id as string;
    const cases = await Promise.all([
      read(sharesPath(), {}, b),
      read(`/api/artifacts/${randomUUID()}/shares`, {}, a),
      send("POST", sharesPath(), { email: c.email }, b),
      send("POST", `/api/artifacts/${randomUUID()}/shares`, { email: c.email }, a),
      send("DELETE", `${sharesPath()}/${grantId}`, {}, b),
      send("DELETE", `/api/artifacts/${randomUUID()}/shares/${grantId}`, {}, a),
    ]);
    assert.deepEqual(
      cases.map((reply) => [reply.status, reply.text]),
      Array.from({ length: 6 }, () => [404, '{"error":"not_found"}']),
      "no foreign-or-missing distinction and no grant leak",
    );
    const [anonymousGet, anonymousPost] = [
      await read(sharesPath()),
      await send("POST", sharesPath(), { email: c.email }),
    ];
    assert.deepEqual(
      [anonymousGet.status, anonymousPost.status, (await read(sharesPath(), {}, a)).status],
      [401, 401, 200],
      "the cookie session is the only identity",
    );
  },
);

test(
  "a soft-deleted artifact is gone from listing, granting and revocation",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const grantId = (await listed(doomedId, a))[0]?.id as string;
    await pool.query(`update artifacts set "deletedAt" = now() where "id" = $1`, [doomedId]);
    const replies = [
      await read(sharesPath(doomedId), {}, a),
      await send("POST", sharesPath(doomedId), { email: c.email }, a),
      await send("DELETE", `${sharesPath(doomedId)}/${grantId}`, {}, a),
    ];
    assert.deepEqual(
      replies.map((reply) => [reply.status, reply.json]),
      Array.from({ length: 3 }, () => [404, { error: "not_found" }]),
      "a deleted artifact keeps no readable share surface",
    );
    assert.equal(await canReadArtifact(database.db, b.userId, doomedId), false, "and its grant no longer grants reads");
  },
);

test(
  "canReadArtifact is the single read predicate: owner, recipient, then nothing",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const probe = await seed(a, "Predicate artifact");
    assert.deepEqual(
      [
        await canReadArtifact(database.db, a.userId, probe),
        await canReadArtifact(database.db, b.userId, probe),
        await canReadArtifact(database.db, c.userId, probe),
        await canReadArtifact(database.db, a.userId, randomUUID()),
      ],
      [true, false, false, false],
      "only the owner reads before any grant, and a missing artifact reads for nobody",
    );
    const grantId = (await send("POST", sharesPath(probe), { email: b.email }, a)).json?.id as string;
    assert.deepEqual(
      [await canReadArtifact(database.db, b.userId, probe), await canReadArtifact(database.db, c.userId, probe)],
      [true, false],
      "the grant alone is what the recipient gains",
    );
    assert.equal((await send("DELETE", `${sharesPath(probe)}/${grantId}`, {}, a)).status, 200);
    assert.deepEqual(
      [await canReadArtifact(database.db, b.userId, probe), await canReadArtifact(database.db, a.userId, probe)],
      [false, true],
      "revocation stops future reads, ownership never does",
    );
  },
);

test(
  "sharing routes survive library's catch-all only when they are registered first",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const fresh = await seed(a, "Catch-all artifact");
    const get = await read(sharesPath(fresh), {}, a);
    assert.deepEqual(
      [get.status, get.json],
      [200, { shares: [] }],
      "GET .../shares is not swallowed by the last-registered catch-all",
    );
    const mutation = { origin: publicOrigin, "content-type": "application/json" };
    const refused = await read(sharesPath(fresh), { method: "PUT", headers: mutation, body: "{}" }, a);
    assert.deepEqual(
      [refused.status, refused.json],
      [405, { error: "method_not_allowed" }],
      "other methods still fall through to the catch-all",
    );
    const swapped = new Hono();
    swapped.all("/api/artifacts/*", (c) => c.json({ error: "method_not_allowed" }, 405));
    swapped.route("/", sharing);
    assert.equal(
      (await swapped.request(sharesPath(fresh), { headers: { cookie: a.cookie } })).status,
      405,
      "ordering is load-bearing",
    );
    const [noOrigin, foreign, notJson, deleteNoOrigin] = [
      await read(
        sharesPath(fresh),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: c.email }) },
        a,
      ),
      await send("POST", sharesPath(fresh), { email: c.email }, a, { origin: "http://127.0.0.1:5173.evil.test" }),
      await send("POST", sharesPath(fresh), { email: c.email }, a, { "content-type": "text/plain" }),
      await read(`${sharesPath(fresh)}/${randomUUID()}`, { method: "DELETE" }, a),
    ];
    assert.deepEqual(
      [noOrigin.json, foreign.json, notJson.json, deleteNoOrigin.json],
      [
        { error: "origin_not_allowed" },
        { error: "origin_not_allowed" },
        { error: "json_content_type_required" },
        { error: "origin_not_allowed" },
      ],
      "cookie mutations keep the exact-Origin and JSON discipline",
    );
    assert.deepEqual([noOrigin.status, foreign.status, notJson.status, deleteNoOrigin.status], [403, 403, 415, 403]);
  },
);
