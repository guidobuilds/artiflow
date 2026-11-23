import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

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
import { createShareViewerApp, createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { NOT_FOUND_PAGE, VIEWER_CSP } from "../apps/api/src/viewer/html.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
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
const publicOrigin = ENV_READY ? loadConfig(process.env).publicOrigin : "";
const HTML_A = `<!doctype html><html><body><h1>Share A</h1><script>document.title = "pwn"</script><p>quotes "a" 'b' &amp; more</p></body></html>`;
const HTML_B = `<!doctype html><p>second artifact body</p>`;
const MUTATION = { origin: publicOrigin, "content-type": "application/json" };

type Owner = { cookie: string; userId: string; email: string };
type Artifact = { id: string; revisionId: string };
type Reply = { status: number; text: string; json: Record<string, unknown> | null; headers: Headers };
type Link = { id: string; token: string };
let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "";
let a: Owner, b: Owner, artA: Artifact, artB: Artifact, linkA: Link;
const usedKeys: string[] = [];
let baselineKeys = new Set<string>();

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const revisionKeyOf = async (revisionId: string): Promise<string> => {
  const row = await pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions" where "id" = $1`, [
    revisionId,
  ]);
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
const srcdocOf = (html: string): string =>
  (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
const seedOwner = async (name: string): Promise<Owner> => {
  const owner = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name, email: `i5b3-${randomUUID()}@example.test` },
  );
  return { cookie: owner.cookie, email: owner.email, userId: owner.userId };
};
const seed = async (owner: Owner, html: string, title: string, kind?: "markdown"): Promise<Artifact> => {
  const bytes = Buffer.from(html, "utf8"),
    uploadId = `upload-${randomUUID()}`,
    sha256 = digestOf(bytes);
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
  assert.equal(
    await revisionKeyOf(committed.value.revisionId),
    committed.value.storageKey,
    "the committed key is the one persisted on the revision row",
  );
  usedKeys.push(committed.value.storageKey);
  return { id: committed.value.artifactId, revisionId: committed.value.revisionId };
};
const currentRevisionOf = async (artifactId: string) => {
  const row = await pool.query<{ revision: number; sha256: string; sizeBytes: number; kind: string }>(
    `select r."revision", r."sha256", r."sizeBytes", a."kind"
       from "artifacts" a join "artifactRevisions" r on r."id" = a."currentRevisionId"
      where a."id" = $1`,
    [artifactId],
  );
  assert.ok(row.rows[0], "the seeded artifact has a current revision row");
  return row.rows[0];
};
const createLink = async (owner: Owner, artifactId: string): Promise<Link> => {
  const created = await read(
    `/api/artifacts/${artifactId}/links`,
    { method: "POST", headers: MUTATION, body: "{}" },
    owner,
  );
  assert.deepEqual([created.status, typeof created.json?.token], [201, "string"]);
  return { id: created.json?.id as string, token: created.json?.token as string };
};
before(async () => {
  if (!ENV_READY) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  assert.equal(url.pathname, "/artiflow", "owned database name");
  admin = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  databaseName = `artiflow_share_test_${randomUUID().replaceAll("-", "")}`;
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
  baselineKeys = await revisionKeys();
  const config = loadConfig(process.env),
    auth = createAuth(config, database),
    app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createShareViewerApp({ database, storage }));
  app.route("/", createSharingApp({ database, auth, publicOrigin }));
  app.route("/", createLibraryApp({ database, auth, storage }));
  server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    started.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  a = await seedOwner("Share Owner A");
  b = await seedOwner("Share Owner B");
  artA = await seed(a, HTML_A, "Public linked artifact");
  artB = await seed(b, HTML_B, "Foreign public artifact");
  linkA = await createLink(a, artA.id);
});

