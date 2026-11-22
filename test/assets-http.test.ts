import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";
import { assets } from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import { assetStorageKey } from "../apps/api/src/adapters/storage/s3.ts";
import { createAssetsApp, type AssetsOptions } from "../apps/api/src/routes/assets.ts";
import { hashLinkToken } from "../apps/api/src/routes/sharing.ts";

const ORIGIN = "http://127.0.0.1:5173";
const OWNER_ID = "user-owner";
const RECIPIENT_ID = "user-recipient";
const STRANGER_ID = "user-stranger";
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "t".repeat(43);

const png = (size = 128): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8), 3),
  ]);
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Statement = { sql: string; params: unknown[] };
type World = {
  artifacts: Record<string, { id: string; ownerId: string }>;
  shares: { artifactId: string; userId: string; role: string }[];
  links: { artifactId: string; tokenHash: string; revoked: boolean }[];
  assets: Map<string, { storageKey: string; contentType: string; sizeBytes: number }>;
  references: { artifactId: string; assetSha256: string }[];
  statements: Statement[];
  objects: Map<string, Uint8Array>;
  reads: number;
};

type Chain = Record<string, unknown> & {
  then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) => Promise<unknown>;
};

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
const dialect = new PgDialect();

function world(): World {
  return {
    artifacts: {
      [ARTIFACT_ID]: { id: ARTIFACT_ID, ownerId: OWNER_ID },
      [OTHER_ARTIFACT_ID]: { id: OTHER_ARTIFACT_ID, ownerId: OWNER_ID },
    },
    shares: [],
    links: [],
    assets: new Map(),
    references: [],
    statements: [],
    objects: new Map(),
    reads: 0,
  };
}

const allowed = (state: World, artifactId: string, identity: unknown[], link: boolean): boolean =>
  link
    ? state.links.some((row) => row.artifactId === artifactId && row.tokenHash === String(identity[0]) && !row.revoked)
    : state.artifacts[artifactId]?.ownerId === String(identity[0]) ||
      state.shares.some((row) => row.artifactId === artifactId && row.userId === String(identity[0]));

const rowsFor = (state: World, statement: Statement): unknown[] => {
  const artifactId = String(statement.params[0]);
  const sha256 = String(statement.params[1]);
  const identity = statement.params.slice(2);
  const stored = state.assets.get(sha256);
  if (!stored) return [];
  if (!state.references.some((row) => row.artifactId === artifactId && row.assetSha256 === sha256)) return [];
  if (!allowed(state, artifactId, identity, statement.sql.includes(`"artifactPublicLinks"`))) return [];
  return [stored];
};

function databaseOf(state: World): Database {
  const select = (): Chain => {
    let table: unknown = null;
    let rows: unknown[] = [];
    const query: Chain = {
      from: (next: unknown) => {
        table = next;
        return query;
      },
      leftJoin: () => query,
      innerJoin: () => query,
      orderBy: () => query,
      limit: () => query,
      where: (expression: unknown) => {
        assert.equal(table, assets, "the asset route reads from the assets table");
        const compiled = dialect.sqlToQuery(expression as SQL);
        const statement = { sql: compiled.sql, params: compiled.params };
        state.statements.push(statement);
        rows = rowsFor(state, statement);
        return query;
      },
      then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(ok, error),
    };
    return query;
  };
  return { db: { select } } as unknown as Database;
}

function storageOf(state: World): Storage {
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      state.reads += 1;
      const key = String(command.input.Key ?? "");
      const name = command.constructor.name;
      const stored = state.objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "GetObjectCommand") {
        if (!stored) throw providerError(404);
        return {
          Body: (async function* (): AsyncIterable<Uint8Array> {
            yield stored;
          })(),
        };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return {
    client: client as unknown as Storage["client"],
    bucket: "test-bucket",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  };
}

const sessionAuth = (userId: string | null) =>
  ({
    api: { getSession: async () => (userId === null ? null : { user: { id: userId } }) },
  }) as unknown as AssetsOptions["auth"];

const appOf = (state: World, userId: string | null): Hono => {
  const app = new Hono();
  app.route(
    "/",
    createAssetsApp({
      database: databaseOf(state),
      auth: sessionAuth(userId),
      storage: storageOf(state),
      publicOrigin: ORIGIN,
    }),
  );
  return app;
};

