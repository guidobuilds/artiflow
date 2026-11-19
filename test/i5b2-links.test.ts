import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
import { createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SKIP = DATABASE_URL ? false : "DATABASE_URL missing; run with --env-file=.env.local";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
type Owner = { cookie: string; userId: string; email: string };
type Reply = { status: number; text: string; json: Record<string, unknown> | null };

let database: Database;
let admin: Pool, pool: Pool, sharing: Hono, server: ReturnType<typeof serve>;
let baseUrl = "",
  databaseName = "",
  publicOrigin = "";
let a: Owner,
  b: Owner,
  artifactId = "",
  firstLink = "",
  firstToken = "",
  rotatedLink = "";

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
const linksPath = (id = artifactId): string => `/api/artifacts/${id}/links`;
const linkPath = (linkId: string, id = artifactId): string => `${linksPath(id)}/${linkId}`;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const expectCode = (query: Promise<unknown>, code: string): Promise<void> =>
  assert.rejects(
    query,
    (error: { code?: string }) => (assert.equal(error.code, code, `expected SQLSTATE ${code}`), true),
  );

const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name, email: `i5b2-${randomUUID()}@example.test` },
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
  databaseName = `artiflow_links_test_${randomUUID().replaceAll("-", "")}`;
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
  a = await seedOwner("Links Owner A");
  b = await seedOwner("Links Owner B");
  artifactId = await seed(a, "Linked artifact");
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_links_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "create returns the raw token once and stores only its lowercase hex hash",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const created = await send("POST", linksPath(), {}, a);
    const token = created.json?.token as string;
    assert.deepEqual(
      [created.status, TOKEN_RE.test(token), UUID_RE.test(created.json?.id as string)],
      [201, true, true],
      "43-char base64url token and a database-generated uuid id",
    );
    assert.equal(created.json?.url, `${publicOrigin}/share/${token}`, "the url contract I5b-3 must serve");
    const stored = await pool.query<{ tokenHash: string; revokedAt: Date | null }>(
      `select "tokenHash", "revokedAt" from "artifactPublicLinks" where "id" = $1`,
      [created.json?.id],
    );
    const hash = stored.rows[0]?.tokenHash as string;
    assert.deepEqual(
      [hash, HASH_RE.test(hash), stored.rows[0]?.revokedAt],
      [sha256(token), true, null],
      "only sha256(token) is stored, lowercase 64-hex, and a fresh link is live",
    );
    assert.equal(hash.includes(token), false, "the token is not derivable back out of the stored value");
    firstLink = created.json?.id as string;
    firstToken = token;
  },
);

test("listing exposes ids and revocation only, never a token or a hash", { skip: SKIP, timeout: 60_000 }, async () => {
  const second = (await send("POST", linksPath(), {}, a)).json?.id as string;
  assert.equal((await send("DELETE", linkPath(second), {}, a)).status, 200);
  const list = await read(linksPath(), {}, a);
  const links = (list.json?.links ?? []) as Record<string, unknown>[];
  const byId = new Map(links.map((link) => [link.id as string, link]));
  assert.deepEqual([list.status, byId.size], [200, 2], "both links are listed");
  assert.deepEqual(
    Object.keys(byId.get(second) ?? {}),
    ["id", "createdAt", "revokedAt", "showComments"],
    "a link exposes no token, no hash and no artifact id",
  );
  assert.deepEqual(
    [typeof byId.get(second)?.revokedAt, byId.get(firstLink)?.revokedAt],
    ["string", null],
    "a revoked link reports revokedAt, a live one reports null",
  );
  assert.deepEqual(
    [list.text.includes(firstToken), /tokenHash/.test(list.text)],
    [false, false],
    "no token and no hash reaches the owner list",
  );
});