after(async () => {
  if (!ENV_READY) return;
  const own = new Set([
    ...usedKeys,
    ...(await pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions"`)).rows.map(
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
  const leftObjects = [...(await revisionKeys())].filter((key) => !baselineKeys.has(key));
  assert.deepEqual(leftObjects, [], "this run left no revision object behind");
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  const leftover = await admin.query<{ count: number }>(
    "select count(*)::int as count from pg_database where datname like $1",
    ["artiflow_share_test_%"],
  );
  assert.equal(leftover.rows[0]?.count, 0, "no throwaway database remains");
  await admin.end();
});

test(
  "a valid token serves the escaped wrapper viewer with exact CSP, nosniff and no-store",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const reply = await read(`/share/${linkA.token}`);
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
      "the public page may poll its own origin and nothing else",
    );
    assert.ok(reply.text.includes("/share/" + linkA.token + "?meta=1"), "the poller reads the approved projection");
    assert.deepEqual(
      [reply.text.match(/<script>/g)?.length, reply.text.includes("&lt;script")],
      [2, true],
      "the wrapper ships its own inline scripts (theme bootstrap, focus toggle); the artifact's script reaches the page only escaped",
    );
    assert.ok(
      srcdocOf(reply.text).startsWith(HTML_A),
      "the escaped attribute carries the stored payload byte for byte",
    );
    assert.ok(srcdocOf(reply.text).includes("data-artiflow-bridge"), "the comment bridge rides along the payload");
    assert.equal(reply.headers.get("x-robots-tag"), "noindex", "an unlisted link is not indexable");
  },
);

test(
  "no cookie is needed, and a forged or foreign cookie changes nothing",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const anonymous = await read(`/share/${linkA.token}`);
    const forged = await read(`/share/${linkA.token}`, { headers: { cookie: "session_token=forged" } });
    const foreign = await read(`/share/${linkA.token}`, {}, b);
    assert.deepEqual(
      [
        anonymous.status,
        forged.status,
        foreign.status,
        forged.text === anonymous.text,
        foreign.text === anonymous.text,
      ],
      [200, 200, 200, true, true],
      "the token alone authorizes; a cookie is never consulted",
    );
  },
);
test(
  "the public and owner viewers differ only in the owner cells and their poll target, so the wrapper has one source",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const shared = await read(`/share/${linkA.token}`);
    const owner = await read(`/artifact/${artA.id}`, {}, a);
    assert.deepEqual(
      [owner.status, owner.headers.get("cache-control"), owner.headers.get("x-content-type-options")],
      [200, "no-store", "nosniff"],
    );
    const back = /<a class="vbar-cell vbar-back"[^>]*>.*?<\/a>\n/;
    assert.deepEqual(
      [owner.text.match(back)?.length ?? 0, shared.text.includes('class="vbar-cell vbar-back"')],
      [1, false],
      "exactly one back cell on the owner page and none on the public one",
    );
    const name = /<div class="vbar-cell vbar-title">.*?<\/div>\n/;
    const refreshLine = /const refresh = \{.*\};\n/;
    assert.match(owner.text, /const refresh = \{metaUrl:"\/api\/artifacts\//);
    assert.match(shared.text, /const refresh = \{metaUrl:"\/share\//);
    const island = /<script type="application\/json" id="viewer-comments-data">[^<]*<\/script>/;
    const bridgeData = /const PINS = .*;|const NONCE = .*;/g;
    const normalize = (html: string) =>
      html
        .replace(back, "")
        .replace(name, "")
        .replace(refreshLine, "const refresh = CONFIG;\n")
        .replace(island, "DATA")
        .replace(bridgeData, "BRIDGE_DATA");
    assert.equal(
      normalize(owner.text),
      normalize(shared.text),
      "identical body bytes once the owner cells and the per-view data are stripped",
    );
    assert.deepEqual(
      [shared.headers.get("content-security-policy"), shared.headers.get("cache-control")],
      [owner.headers.get("content-security-policy"), owner.headers.get("cache-control")],
    );
  },
);

test(
  "a public markdown link renders the document read-only, without owner chrome",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const doc = await seed(a, "# Notas\n\np\u00e1rrafo con **negrita**\n", "Public markdown", "markdown");
    const link = await createLink(a, doc.id);
    const reply = await read(`/share/${link.token}`);
    assert.equal(reply.status, 200);
    assert.equal(/<iframe/.test(reply.text), false, "the document renders in the page, not in a second frame");
    assert.equal(
      [...reply.text.matchAll(/<script\b/gi)].length,
      [...reply.text.matchAll(/<\/script\s*>/gi)].length,
      "every script the page opens is closed",
    );
    const island = /<script type="application\/json" id="viewer-comments-data">([^]*?)<\/script\s*>/i.exec(
      reply.text,
    )?.[1];
    assert.notEqual(island, undefined, "the margin mounts with an authorized data island");
    const shared = JSON.parse(island ?? "{}") as { threads?: unknown[]; canComment?: boolean };
    assert.deepEqual(shared.threads ?? [], [], "a link without the option carries no thread");
    assert.equal(shared.canComment ?? false, false, "the public reader never writes");
    assert.ok(/<h1>Notas<\/h1>/.test(reply.text), "the sanitized fragment is inline");
    assert.ok(/&lt;strong&gt;negrita|<strong>negrita|negrita/.test(reply.text), "emphasis survives rendering");
    assert.equal(reply.text.includes('href="/"'), false, "no owner back link on the public page");
    assert.equal(reply.headers.get("x-robots-tag"), "noindex");
  },
);

test("a revoked token stops delivering bytes while its row is retained", { skip: SKIP, timeout: 60_000 }, async () => {
  const link = await createLink(a, artA.id);
  assert.equal((await read(`/share/${link.token}`)).status, 200, "live first");
  assert.equal(
    (await read(`/api/artifacts/${artA.id}/links/${link.id}`, { method: "DELETE", headers: MUTATION, body: "{}" }, a))
      .status,
    200,
  );
  const reply = await read(`/share/${link.token}`);
  assert.deepEqual([reply.status, reply.text], [404, NOT_FOUND_PAGE]);
  const row = await pool.query<{ revokedAt: Date | null }>(
    `select "revokedAt" from "artifactPublicLinks" where "id" = $1`,
    [link.id],
  );
  assert.equal(row.rows[0]?.revokedAt instanceof Date, true, "revocation is a timestamp, not a delete");
});
test(
  "rotation invalidates the old token in place and the new token serves the viewer",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const original = await createLink(a, artA.id);
    const rotated = await read(
      `/api/artifacts/${artA.id}/links/${original.id}/rotate`,
      { method: "POST", headers: MUTATION, body: "{}" },
      a,
    );
    assert.equal(rotated.status, 201);
    const oldToken = await read(`/share/${original.token}`);
    const newToken = await read(`/share/${rotated.json?.token as string}`);
    assert.deepEqual(
      [oldToken.status, oldToken.text, newToken.status, srcdocOf(newToken.text).startsWith(HTML_A)],
      [404, NOT_FOUND_PAGE, 200, true],
      "the predecessor is dead, the successor renders",
    );
  },
);

test(
  "a soft-deleted artifact's live link token is 404 on the public path",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const doomed = await seed(a, HTML_B, "Doomed public artifact");
    const link = await createLink(a, doomed.id);
    assert.equal((await read(`/share/${link.token}`)).status, 200, "readable while the artifact is live");
    assert.equal((await markArtifactDeleted(database.db, doomed.id, a.userId)).ok, true);
    const row = await pool.query<{ revokedAt: Date | null }>(
      `select "revokedAt" from "artifactPublicLinks" where "id" = $1`,
      [link.id],
    );
    const reply = await read(`/share/${link.token}`);
    assert.deepEqual(
      [row.rows.length, row.rows[0]?.revokedAt, reply.status, reply.text],
      [1, null, 404, NOT_FOUND_PAGE],
      "the link row is still live, yet the deleted artifact delivers nothing",
    );
  },
);
test(
  "unknown and malformed tokens answer not_found without a server error",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const probes = [
      randomBytes(32).toString("base64url"),
      "short",
      "x".repeat(44),
      `${randomBytes(32).toString("base64url")}!`,
      "a".repeat(42),
    ];
    const replies = await Promise.all(probes.map((token) => read(`/share/${token}`)));
    assert.deepEqual(
      replies.map((reply) => [reply.status, reply.text]),
      Array.from({ length: probes.length }, () => [404, NOT_FOUND_PAGE]),
      "unknown, wrong-length and wrong-charset tokens are one refusal",
    );
  },
);

