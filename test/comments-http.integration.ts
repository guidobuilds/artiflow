import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import { escapeIdentifier, Pool } from "pg";
import { commitUpload } from "../apps/api/src/domain/commit-flow.ts";
import { createUpload, putChunk } from "../apps/api/src/domain/staging.ts";
import { createAuth, createAuthApp } from "../apps/api/src/auth.ts";
import { createCommentsApp } from "../apps/api/src/routes/comments.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { createDatabase, type Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { createEditingApp } from "../apps/api/src/routes/editing.ts";
import { createShareViewerApp, createSharingApp } from "../apps/api/src/routes/sharing.ts";
import { createStorage, type Storage } from "../apps/api/src/adapters/storage/client.ts";
import { trustedSession } from "./helpers/trusted-accounts.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ENV_READY =
  Boolean(DATABASE_URL) &&
  ["ARTIFLOW_S3_ENDPOINT", "ARTIFLOW_S3_BUCKET", "ARTIFLOW_S3_ACCESS_KEY_ID", "ARTIFLOW_S3_SECRET_ACCESS_KEY"].every(
    (name) => process.env[name],
  );
const config = ENV_READY ? loadConfig(process.env) : undefined;
const publicOrigin = config?.publicOrigin ?? "";
const SKIP = ENV_READY ? false : "DATABASE_URL or S3 missing";
const MUTATION = { "content-type": "application/json", origin: publicOrigin };
type User = { cookie: string; userId: string; email: string };
type Comment = {
  id: string;
  body: string;
  anchor: { kind: string; quotedText?: string } | null;
  authorId: string;
  author: { id: string; name: string; image: string | null };
  resolvedAt: string | null;
  replies: Comment[];
  canDelete: boolean;
};
let admin: Pool, pool: Pool, storage: Storage, server: ReturnType<typeof serve>;
let database: Database;
let baseUrl = "",
  databaseName = "",
  doc = "",
  html = "",
  other = "";
