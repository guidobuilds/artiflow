import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";

import {
  MAX_ASSET_BYTES,
  artifactAssets,
  artifacts,
  assets,
} from "../apps/api/src/adapters/postgres/db/artifact-schema.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import { createAssetsApp, type AssetsOptions } from "../apps/api/src/routes/assets.ts";

const ORIGIN = "http://127.0.0.1:5173";
const OWNER_ID = "user-owner";
const READER_ID = "user-reader";
const STRANGER_ID = "user-stranger";
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const png = (size = 96): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8), 7),
  ]);

type Insert = { table: unknown; values: Record<string, unknown> };
type Statement = { sql: string; params: unknown[] };
type World = {
  artifacts: Record<string, { id: string; ownerId: string }>;
  shares: { artifactId: string; userId: string; role: string }[];
  assets: Map<string, { sha256: string; sizeBytes: number; contentType: string; storageKey: string }>;
  references: { artifactId: string; assetSha256: string }[];
  inserts: Insert[];
  statements: Statement[];
  puts: { key: string; contentType: string }[];
  objects: Map<string, Uint8Array>;
};

type Chain = Record<string, unknown> & {
  then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) => Promise<unknown>;
};

const providerError = (status: number): Error =>
  Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });

const dialect = new PgDialect();

function world(overrides: Partial<World> = {}): World {
  return {
    artifacts: {
      [ARTIFACT_ID]: { id: ARTIFACT_ID, ownerId: OWNER_ID },
      [OTHER_ARTIFACT_ID]: { id: OTHER_ARTIFACT_ID, ownerId: OWNER_ID },
    },
    shares: [],
    assets: new Map(),
    references: [],
    inserts: [],
    statements: [],
    puts: [],
    objects: new Map(),
    ...overrides,
  };
}

function storageOf(state: World): Storage {
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const key = String(command.input.Key ?? "");
      const name = command.constructor.name;
      if (name === "PutObjectCommand") {
        const body = Buffer.from(command.input.Body as Uint8Array);
        state.objects.set(key, body);
        state.puts.push({ key, contentType: String(command.input.ContentType) });
        return {};
      }
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

const accessRows = (state: World, params: unknown[]): unknown[] => {
  const artifactId = String(params[0]);
  const userId = String(params[1]);
  const artifact = state.artifacts[artifactId];
  const share = state.shares.find((row) => row.artifactId === artifactId && row.userId === userId);
  if (!artifact || (artifact.ownerId !== userId && share === undefined)) return [];
  return [{ id: artifact.id, access: artifact.ownerId === userId ? "owner" : share?.role }];
};

const assetRows = (state: World, params: unknown[]): unknown[] => {
  const row = state.assets.get(String(params[0]));
  return row ? [{ sha256: row.sha256, sizeBytes: row.sizeBytes, contentType: row.contentType }] : [];
};

function databaseOf(state: World): Database {
  const select = (): Chain => {
    let table: unknown = null;
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
        const compiled = dialect.sqlToQuery(expression as SQL);
        state.statements.push({ sql: compiled.sql, params: compiled.params });
        rows = table === artifacts ? accessRows(state, compiled.params) : assetRows(state, compiled.params);
        return query;
      },
      then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(ok, error),
    };
    let rows: unknown[] = [];
    return query;
  };
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>): Chain => {
      const record: Insert = { table, values };
      const chain: Chain = {
        onConflictDoNothing: () => chain,
        returning: () => chain,
        then: (ok?: (value: unknown) => unknown, error?: (reason: unknown) => unknown) => {
          state.inserts.push(record);
          const stored = table === assets ? [values] : [{}];
          if (table === assets)
            state.assets.set(String(values.sha256), {
              sha256: String(values.sha256),
              sizeBytes: Number(values.sizeBytes),
              contentType: String(values.contentType),
              storageKey: String(values.storageKey),
            });
          if (table === artifactAssets) {
            const reference = {
              artifactId: String(values.artifactId),
              assetSha256: String(values.assetSha256),
            };
            const known = state.references.some(
              (row) => row.artifactId === reference.artifactId && row.assetSha256 === reference.assetSha256,
            );
            if (known) return Promise.resolve([]).then(ok, error);
            state.references.push(reference);
          }
          return Promise.resolve(stored).then(ok, error);
        },
      };
      return chain;
    },
  });
  return { db: { select, insert } } as unknown as Database;
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