test(
  "?meta=1 serves exactly the four-field projection and never the viewer",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const reply = await read(`/share/${linkA.token}?meta=1`);
    const revision = await currentRevisionOf(artA.id);
    assert.deepEqual(
      [reply.status, reply.headers.get("content-type")],
      [200, "application/json"],
      "metadata answers JSON, not the wrapper",
    );
    assert.deepEqual(
      Object.keys(reply.json ?? {}).sort(),
      ["kind", "revisionNumber", "sha256", "sizeBytes"],
      "exactly four keys: no artifactId, revisionId or title in the public projection",
    );
    assert.deepEqual(
      reply.json,
      {
        revisionNumber: revision.revision,
        sha256: revision.sha256,
        sizeBytes: revision.sizeBytes,
        kind: revision.kind,
      },
      "the row's own numbers, and the seeded digest and byte length",
    );
    assert.deepEqual(
      [
        reply.headers.get("cache-control"),
        reply.headers.get("x-content-type-options"),
        reply.headers.get("x-robots-tag"),
      ],
      ["no-store", "nosniff", "noindex"],
    );
    assert.deepEqual(
      [reply.text.includes("<iframe"), reply.text.includes(linkA.token), reply.text.includes(artA.id)],
      [false, false, false],
      "no viewer markup, no token and no internal id in the metadata answer",
    );
  },
);

