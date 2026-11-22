import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";

import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { markArtifactDeleted } from "../apps/api/src/domain/commits.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createLibraryApp } from "../apps/api/src/routes/library.ts";
import { createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { VIEWER_CSP, WRAPPER_CSP } from "../apps/api/src/viewer/html.ts";
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
const config = ENV_READY ? loadConfig(process.env) : undefined;
const publicOrigin = config?.publicOrigin ?? "";
const HOSTILE = `<!doctype html><html><body><h1>Hostile</h1><script>document.title = "pwn"</script><img src=x onerror="alert(1)"><p>quotes "a" 'b'</p></body></html>`;
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing; run with --env-file=.env.local";

type Owner = { cookie: string; userId: string };
type Artifact = { id: string; revisionId: string; sha256: string };

let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "";
let a: Owner, b: Owner, hostile: Artifact, doomed: Artifact;
const usedKeys: string[] = [];

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Reply = { status: number; text: string; json: Record<string, unknown> | null; headers: Headers };
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

const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name, email: `library-${randomUUID()}@example.test` },
  );
  return { cookie: owner.cookie, userId: owner.userId };
};

const seed = async (owner: Owner, html: string, title: string, kind?: "markdown"): Promise<Artifact> => {
  const bytes = Buffer.from(html, "utf8");
  const uploadId = `upload-${randomUUID()}`;
  const sha256 = digestOf(bytes);
  assert.equal(
    (
      await createUpload(database.db, {
        ownerId: owner.userId,
        uploadId,
        declaredSizeBytes: bytes.length,
        declaredSha256: sha256,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await putChunk(database.db, { ownerId: owner.userId, uploadId, chunkIndex: 0, sizeBytes: bytes.length, sha256 }))
      .ok,
    true,
  );
  const committed = await commitUpload({ database, storage, ownerId: owner.userId, uploadId, bytes, title, kind });
  if (!committed.ok) throw new Error(`seed refused: ${committed.reason}`);
  usedKeys.push(committed.value.storageKey);
  return { id: committed.value.artifactId, revisionId: committed.value.revisionId, sha256 };
};

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
  databaseName = `artiflow_library_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(/^artiflow_library_test_[0-9a-f]{32}$/.test(databaseName), true);
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(`/${databaseName}`, DATABASE_URL);
  database = createDatabase(testUrl.toString());
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
  app.route("/", createSharingApp({ database, auth, publicOrigin }));
  app.route("/", createLibraryApp({ database, auth, storage }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  a = await seedOwner("Library Owner A");
  b = await seedOwner("Library Owner B");
  hostile = await seed(a, HOSTILE, "Hostile artifact");
  doomed = await seed(a, "<!doctype html><p>temporary</p>", "Temporary artifact");
  await seed(b, "<!doctype html><p>foreign</p>", "Foreign artifact");
});

after(async () => {
  if (!ENV_READY) return;
  for (const key of usedKeys) {
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    const left = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })).then(
      () => true,
      () => false,
    );
    assert.equal(left, false, "every own S3 key was deleted");
  }
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_library_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "the library lists only the owner's live artifacts, newest first, and refuses anonymous reads",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const anonymous = await read("/api/artifacts");
    assert.deepEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }]);
    const own = await read("/api/artifacts", {}, a);
    assert.deepEqual([own.status, listed(own).map((artifact) => artifact.id)], [200, [doomed.id, hostile.id]]);
    const newest = listed(own)[0] ?? {};
    assert.deepEqual(
      [newest.title, newest.currentRevisionId, newest.sha256, newest.revisionCount, newest.observedSizeBytes],
      ["Temporary artifact", doomed.revisionId, doomed.sha256, 1, Buffer.byteLength("<!doctype html><p>temporary</p>")],
    );
    assert.deepEqual(
      listed(await read("/api/artifacts", {}, b)).map((artifact) => artifact.title),
      ["Foreign artifact"],
    );
  },
);

test(
  "metadata and viewer are owner-only, 404-identical for foreign and missing, and gone after soft delete",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const own = await read(`/api/artifacts/${hostile.id}`, {}, a);
    assert.deepEqual(
      [own.status, own.json?.revision, own.json?.observedSizeBytes],
      [
        200,
        { id: hostile.revisionId, revisionNumber: 1, sha256: hostile.sha256, sizeBytes: Buffer.byteLength(HOSTILE) },
        Buffer.byteLength(HOSTILE),
      ],
    );
    const foreign = await read(`/api/artifacts/${hostile.id}`, {}, b);
    const missing = await read(`/api/artifacts/${randomUUID()}`, {}, a);
    const foreignView = await read(`/artifact/${hostile.id}`, {}, b);
    const missingView = await read(`/artifact/${randomUUID()}`, {}, a);
    assert.deepEqual(
      [
        foreign.status,
        missing.status,
        foreign.text === missing.text,
        foreignView.status,
        foreignView.text === missingView.text,
        foreignView.headers.get("content-type"),
        foreignView.headers.get("content-security-policy"),
      ],
      [404, 404, true, 404, true, "text/html; charset=UTF-8", WRAPPER_CSP],
      "foreign and missing artifacts answer identically, as the branded HTML page",
    );
    const anonymous = await read(`/artifact/${hostile.id}`);
    assert.deepEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }]);
    assert.equal((await markArtifactDeleted(database.db, doomed.id, a.userId)).ok, true);
    assert.deepEqual(
      [
        (await read(`/api/artifacts/${doomed.id}`, {}, a)).status,
        (await read(`/artifact/${doomed.id}`, {}, a)).status,
        listed(await read("/api/artifacts", {}, a)).map((artifact) => artifact.id),
      ],
      [404, 404, [hostile.id]],
    );
  },
);

test("a markdown artifact renders formatted and escapes raw HTML", { skip: SKIP, timeout: 60_000 }, async () => {
  const doc = await seed(
    a,
    "# Notas\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>",
    "Markdown doc",
    "markdown",
  );
  const reply = await read(`/artifact/${doc.id}`, {}, a);
  assert.equal(reply.status, 200);
  assert.equal(/allow-scripts/.test(reply.text), false, "rendered markdown needs no script");
  assert.equal(reply.text.includes("<iframe"), false, "the document is the page, not a nested frame");
  assert.equal(
    reply.text.match(/<script>/gi)?.length,
    1,
    "the page around the document ships only the freshness poller",
  );
  assert.ok(reply.text.includes("<h1>Notas</h1>"), "markdown headings are rendered");
  assert.ok(reply.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "raw HTML in the document is escaped");
  assert.ok(reply.text.includes("mdpage"), "the markdown viewer stylesheet");
  assert.ok(reply.text.includes('href="/"'), "the owner page carries the back link");
});

test(
  "the viewer delivers bytes only inside an escaped opaque-origin srcdoc wrapper",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const reply = await read(`/artifact/${hostile.id}`, {}, a);
    assert.deepEqual(
      [
        reply.status,
        reply.headers.get("content-type"),
        reply.headers.get("content-security-policy"),
        reply.headers.get("x-content-type-options"),
        reply.headers.get("cache-control"),
      ],
      [200, "text/html; charset=UTF-8", VIEWER_CSP, "nosniff", "no-store"],
    );
    assert.deepEqual(
      [
        reply.text.includes(`sandbox="allow-scripts"`),
        reply.text.includes("allow-same-origin"),
        reply.text.match(/<iframe /g)?.length,
      ],
      [true, false, 1],
      "one opaque-origin sandboxed frame",
    );
    assert.deepEqual(
      ["connect-src *", " ws:", " data:", "'unsafe-eval'", "frame-ancestors"].map((term) =>
        reply.headers.get("content-security-policy")?.includes(term),
      ),
      [false, false, false, false, false],
      "the page may poll its own origin and nothing else",
    );
    assert.ok(reply.text.includes("fetch(refresh.metaUrl"), "the poller reads the same-origin metadata route");
    const srcdoc = /srcdoc="([^"]*)"/.exec(reply.text)?.[1] ?? "";
    assert.deepEqual(
      [/<script/i.test(srcdoc), srcdoc.includes("&lt;script"), reply.text.includes("&lt;script")],
      [false, true, true],
      "artifact markup only reaches the wrapper escaped",
    );
    const decoded = srcdoc
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");
    assert.equal(decoded.startsWith(HOSTILE), true, "the stored bytes lead the frame");
    assert.equal(decoded.slice(HOSTILE.length).includes("data-artiflow-bridge"), true);
    assert.equal(/<(link|img)\b/.test(reply.text), false, "the wrapper loads no external asset");
  },
);

test("every library route is GET-only and mutates nothing", { skip: SKIP, timeout: 60_000 }, async () => {
  const count = async (): Promise<number> =>
    (await pool.query<{ count: number }>(`select count(*)::int as count from "artifacts"`)).rows[0]?.count ?? -1;
  const before = await count();
  for (const path of ["/api/artifacts", `/api/artifacts/${hostile.id}`, `/artifact/${hostile.id}`]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const reply = await read(
        path,
        { method, headers: { origin: publicOrigin, "content-type": "application/json" }, body: "{}" },
        a,
      );
      assert.deepEqual([reply.status, reply.json], [405, { error: "method_not_allowed" }], `${method} ${path}`);
    }
  }
  assert.equal(await count(), before, "reads and refusals changed no artifact row");
});

test(
  "sharing routes survive the real library catch-all, which still refuses unsupported methods",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const email =
      (await pool.query<{ email: string }>(`select "email" from "user" where "id" = $1`, [b.userId])).rows[0]?.email ??
      "";
    const mutation = { origin: publicOrigin, "content-type": "application/json" };
    const grant = await read(
      `/api/artifacts/${hostile.id}/shares`,
      { method: "POST", headers: mutation, body: JSON.stringify({ email: email.toUpperCase() }) },
      a,
    );
    assert.deepEqual(
      [grant.status, grant.json?.sharedWith],
      [201, { email }],
      "the real mount reaches sharing before the catch-all",
    );
    assert.deepEqual(
      [
        ((await read(`/api/artifacts/${hostile.id}/shares`, {}, a)).json?.shares as unknown[] | undefined)?.length,
        (await read(`/api/artifacts/${hostile.id}/shares`, {}, b)).status,
      ],
      [1, 404],
      "the owner lists one grant while the recipient has no management access",
    );
    const grantId = grant.json?.id as string;
    assert.deepEqual(
      [
        (await read(`/api/artifacts/${hostile.id}/shares`, { method: "PUT", headers: mutation, body: "{}" }, a)).json,
        (
          await read(
            `/api/artifacts/${hostile.id}/shares/${grantId}`,
            { method: "DELETE", headers: mutation, body: "{}" },
            a,
          )
        ).json,
      ],
      [{ error: "method_not_allowed" }, { ok: true }],
      "PUT falls through to the library 405 while DELETE reaches sharing",
    );
  },
);

const detailBaseline = async (artifactId: string): Promise<string> => {
  const row = (
    await pool.query<{
      title: string;
      kind: string;
      observedSizeBytes: number;
      createdAt: Date;
      updatedAt: Date;
      revisionId: string;
      revision: number;
      sizeBytes: number;
      sha256: string;
    }>(
      `select a."title", a."kind", a."observedSizeBytes", a."createdAt", a."updatedAt",
              r."id" as "revisionId", r."revision", r."sizeBytes", r."sha256"
         from "artifacts" a
         left join "artifactRevisions" r on r."id" = a."currentRevisionId"
        where a."id" = $1`,
      [artifactId],
    )
  ).rows[0];
  assert.ok(row, "the artifact row exists");
  return `{"id":${JSON.stringify(artifactId)},"title":${JSON.stringify(row.title)},"kind":${JSON.stringify(
    row.kind,
  )},"createdAt":${JSON.stringify(row.createdAt.toISOString())},"updatedAt":${JSON.stringify(
    row.updatedAt.toISOString(),
  )},"observedSizeBytes":${row.observedSizeBytes},"revision":{"id":${JSON.stringify(
    row.revisionId,
  )},"revisionNumber":${row.revision},"sha256":${JSON.stringify(row.sha256)},"sizeBytes":${row.sizeBytes}}}`;
};

test(
  "a current grant reads the identical metadata detail while strangers, revoked grants and deleted artifacts stay one 404",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const stranger = await seedOwner("Library Stranger C");
    const email =
      (await pool.query<{ email: string }>(`select "email" from "user" where "id" = $1`, [b.userId])).rows[0]?.email ??
      "";
    const mutation = { origin: publicOrigin, "content-type": "application/json" };
    const grant = async (artifactId: string): Promise<Reply> =>
      read(
        `/api/artifacts/${artifactId}/shares`,
        { method: "POST", headers: mutation, body: JSON.stringify({ email }) },
        a,
      );

    const owned = await read(`/api/artifacts/${hostile.id}`, {}, a);
    assert.deepEqual([owned.status, owned.text], [200, await detailBaseline(hostile.id)]);
    const missing = await read(`/api/artifacts/${randomUUID()}`, {}, a);
    assert.deepEqual([missing.status, missing.text], [404, `{"error":"not_found"}`]);
    const refused = missing.text;
    const strangerRead = await read(`/api/artifacts/${hostile.id}`, {}, stranger);
    assert.deepEqual([strangerRead.status, strangerRead.text], [404, refused], "no grant, no detail");

    assert.equal((await grant(hostile.id)).status, 201, "the grant is stored");
    const grantee = await read(`/api/artifacts/${hostile.id}`, {}, b);
    assert.deepEqual(
      [grantee.status, grantee.text],
      [200, owned.text],
      "the grantee's detail is byte-identical to the owner's",
    );

    const grantId = (
      await pool.query<{ id: string }>(
        `select "id" from "artifactShares" where "artifactId" = $1 and "sharedWithUserId" = $2`,
        [hostile.id, b.userId],
      )
    ).rows[0]?.id;
    assert.deepEqual(
      [
        (
          await read(
            `/api/artifacts/${hostile.id}/shares/${String(grantId)}`,
            { method: "DELETE", headers: mutation, body: "{}" },
            a,
          )
        ).json,
        (await read(`/api/artifacts/${hostile.id}`, {}, b)).text,
      ],
      [{ ok: true }, refused],
      "a revoked grant answers exactly like a missing artifact",
    );

    const granted = await seed(a, "<!doctype html><p>granted</p>", "Granted artifact");
    assert.equal((await grant(granted.id)).status, 201, "the second grant is stored");
    const live = await read(`/api/artifacts/${granted.id}`, {}, b);
    assert.deepEqual([live.status, live.text], [200, await detailBaseline(granted.id)], "the live grant reads");
    assert.equal((await markArtifactDeleted(database.db, granted.id, a.userId)).ok, true);
    const gone = await read(`/api/artifacts/${granted.id}`, {}, b);
    assert.deepEqual(
      [gone.status, gone.text, (await read(`/api/artifacts/${granted.id}`, {}, a)).text],
      [404, refused, refused],
      "a deleted artifact is gone for grantee and owner alike",
    );
  },
);