const upload = (
  state: World,
  input: {
    artifactId?: string;
    origin?: string;
    contentType?: string;
    declaredLength?: string | null;
    body?: Uint8Array;
    userId?: string | null;
  } = {},
) => {
  const headers: Record<string, string> = {
    origin: input.origin ?? ORIGIN,
    "content-type": input.contentType ?? "image/png",
  };
  const declared = input.declaredLength === undefined ? String((input.body ?? png()).length) : input.declaredLength;
  if (declared !== null) headers["content-length"] = declared;
  return appOf(state, input.userId === undefined ? OWNER_ID : input.userId).request(
    `/api/artifacts/${input.artifactId ?? ARTIFACT_ID}/assets`,
    { method: "POST", headers, body: input.body ?? png() },
  );
};

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const wrote = (state: World): [number, number] => [state.puts.length, state.inserts.length];

test("the same bytes twice store one object and answer one asset id", async () => {
  const state = world();
  const bytes = png();
  const sha256 = digestOf(bytes);
  const first = await upload(state, { body: bytes });
  const second = await upload(state, { body: bytes, declaredLength: String(bytes.length) });
  const body = { id: sha256, sizeBytes: bytes.length, contentType: "image/png" };
  assert.deepEqual([first.status, await json(first)], [201, body], "the first upload answers the content address");
  assert.deepEqual([second.status, await json(second)], [201, body], "the second upload answers the same id");
  assert.deepEqual(
    [state.puts.length, state.assets.size, state.references.length, state.objects.size],
    [1, 1, 1, 1],
    "one object, one row and one reference",
  );
  assert.equal(state.puts[0]?.key, `assets/${sha256}`, "the object is stored under its own digest");
  assert.equal(state.puts[0]?.contentType, "image/png", "the stored object keeps the declared type");
  assert.equal(state.inserts[0]?.table, assets, "the row is written to assets");
});

test("a second artifact referencing the same bytes keeps one object", async () => {
  const state = world();
  const bytes = png(160);
  assert.equal((await upload(state, { body: bytes })).status, 201);
  assert.equal((await upload(state, { body: bytes, artifactId: OTHER_ARTIFACT_ID })).status, 201);
  assert.deepEqual([state.puts.length, state.assets.size], [1, 1], "the bytes are stored once");
  assert.deepEqual(
    state.references.map((row) => row.artifactId).sort(),
    [ARTIFACT_ID, OTHER_ARTIFACT_ID].sort(),
    "each artifact holds its own reference",
  );
  assert.equal(state.references.filter((row) => row.assetSha256 === digestOf(bytes)).length, 2);
});

test("a refused content type names the refusal and writes nothing", async () => {
  for (const contentType of ["image/svg+xml", "text/html", "application/json", "image/png; charset=utf-8"]) {
    const state = world();
    const response = await upload(state, { contentType });
    assert.deepEqual(
      [contentType, response.status, await json(response), wrote(state)],
      [contentType, 415, { error: "unsupported_content_type" }, [0, 0]],
      contentType,
    );
  }
  const accepted = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  for (const contentType of accepted) {
    const state = world();
    const response = await upload(state, { contentType });
    assert.deepEqual(
      [contentType, response.status, (await json(response)).contentType],
      [contentType, 201, contentType],
      `${contentType} is raster`,
    );
  }
});