test("?meta=1 on a revoked token is the same 404 as bytes mode", { skip: SKIP, timeout: 60_000 }, async () => {
  const link = await createLink(a, artA.id);
  const live = await read(`/share/${link.token}?meta=1`);
  assert.deepEqual(
    [live.status, live.headers.get("content-type")],
    [200, "application/json"],
    "metadata while the link is live",
  );
  assert.equal(
    (await read(`/api/artifacts/${artA.id}/links/${link.id}`, { method: "DELETE", headers: MUTATION, body: "{}" }, a))
      .status,
    200,
  );
  const meta = await read(`/share/${link.token}?meta=1`);
  const bytes = await read(`/share/${link.token}`);
  const refused = bytes.text;
  assert.deepEqual([bytes.status, refused], [404, NOT_FOUND_PAGE], "the byte path is refused first");
  assert.deepEqual(
    [meta.status, meta.text],
    [404, refused],
    "revocation is re-checked on every read, metadata included",
  );
});

test("?meta=1 on a soft-deleted artifact's live link is the same 404", { skip: SKIP, timeout: 60_000 }, async () => {
  const doomed = await seed(a, HTML_B, "Doomed public metadata artifact");
  const link = await createLink(a, doomed.id);
  const live = await read(`/share/${link.token}?meta=1`);
  assert.deepEqual(
    [live.status, live.headers.get("content-type")],
    [200, "application/json"],
    "metadata while the artifact is live",
  );
  assert.equal((await markArtifactDeleted(database.db, doomed.id, a.userId)).ok, true);
  const meta = await read(`/share/${link.token}?meta=1`);
  const bytes = await read(`/share/${link.token}`);
  assert.deepEqual([meta.status, meta.text, bytes.status, bytes.text], [404, NOT_FOUND_PAGE, 404, NOT_FOUND_PAGE]);
});