const delivered = (state: World, userId: string | null, path: string) => appOf(state, userId).request(path);

const seed = (state: World, bytes: Uint8Array, artifactId = ARTIFACT_ID): string => {
  const sha256 = digestOf(bytes);
  const storageKey = assetStorageKey(sha256);
  state.assets.set(sha256, { storageKey, contentType: "image/png", sizeBytes: bytes.length });
  state.references.push({ artifactId, assetSha256: sha256 });
  state.objects.set(storageKey, bytes);
  return sha256;
};

const assetPath = (sha256: string, artifactId = ARTIFACT_ID, query = ""): string =>
  `/artifact/${artifactId}/asset/${sha256}${query}`;

test("the owner receives the stored bytes with the immutable caching contract", async () => {
  const state = world();
  const bytes = png();
  const sha256 = seed(state, bytes);
  const response = await delivered(state, OWNER_ID, assetPath(sha256));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, "the bytes are identical");
  assert.deepEqual(
    [
      response.headers.get("content-type"),
      response.headers.get("cache-control"),
      response.headers.get("x-content-type-options"),
      response.headers.get("x-robots-tag"),
    ],
    ["image/png", "public, max-age=31536000, immutable", "nosniff", "noindex"],
  );
  const statement = state.statements[0];
  assert.equal(
    statement?.sql,
    `("artifactAssets"."artifactId" = $1 and "assets"."sha256" = $2 and ("artifacts"."deletedAt" is null and ("artifacts"."ownerId" = $3 or exists (select 1 from "artifactShares" where "artifactShares"."artifactId" = "artifacts"."id" and "artifactShares"."sharedWithUserId" = $4))))`,
    "delivery is bound to this artifact, this digest and the readable predicate",
  );
  assert.deepEqual(statement?.params, [ARTIFACT_ID, sha256, OWNER_ID, OWNER_ID]);
});

test("a recipient with a read grant receives the same bytes", async () => {
  const state = world();
  state.shares.push({ artifactId: ARTIFACT_ID, userId: RECIPIENT_ID, role: "reader" });
  const bytes = png(200);
  const sha256 = seed(state, bytes);
  const response = await delivered(state, RECIPIENT_ID, assetPath(sha256));
  assert.deepEqual([response.status, Buffer.from(await response.arrayBuffer()).length], [200, bytes.length]);
  assert.deepEqual(state.statements[0]?.params, [ARTIFACT_ID, sha256, RECIPIENT_ID, RECIPIENT_ID]);
});

test("a public link token holder receives the bytes, and a revoked link does not", async () => {
  const state = world();
  const bytes = png(64);
  const sha256 = seed(state, bytes);
  state.links.push({ artifactId: ARTIFACT_ID, tokenHash: hashLinkToken(TOKEN), revoked: false });
  const response = await delivered(state, null, assetPath(sha256, ARTIFACT_ID, `?token=${TOKEN}`));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, "no session is needed with a live token");
  assert.equal(
    state.statements[0]?.sql.includes(
      `exists (select 1 from "artifactPublicLinks" where "artifactPublicLinks"."artifactId" = "artifacts"."id" and "artifactPublicLinks"."tokenHash" = $3 and "artifactPublicLinks"."revokedAt" is null)`,
    ),
    true,
    "the token is matched against a live link for this artifact",
  );
  assert.deepEqual(state.statements[0]?.params, [ARTIFACT_ID, sha256, hashLinkToken(TOKEN)]);

  state.links[0]!.revoked = true;
  const revoked = await delivered(state, null, assetPath(sha256, ARTIFACT_ID, `?token=${TOKEN}`));
  assert.deepEqual([revoked.status, await revoked.json()], [404, { error: "not_found" }], "a revoked link is gone");
});

test("an anonymous caller with no token is refused, and a bad token is not a token", async () => {
  const state = world();
  const sha256 = seed(state, png());
  const anonymous = await delivered(state, null, assetPath(sha256));
  assert.deepEqual([anonymous.status, await anonymous.json()], [401, { error: "unauthorized" }]);
  const malformed = await delivered(state, null, assetPath(sha256, ARTIFACT_ID, "?token=short"));
  assert.deepEqual([malformed.status, await malformed.json()], [401, { error: "unauthorized" }]);
  assert.deepEqual(state.statements.length, 0, "no query runs for a caller with no identity at all");
});