let owner: User, reader: User, editor: User, commenter: User, stranger: User;
const usedKeys = new Set<string>();
const request = async (path: string, user?: User, method = "GET", body?: unknown, headers = MUTATION) => {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...headers, ...(user ? { cookie: user.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      error?: string;
      id?: string;
      comments?: Comment[];
      links?: { id: string; showComments?: boolean }[];
      revisionId?: string;
      revisionNumber?: number;
      sha256?: string;
      canComment?: boolean;
    },
  };
};
const revisionKeyOf = async (revisionId: string): Promise<string> => {
  const row = await pool.query<{ storageKey: string }>(`select "storageKey" from "artifactRevisions" where "id" = $1`, [
    revisionId,
  ]);
  const storageKey = row.rows[0]?.storageKey;
  assert.ok(typeof storageKey === "string", "the revision row names its own storage key");
  return storageKey;
};
const seedUser = async (label: string): Promise<User> => {
  const user = await trustedSession(
    { database, baseUrl, origin: publicOrigin },
    { name: label, email: `comments-${label}-${randomUUID()}@example.test` },
  );
  return { cookie: user.cookie, userId: user.userId, email: user.email };
};
const seed = async (text: string, kind?: "markdown") => {
  const bytes = Buffer.from(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploadId = randomUUID();
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
  const result = await commitUpload({
    database,
    storage,
    ownerId: owner.userId,
    uploadId,
    bytes,
    title: "Comments test",
    kind,
  });
  assert.ok(result.ok);
  usedKeys.add(result.value.storageKey);
  return result.value.artifactId;
};
const path = () => `/api/artifacts/${doc}/comments`;
const anchor = { kind: "text-range", startLine: 1, startCol: 3, endLine: 1, endCol: 8, quotedText: "Hello" };
const payload = { anchor, body: "A comment" };
const list = async () => (await request(path(), owner)).json;
const create = async (user: User, body: unknown = payload) => {
  const result = await request(path(), user, "POST", body);
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.ok(result.json.id);
  return result.json.id!;
};
before(async () => {
  if (!config) return;
  const url = new URL(DATABASE_URL);
  assert.equal(
    ["127.0.0.1", "localhost"].includes(url.hostname) || process.env.ARTIFLOW_TEST_DB === "1",
    true,
    "test database must be loopback or ARTIFLOW_TEST_DB=1",
  );
  admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  databaseName = `artiflow_comments_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query("CREATE DATABASE " + escapeIdentifier(databaseName));
  const testUrl = new URL(`/${databaseName}`, DATABASE_URL);
  const migratePool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  await migrate(drizzle(migratePool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await migratePool.end();
  database = createDatabase(testUrl.toString());
  pool = database.pool;
  storage = createStorage({
    endpoint: new URL(process.env.ARTIFLOW_S3_ENDPOINT ?? "").origin,
    region: process.env.ARTIFLOW_S3_REGION ?? "us-east-1",
    bucket: process.env.ARTIFLOW_S3_BUCKET ?? "",
    accessKeyId: process.env.ARTIFLOW_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.ARTIFLOW_S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  const auth = createAuth(config, database);
  const app = new Hono();
  app.route("/", createAuthApp(auth, config));
  app.route("/", createCommentsApp({ database, auth, storage, publicOrigin }));
  app.route("/", createEditingApp({ database, auth, storage, publicOrigin }));
  app.route("/", createSharingApp({ database, auth, publicOrigin }));
  app.route("/", createShareViewerApp({ database, storage }));
  server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  owner = await seedUser("owner");
  reader = await seedUser("reader");
  editor = await seedUser("editor");
  commenter = await seedUser("commenter");
  stranger = await seedUser("stranger");
  doc = await seed("# Hello\n\n| a | b |\n| c | d |\n", "markdown");
  other = await seed("# Other\n", "markdown");
  html = await seed("<p>Comments html test</p>");
  for (const [user, role] of [
    [reader, "reader"],
    [editor, "editor"],
    [commenter, "commenter"],
  ] as const) {
    assert.equal((await request(`/api/artifacts/${doc}/shares`, owner, "POST", { email: user.email })).status, 201);
    await pool.query(`update "artifactShares" set role = $1 where "artifactId" = $2 and "sharedWithUserId" = $3`, [
      role,
      doc,
      user.userId,
    ]);
  }
});
after(async () => {
  if (!ENV_READY) return;
  for (const key of usedKeys) await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  storage.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
  await admin.query("DROP DATABASE IF EXISTS " + escapeIdentifier(databaseName));
  await admin.end();
});

test(
  "permissions: owner/editor/commenter create and resolve; readers only read; strangers hidden",
  { skip: SKIP },
  async () => {
    for (const user of [owner, editor, commenter]) {
      const id = await create(user);
      assert.equal((await request(`${path()}/${id}/resolve`, user, "POST", {})).status, 200);
      assert.ok((await list()).comments!.find((row) => row.id === id)!.resolvedAt);
      assert.equal((await request(`${path()}/${id}/unresolve`, user, "POST", {})).status, 200);
      assert.equal((await list()).comments!.find((row) => row.id === id)!.resolvedAt, null);
    }
    for (const [user, status] of [
      [reader, 403],
      [stranger, 404],
      [undefined, 401],
    ] as const) {
      const before = await list();
      assert.equal((await request(path(), user, "POST", payload)).status, status);
      assert.equal((await request(`${path()}/${before.comments![0]!.id}/resolve`, user, "POST", {})).status, status);
      assert.deepEqual(await list(), before);
    }
    assert.equal((await request(path(), reader)).status, 200);
    assert.equal((await request(path(), reader)).json.canComment, false);
    assert.ok((await list()).comments!.length > 0, "a reader still sees the threads");
    assert.equal((await request(path(), stranger)).status, 404);
    assert.equal((await request(path())).status, 401);
    assert.deepEqual(await request(`/api/artifacts/${html}/comments`, owner, "POST", payload), {
      status: 400,
      json: { error: "unsupported_anchor_kind" },
    });
    const htmlAnchor = { kind: "page-point", x: 0.5, y: 240, viewportWidth: 900 };
    const htmlComment = await request(`/api/artifacts/${html}/comments`, owner, "POST", {
      anchor: htmlAnchor,
      body: "HTML note",
    });
    assert.equal(htmlComment.status, 201, JSON.stringify(htmlComment));
    const htmlThreads = await request(`/api/artifacts/${html}/comments`, owner);
    assert.equal(htmlThreads.status, 200);
    assert.deepEqual(htmlThreads.json.comments![0]!.anchor, htmlAnchor);
    const elementAnchor = {
      kind: "element",
      selector: "p:nth-of-type(1)",
      point: { x: 0.4, y: 0.6 },
      textHint: "Comments html test",
      viewportWidth: 900,
    };
    assert.equal(
      (await request(`/api/artifacts/${html}/comments`, owner, "POST", { anchor: elementAnchor, body: "Element note" }))
        .status,
      201,
    );
  },
);

test("authors are entities: id, name and image are returned and no email leaks", { skip: SKIP }, async () => {
  const threads = await list();
  assert.ok(threads.comments!.length > 0);
  for (const thread of threads.comments!) {
    assert.deepEqual(Object.keys(thread.author).sort(), ["id", "image", "name"]);
    assert.equal(thread.author.id, thread.authorId);
    assert.equal(typeof thread.author.name, "string");
    assert.ok(!("email" in thread.author));
    for (const reply of thread.replies) {
      assert.deepEqual(Object.keys(reply.author).sort(), ["id", "image", "name"]);
      assert.ok(!("email" in reply.author));
    }
  }
  assert.equal(JSON.stringify(threads).includes("@example.test"), false, "no participant email is exposed");
});

test("a public link exposes read-only comments only when the owner enabled the option", { skip: SKIP }, async () => {
  const created = await request(`/api/artifacts/${doc}/links`, owner, "POST", {});
  assert.equal(created.status, 201);
  const link = created.json as unknown as { id: string; token: string; showComments: boolean };
  assert.equal(link.showComments, false, "the link option is off by default");
  assert.equal((await request(`/share/${link.token}/comments`)).status, 404);
  const enabled = await request(`/api/artifacts/${doc}/links/${link.id}`, owner, "PATCH", { showComments: true });
  assert.equal(enabled.status, 200);
  const listed = await request(`/api/artifacts/${doc}/links`, owner);
  assert.equal(listed.json.links!.find((row) => row.id === link.id)!.showComments, true);
  const shared = await request(`/share/${link.token}/comments`);
  assert.equal(shared.status, 200);
  assert.ok(shared.json.comments!.length > 0);
  for (const thread of shared.json.comments!) {
    assert.equal(thread.canDelete, false, "the public link never grants deletion");
    assert.ok(!("email" in thread.author));
  }
  assert.equal(JSON.stringify(shared.json).includes("@example.test"), false);
  const rejected = await request(`/api/artifacts/${doc}/links/${link.id}`, reader, "PATCH", { showComments: false });
  assert.equal(rejected.status, 404, "only the owner may change the link option");
  const disabled = await request(`/api/artifacts/${doc}/links/${link.id}`, owner, "PATCH", { showComments: false });
  assert.equal(disabled.status, 200);
  assert.equal((await request(`/share/${link.token}/comments`)).status, 404);
  assert.equal((await request(`/api/artifacts/${doc}/links/${link.id}`, owner, "PATCH", {})).status, 400);
});

test(
  "anchor validation, caps, guards and malformed ids reject without changing threads or document revision",
  { skip: SKIP },
  async () => {
    const before = await list();
    const document = await request(`/api/artifacts/${doc}/document`, owner);
    for (const [body, status, error] of [
      [{ ...payload, anchor: { ...anchor, quotedText: "Wrong" } }, 400, "anchor_mismatch"],
      [{ ...payload, anchor: { ...anchor, endCol: 999 } }, 400, "invalid_anchor"],
      [{ ...payload, anchor: { ...anchor, startLine: 99, endLine: 99 } }, 400, "invalid_anchor"],
      [{ ...payload, anchor: { ...anchor, startCol: 1.5 } }, 400, "invalid_anchor"],
      [
        {
          ...payload,
          anchor: {
            kind: "element",
            selector: "p",
            point: { x: 0.5, y: 0.5 },
            textHint: "",
            viewportWidth: 800,
          },
        },
        400,
        "unsupported_anchor_kind",
      ],
      [
        { ...payload, anchor: { kind: "page-point", x: 0.5, y: 10, viewportWidth: 800 } },
        400,
        "unsupported_anchor_kind",
      ],
      [{ body: "No anchor" }, 400, "root_requires_anchor"],
      [
        { ...payload, parentId: "11111111-1111-4111-8111-111111111111", body: "Reply with anchor" },
        400,
        "reply_has_no_anchor",
      ],
      [{ ...payload, body: " " }, 400, "body_required"],
      [{ ...payload, body: "x".repeat(4001) }, 413, "too_large"],
      [{ ...payload, anchor: { ...anchor, quotedText: "x".repeat(2001) } }, 413, "too_large"],
      [{ parentId: randomUUID(), body: "x" }, 404, "comment_not_found"],
      [{ parentId: "bad", body: "x" }, 404, "comment_not_found"],
    ] as const) {
      assert.deepEqual(await request(path(), owner, "POST", body), { status, json: { error } });
      assert.deepEqual(await list(), before);
      assert.deepEqual(await request(`/api/artifacts/${doc}/document`, owner), document);
    }
    assert.equal(
      (await request(path(), owner, "POST", payload, { ...MUTATION, origin: "https://evil.test" })).status,
      403,
    );
    assert.equal(
      (await request(path(), owner, "POST", payload, { ...MUTATION, "content-type": "text/plain" })).status,
      415,
    );
    assert.equal((await request("/api/artifacts/bad/comments", owner)).status, 404);
    assert.equal((await request(`${path()}/bad/resolve`, owner, "POST", {})).status, 404);
    assert.deepEqual(await list(), before);
    await create(owner, {
      anchor: { kind: "text-range", startLine: 3, startCol: 1, endLine: 4, endCol: 1, quotedText: "| a | b |\n" },
      body: "x".repeat(4000),
    });
  },
);

test(
  "threads: replies ordered, nesting refused, resolve roots only, author/owner deletion cascades",
  { skip: SKIP },
  async () => {
    const id = await create(commenter);
    const reply = await create(editor, { parentId: id, body: "First reply" });
    const second = await create(owner, { parentId: id, body: "Second reply" });
    const before = await list();
    assert.deepEqual(
      before.comments!.find((row) => row.id === id)!.replies.map((row) => row.id),
      [reply, second],
    );
    assert.equal((await request(path(), editor, "POST", { parentId: reply, body: "Nested" })).status, 400);
    assert.equal((await request(`${path()}/${reply}/resolve`, owner, "POST", {})).status, 400);
    assert.equal((await request(`${path()}/${id}`, editor, "DELETE", {})).status, 403);
    assert.equal(
      (
        await request(`/api/artifacts/${other}/comments`, owner, "POST", {
          parentId: id,
          body: "Other",
        })
      ).status,
      404,
    );
    assert.deepEqual(await list(), before);
    assert.equal((await request(`${path()}/${reply}`, editor, "DELETE", {})).status, 200);
    assert.deepEqual(
      (await list()).comments!.find((row) => row.id === id)!.replies.map((row) => row.id),
      [second],
    );
    assert.equal((await request(`${path()}/${id}`, commenter, "DELETE", {})).status, 200);
    assert.ok(!(await list()).comments!.some((row) => row.id === id));
    assert.equal((await request(`${path()}/${second}/resolve`, owner, "POST", {})).status, 404);
    const owned = await create(editor);
    assert.equal((await request(`${path()}/${owned}`, owner, "DELETE", {})).status, 200);
  },
);

test(
  "commenting never changes revisions; changed source leaves original anchors and quotes visible",
  { skip: SKIP },
  async () => {
    const documentPath = `/api/artifacts/${doc}/document`;
    const current = await request(documentPath, owner);
    const id = await create(owner);
    assert.deepEqual(await request(documentPath, owner), current);
    const save = await request(documentPath, editor, "PUT", {
      text: "# Changed\n",
      expectedRevisionId: current.json.revisionId,
    });
    assert.equal(save.status, 200);
    usedKeys.add(await revisionKeyOf(String(save.json.revisionId)));
    const root = (await list()).comments!.find((row) => row.id === id)!;
    assert.equal(root.anchor!.kind, "text-range");
    assert.equal(root.anchor!.quotedText, "Hello");
    assert.equal(root.body, payload.body);
  },
);