test(
  "?meta=1 never turns a malformed or unknown token into a metadata answer",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const probes = [
      randomBytes(32).toString("base64url"),
      "short",
      "x".repeat(44),
      `${randomBytes(32).toString("base64url")}!`,
      "a".repeat(42),
    ];
    const replies = await Promise.all(probes.map((token) => read(`/share/${token}?meta=1`)));
    assert.deepEqual(
      replies.map((reply) => [reply.status, reply.text, reply.json]),
      probes.map(() => [404, NOT_FOUND_PAGE, null]),
      "one refusal for unknown, wrong-length and wrong-charset tokens, with no JSON body",
    );
  },
);

test(
  "every meta variant other than exactly meta=1 is refused, never the byte viewer",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const variants = [
      "?meta",
      "?meta=0",
      "?meta=true",
      "?meta=2",
      "?meta=",
      "?meta=01",
      "?meta=1&meta=0",
      "?meta=1&meta=1",
    ];
    const replies = await Promise.all(variants.map((query) => read(`/share/${linkA.token}${query}`)));
    assert.deepEqual(
      replies.map((reply) => [reply.status, reply.text, reply.json]),
      variants.map(() => [404, NOT_FOUND_PAGE, null]),
      "a bare key, a non-exact value or a duplicate meta is the route's existing refusal, not bytes and not metadata",
    );
  },
);

test(
  "?meta=1 answers from the row alone: the blob can be gone and metadata still resolves",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const gone = await seed(a, HTML_A, "Metadata-only artifact");
    const link = await createLink(a, gone.id);
    const storageKey = await revisionKeyOf(gone.revisionId);
    await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: storageKey }));
    const removed = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: storageKey })).then(
      () => false,
      () => true,
    );
    assert.equal(removed, true, "the revision's own object is gone before either read");
    const revision = await currentRevisionOf(gone.id);
    const meta = await read(`/share/${link.token}?meta=1`);
    assert.deepEqual(
      [meta.status, meta.headers.get("content-type")],
      [200, "application/json"],
      "metadata never calls getRevisionBytes, so a missing blob cannot refuse it",
    );
    assert.deepEqual(
      meta.json,
      {
        revisionNumber: revision.revision,
        sha256: revision.sha256,
        sizeBytes: revision.sizeBytes,
        kind: revision.kind,
      },
      "the four keys still come from the revision row",
    );
    const bytes = await read(`/share/${link.token}`);
    assert.deepEqual(
      [bytes.status, bytes.text],
      [404, NOT_FOUND_PAGE],
      "the byte path re-reads, finds no blob and is refused",
    );
  },
);

test(
  "PRESERVE: without a meta query the viewer is served byte-exactly as before",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const reply = await read(`/share/${linkA.token}`);
    assert.deepEqual(
      [reply.status, reply.headers.get("content-type"), reply.headers.get("cache-control"), reply.json],
      [200, "text/html; charset=UTF-8", "no-store", null],
    );
    assert.deepEqual(
      [srcdocOf(reply.text).startsWith(HTML_A), reply.text.match(/<iframe /g)?.length],
      [true, 1],
      "the untouched viewer path still delivers the stored payload in one sandboxed frame",
    );
  },
);

test(
  "a token keeps working beside registered shares and never crosses to another artifact",
  { skip: SKIP, timeout: 60_000 },
  async () => {
    const grant = await read(
      `/api/artifacts/${artA.id}/shares`,
      { method: "POST", headers: MUTATION, body: JSON.stringify({ email: b.email }) },
      a,
    );
    const linkB = await createLink(b, artB.id);
    const sharedA = await read(`/share/${linkA.token}`);
    const publicB = await read(`/share/${linkB.token}`);
    assert.deepEqual(
      [grant.status, sharedA.status],
      [201, 200],
      "a share grant on the same artifact does not disturb its public token",
    );
    assert.deepEqual(
      [
        srcdocOf(sharedA.text).startsWith(HTML_A),
        sharedA.text.includes("second artifact body"),
        srcdocOf(publicB.text).startsWith(HTML_B),
        publicB.text.includes("Share A"),
      ],
      [true, false, true, false],
      "each token renders only its own artifact",
    );
  },
);