test("a caller who may not read the artifact gets the same 404 as a missing asset", async () => {
  const state = world();
  const bytes = png();
  const sha256 = seed(state, bytes);
  const stranger = await delivered(state, STRANGER_ID, assetPath(sha256));
  const missing = await delivered(state, OWNER_ID, assetPath("f".repeat(64)));
  assert.deepEqual(
    [stranger.status, await stranger.json(), missing.status, await missing.json()],
    [404, { error: "not_found" }, 404, { error: "not_found" }],
  );
  assert.deepEqual(
    [stranger.headers.get("cache-control"), stranger.headers.get("x-content-type-options")],
    ["no-store", "nosniff"],
    "the refusal is not cacheable and not sniffable",
  );
  assert.equal(state.reads, 0, "no bytes are read for a refused caller");
});

test("an asset referenced by another artifact is not reachable through this one", async () => {
  const state = world();
  const bytes = png();
  const sha256 = seed(state, bytes, OTHER_ARTIFACT_ID);
  const probing = await delivered(state, OWNER_ID, assetPath(sha256, ARTIFACT_ID));
  assert.deepEqual(
    [probing.status, await probing.json()],
    [404, { error: "not_found" }],
    "an asset id is not a document id",
  );
  const reachable = await delivered(state, OWNER_ID, assetPath(sha256, OTHER_ARTIFACT_ID));
  assert.deepEqual([reachable.status, Buffer.from(await reachable.arrayBuffer()).length], [200, bytes.length]);
  assert.deepEqual(
    state.statements.map((statement) => statement.params[0]),
    [ARTIFACT_ID, OTHER_ARTIFACT_ID],
    "the reference is the artifact named in the path, never another one",
  );
});

test("a referenced row whose bytes are gone answers 404, never a broken 200", async () => {
  const state = world();
  const sha256 = seed(state, png());
  state.objects.delete(assetStorageKey(sha256));
  const response = await delivered(state, OWNER_ID, assetPath(sha256));
  assert.deepEqual([response.status, await response.json()], [404, { error: "not_found" }]);
});

test("a malformed artifact id or digest is a 404 before any query", async () => {
  const state = world();
  for (const path of [`/artifact/not-a-uuid/asset/${"a".repeat(64)}`, `/artifact/${ARTIFACT_ID}/asset/not-a-digest`]) {
    const response = await delivered(state, OWNER_ID, path);
    assert.deepEqual([path, response.status, await response.json()], [path, 404, { error: "not_found" }]);
  }
  assert.deepEqual(state.statements.length, 0);
});

const apiConfig = (): AppConfig => ({
  nodeEnv: "test",
  apiHost: "127.0.0.1",
  apiPort: 0,
  publicOrigin: ORIGIN,
  allowedHosts: [],
  internalOrigin: ORIGIN,
  demoAuth: false,
  authSecret: "x".repeat(32),
  authProviders: {},
  databaseUrl: "postgres://stub",
  storage: {
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "stub",
    accessKeyId: "stub",
    secretAccessKey: "stub",
    forcePathStyle: true,
  },
});

const apiDeps = (): ApiAppDeps => ({
  config: apiConfig(),
  database: { db: {}, check: async (): Promise<void> => undefined } as unknown as ApiAppDeps["database"],
  storage: {
    client: {},
    bucket: "stub",
    checkBucket: async (): Promise<void> => undefined,
    destroy: (): void => undefined,
  } as unknown as ApiAppDeps["storage"],
});

test("the mount reaches the asset routes before the library's method guard", async () => {
  const app = createApiApp(apiDeps());
  const upload = await app.fetch(
    new Request(`${ORIGIN}/api/artifacts/${ARTIFACT_ID}/assets`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "image/png", "content-length": "8" },
      body: "",
    }),
  );
  assert.deepEqual(
    [upload.status, await upload.json()],
    [403, { error: "origin_not_allowed" }],
    "the upload guard answers, not the library's 405",
  );
  const delivery = await app.fetch(new Request(`${ORIGIN}/artifact/${ARTIFACT_ID}/asset/${"a".repeat(64)}`));
  assert.deepEqual(
    [delivery.status, await delivery.json()],
    [401, { error: "unauthorized" }],
    "the asset route answers before the artifact wildcard",
  );
});