test(
  "rotation revokes the predecessor in place and issues a different token",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const rotated = await send("POST", `${linkPath(firstLink)}/rotate`, {}, a);
    rotatedLink = rotated.json?.id as string;
    assert.deepEqual(
      [rotated.status, rotated.json?.token === firstToken, UUID_RE.test(rotatedLink), rotated.json?.url],
      [201, false, true, `${publicOrigin}/share/${rotated.json?.token as string}`],
      "a new token, a new row and the same url contract",
    );
    const rows = await pool.query<{
      id: string;
      tokenHash: string;
      revokedAt: Date | null;
      rotatedFromId: string | null;
    }>(`select "id", "tokenHash", "revokedAt", "rotatedFromId" from "artifactPublicLinks" where "id" = any($1)`, [
      [firstLink, rotatedLink],
    ]);
    const old = rows.rows.find((row) => row.id === firstLink),
      next = rows.rows.find((row) => row.id === rotatedLink);
    assert.deepEqual(
      [next?.rotatedFromId, next?.revokedAt, old?.revokedAt instanceof Date],
      [firstLink, null, true],
      "the successor points at its predecessor, which is revoked in place",
    );
    assert.equal(
      old?.tokenHash,
      sha256(firstToken),
      "the old row is retained so its token hash can never resolve again",
    );
    assert.deepEqual(
      [(await send("POST", `${linkPath(firstLink)}/rotate`, {}, a)).status],
      [409],
      "a revoked link is not rotatable",
    );
    const twice = await send("POST", `${linkPath(firstLink)}/rotate`, {}, a);
    assert.deepEqual([twice.json], [{ error: "already_revoked" }]);
  },
);

test(
  "revocation is explicit, a repeat conflicts, and foreign or unknown ids are 404",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    assert.deepEqual(
      [await send("DELETE", linkPath(rotatedLink), {}, a)],
      [{ status: 200, text: '{"ok":true}', json: { ok: true } }],
    );
    const stored = await pool.query<{ revokedAt: Date | null }>(
      `select "revokedAt" from "artifactPublicLinks" where "id" = $1`,
      [rotatedLink],
    );
    assert.equal(
      [stored.rows.length, stored.rows[0]?.revokedAt instanceof Date].join(),
      "1,true",
      "revocation sets a timestamp and keeps the row",
    );
    const repeat = await send("DELETE", linkPath(rotatedLink), {}, a);
    assert.deepEqual([repeat.status, repeat.json], [409, { error: "already_revoked" }], "revocation is not idempotent");
    const otherArtifact = await seed(a, "Second linked artifact");
    const otherLink = (await send("POST", linksPath(otherArtifact), {}, a)).json?.id as string;
    const refusals = [
      await send("DELETE", linkPath(randomUUID()), {}, a),
      await send("DELETE", linkPath("not-a-uuid"), {}, a),
      await send("DELETE", linkPath(otherLink), {}, a),
    ];
    assert.deepEqual(
      refusals.map((reply) => [reply.status, reply.text]),
      Array.from({ length: 3 }, () => [404, '{"error":"not_found"}']),
      "unknown, malformed and foreign-artifact link ids answer alike",
    );
  },
);

test(
  "a foreign owner, a missing artifact and a deleted artifact answer not_found on all four routes",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const foreignArtifact = await seed(b, "Foreign linked artifact");
    const foreignLink = (await send("POST", linksPath(foreignArtifact), {}, b)).json?.id as string;
    const cases = await Promise.all([
      read(linksPath(foreignArtifact), {}, a),
      read(linksPath(randomUUID()), {}, a),
      send("POST", linksPath(foreignArtifact), {}, a),
      send("POST", linksPath(randomUUID()), {}, a),
      send("POST", `${linkPath(foreignLink, foreignArtifact)}/rotate`, {}, a),
      send("POST", `${linksPath(randomUUID())}/${randomUUID()}/rotate`, {}, a),
      send("DELETE", linkPath(foreignLink, foreignArtifact), {}, a),
      send("DELETE", `${linksPath(randomUUID())}/${randomUUID()}`, {}, a),
    ]);
    assert.deepEqual(
      cases.map((reply) => [reply.status, reply.text]),
      Array.from({ length: 8 }, () => [404, '{"error":"not_found"}']),
      "byte-identical refusals with no foreign-link distinction",
    );
    const [anonymousGet, anonymousPost, anonymousDelete] = [
      await read(linksPath()),
      await send("POST", linksPath(), {}),
      await send("DELETE", linkPath(randomUUID()), {}),
    ];
    assert.deepEqual(
      [anonymousGet.status, anonymousPost.status, anonymousDelete.status],
      [401, 401, 401],
      "the cookie session is the only identity",
    );
    const doomed = await seed(a, "Doomed linked artifact");
    const doomedLink = (await send("POST", linksPath(doomed), {}, a)).json?.id as string;
    await pool.query(`update artifacts set "deletedAt" = now() where "id" = $1`, [doomed]);
    const after = [
      await read(linksPath(doomed), {}, a),
      await send("POST", linksPath(doomed), {}, a),
      await send("POST", `${linkPath(doomedLink, doomed)}/rotate`, {}, a),
      await send("DELETE", linkPath(doomedLink, doomed), {}, a),
    ];
    assert.deepEqual(
      after.map((reply) => [reply.status, reply.json]),
      Array.from({ length: 4 }, () => [404, { error: "not_found" }]),
      "a soft-deleted artifact exposes no link surface",
    );
  },
);