test("a cross-origin upload is refused by name and writes nothing", async () => {
  const state = world();
  const response = await upload(state, { origin: "https://evil.example" });
  assert.deepEqual(
    [response.status, await json(response), wrote(state)],
    [403, { error: "origin_not_allowed" }, [0, 0]],
  );
});

test("an oversize upload refuses against the asset cap and writes nothing", async () => {
  const state = world();
  const response = await upload(state, { declaredLength: String(MAX_ASSET_BYTES + 1), body: png() });
  assert.deepEqual(
    [response.status, await json(response), wrote(state)],
    [413, { error: "too_large", maxBytes: MAX_ASSET_BYTES }, [0, 0]],
  );
  assert.equal(MAX_ASSET_BYTES < 16_777_216, true, "the asset cap stays below the artifact cap");
});

test("a declared size that does not match the bytes refuses by name and writes nothing", async () => {
  const state = world();
  const body = png(96);
  const response = await upload(state, { declaredLength: String(body.length + 1024), body });
  assert.deepEqual([response.status, await json(response), wrote(state)], [400, { error: "size_mismatch" }, [0, 0]]);
  const undeclared = await upload(state, { declaredLength: null, body });
  assert.deepEqual(
    [undeclared.status, await json(undeclared), wrote(state)],
    [411, { error: "content_length_required" }, [0, 0]],
  );
});

test("an empty body refuses by name and writes nothing", async () => {
  const state = world();
  const response = await upload(state, { body: new Uint8Array(0) });
  assert.deepEqual([response.status, await json(response), wrote(state)], [400, { error: "empty_asset" }, [0, 0]]);
});

test("only the owner and an editor may upload, with the document-save access rule", async () => {
  const state = world({ shares: [{ artifactId: ARTIFACT_ID, userId: READER_ID, role: "reader" }] });
  const reader = await upload(state, { userId: READER_ID });
  assert.deepEqual([reader.status, await json(reader), wrote(state)], [403, { error: "forbidden" }, [0, 0]]);
  const stranger = await upload(state, { userId: STRANGER_ID });
  assert.deepEqual([stranger.status, await json(stranger), wrote(state)], [404, { error: "not_found" }, [0, 0]]);
  const anonymous = await upload(state, { userId: null });
  assert.deepEqual([anonymous.status, await json(anonymous), wrote(state)], [401, { error: "unauthorized" }, [0, 0]]);

  const shared = world({ shares: [{ artifactId: ARTIFACT_ID, userId: READER_ID, role: "editor" }] });
  const editor = await upload(shared, { userId: READER_ID });
  assert.deepEqual([editor.status, (await json(editor)).sizeBytes], [201, png().length], "an editor may upload");
  assert.equal(shared.references.length, 1);

  const viewing = world({ shares: [{ artifactId: ARTIFACT_ID, userId: READER_ID, role: "reader" }] });
  const viewOnly = await upload(viewing, { userId: READER_ID });
  assert.deepEqual(
    [viewOnly.status, await json(viewOnly)],
    [403, { error: "forbidden" }],
    "a read grant is not enough",
  );
});

test("the upload gate asks for the same owner-or-share access the document save asks for", async () => {
  const state = world();
  assert.equal((await upload(state)).status, 201);
  const access = state.statements.find((statement) => statement.sql.includes(`"artifacts"."ownerId"`));
  assert.ok(access, "the access query is the owner-or-share shape");
  assert.equal(
    access.sql,
    `("artifacts"."id" = $1 and "artifacts"."deletedAt" is null and ("artifacts"."ownerId" = $2 or "artifactShares"."sharedWithUserId" is not null))`,
  );
  assert.deepEqual(access.params, [ARTIFACT_ID, OWNER_ID], "the session identity is the only identity");
  const lookup = state.statements.find((statement) => statement.sql.includes(`"assets"."sha256"`));
  assert.deepEqual(
    [lookup?.sql, lookup?.params],
    [`"assets"."sha256" = $1`, [digestOf(png())]],
    "the stored asset is looked up by its digest",
  );
});