test(
  "cookie mutations keep the exact-Origin and JSON discipline; the list stays unguarded",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const fresh = (await send("POST", linksPath(), {}, a)).json?.id as string;
    const cases = [
      await read(linksPath(), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, a),
      await send("POST", linksPath(), {}, a, { origin: "http://127.0.0.1:5173.evil.test" }),
      await send("POST", linksPath(), {}, a, { "content-type": "text/plain" }),
      await read(
        `${linkPath(fresh)}/rotate`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        a,
      ),
      await read(linkPath(fresh), { method: "DELETE" }, a),
      await send("DELETE", linkPath(fresh), {}, a, { "content-type": "text/plain" }),
    ];
    assert.deepEqual(
      cases.map((reply) => [reply.status, reply.json]),
      [
        [403, { error: "origin_not_allowed" }],
        [403, { error: "origin_not_allowed" }],
        [415, { error: "json_content_type_required" }],
        [403, { error: "origin_not_allowed" }],
        [403, { error: "origin_not_allowed" }],
        [415, { error: "json_content_type_required" }],
      ],
      "one guard covers every cookie mutation, including DELETE",
    );
    assert.equal(
      (await read(linksPath(), {}, a)).status,
      200,
      "the GET list never mutates, so it carries no Origin requirement",
    );
  },
);

test("0007 refuses a malformed or uppercase token hash at the database", { skip: SKIP, timeout: 60_000 }, async () => {
  const insert = (tokenHash: string) =>
    pool.query(`insert into "artifactPublicLinks" ("artifactId", "tokenHash") values ($1, $2)`, [
      artifactId,
      tokenHash,
    ]);
  await expectCode(insert("abc"), "23514");
  await expectCode(insert(sha256(randomUUID()).toUpperCase()), "23514");
  assert.equal((await insert(sha256(randomUUID()))).rowCount, 1, "the format the app produces is accepted");
});

test("the 0007 migration is one additive CHECK statement and the journal records idx 7", () => {
  const drizzleDir = new URL("../drizzle/", import.meta.url);
  const files = readdirSync(drizzleDir).filter((name) => /^0007_.*\.sql$/.test(name));
  assert.equal(files.length, 1, "exactly one 0007 migration");
  const sql = readFileSync(new URL(files[0] as string, drizzleDir), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  assert.equal(statements.length, 1, "a single statement: the token hash CHECK");
  assert.match(
    statements[0] as string,
    /^ALTER TABLE "artifactPublicLinks" ADD CONSTRAINT "artifactPublicLinks_tokenHash_hex_check" CHECK/,
    "the constraint name matches the declared schema",
  );
  assert.match(statements[0] as string, /~ '\^\[0-9a-f\]\{64\}\$'/, "lowercase 64-hex is enforced in SQL");
  for (const line of sql.split("\n"))
    assert.equal(
      /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER TABLE "artifacts")/i.test(line),
      false,
      `strictly additive: ${line}`,
    );
  const journal = readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8");
  assert.ok(journal.includes(`"idx": 7`), "journal records idx 7");
});

test(
  "link routes survive library's catch-all only when they are registered first",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const fresh = await seed(a, "Catch-all linked artifact");
    assert.deepEqual(
      [(await read(linksPath(fresh), {}, a)).json],
      [{ links: [] }],
      "GET .../links is not swallowed by the last-registered catch-all",
    );
    const refused = await read(
      linksPath(fresh),
      { method: "PUT", headers: { origin: publicOrigin, "content-type": "application/json" }, body: "{}" },
      a,
    );
    assert.deepEqual(
      [refused.status, refused.json],
      [405, { error: "method_not_allowed" }],
      "other methods still fall through to the catch-all",
    );
    const swapped = new Hono();
    swapped.all("/api/artifacts/*", (c) => c.json({ error: "method_not_allowed" }, 405));
    swapped.route("/", sharing);
    assert.equal(
      (await swapped.request(linksPath(fresh), { headers: { cookie: a.cookie } })).status,
      405,
      "ordering is load-bearing",
    );
  },
);
