import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ARTIFACT_TOOL_NAMES } from "@artiflow/contracts/artifacts";
import {
  MAX_MCP_ASSET_BYTES,
  MCP_REQUEST_BODY_LIMIT_BYTES,
  MCP_REQUEST_ENVELOPE_HEADROOM_BYTES,
} from "@artiflow/mcp-server/constants";
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
import { createApiApp, type ApiAppDeps } from "../apps/api/src/app.ts";
import type { AppConfig } from "../apps/api/src/config.ts";
import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
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
type Artifact = { id: string; ownerId: string; deletedAt?: Date | null };
type World = {
  artifacts: Record<string, Artifact>;
  shares: { artifactId: string; userId: string; role: string }[];
  assets: Map<string, { sha256: string; sizeBytes: number; contentType: string; storageKey?: string }>;
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
  if (params.length > 2) {
    const artifactId = String(params[0]);
    const sha256 = String(params[1]);
    const row = state.assets.get(sha256);
    if (!row) return [];
    if (!state.references.some((reference) => reference.artifactId === artifactId && reference.assetSha256 === sha256))
      return [];
    if (state.artifacts[artifactId]?.ownerId !== String(params[2])) return [];
    return [{ storageKey: row.storageKey, contentType: row.contentType, sizeBytes: row.sizeBytes }];
  }
  const row = state.assets.get(String(params[0]));
  return row ? [{ sha256: row.sha256, sizeBytes: row.sizeBytes, contentType: row.contentType }] : [];
};

const stateRows = (state: World, params: unknown[]): unknown[] => {
  const artifact: Artifact | undefined = state.artifacts[String(params[0])];
  if (!artifact || artifact.ownerId !== String(params[1])) return [];
  return [
    {
      currentRevisionId: null,
      observedSizeBytes: null,
      deletedAt: artifact.deletedAt ?? null,
      revisionCount: 0,
      kind: "canvas",
    },
  ];
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
      groupBy: () => query,
      limit: () => query,
      where: (expression: unknown) => {
        const compiled = dialect.sqlToQuery(expression as SQL);
        state.statements.push({ sql: compiled.sql, params: compiled.params });
        rows =
          table === artifacts
            ? compiled.sql.includes('"artifactShares"')
              ? accessRows(state, compiled.params)
              : stateRows(state, compiled.params)
            : assetRows(state, compiled.params);
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

type ToolResult = { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> };

const toolPayload = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;

const toolset = async (state: World, scopes: string[] = ["artifacts:write"]) => {
  const server = createArtifactTools({ backend: createMcpBackend(databaseOf(state), storageOf(state)) })({
    userId: OWNER_ID,
    scopes,
  });
  const client = new Client({ name: "asset-upload-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const tools = (await client.listTools()).tools;
  return {
    names: tools.map((tool) => tool.name),
    tools,
    callTool: async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    uploadAsset: (input: { artifactId?: string; contentType?: string; bytes: Uint8Array }): Promise<ToolResult> =>
      client.callTool({
        name: "asset_upload",
        arguments: {
          artifactId: input.artifactId ?? ARTIFACT_ID,
          contentType: input.contentType ?? "image/png",
          contentBase64: Buffer.from(input.bytes).toString("base64"),
        },
      }) as Promise<ToolResult>,
  };
};

test("asset_upload is registered next to the artifact, document and scene tools", async () => {
  const { names, tools } = await toolset(world());
  assert.deepEqual(names.slice().sort(), [...ARTIFACT_TOOL_NAMES].sort(), "the registry and the contract list agree");
  assert.equal(names.includes("asset_upload"), true, "the new tool is advertised");
  const tool = tools.find((candidate) => candidate.name === "asset_upload") as {
    annotations?: Record<string, unknown>;
    outputSchema?: { properties?: Record<string, unknown> };
  };
  assert.equal(tool.annotations, undefined, "asset_upload writes, so it is not a read tool");
  assert.deepEqual(
    Object.keys(tool.outputSchema?.properties ?? {}).sort(),
    ["contentType", "sha256", "sizeBytes"],
    "the output schema carries exactly the digest a scene node names",
  );
});

test("the bytes the tool stores are the bytes delivery serves, and HTTP shares the one object", async () => {
  const state = world();
  const bytes = png(320);
  const sha256 = digestOf(bytes);
  const { uploadAsset } = await toolset(state);
  const uploaded = await uploadAsset({ bytes });
  assert.equal(uploaded.isError ?? false, false, JSON.stringify(toolPayload(uploaded)));
  assert.deepEqual(uploaded.structuredContent, { sha256, sizeBytes: bytes.length, contentType: "image/png" });
  assert.deepEqual(toolPayload(uploaded), uploaded.structuredContent, "the text content repeats the structured one");
  assert.deepEqual(
    state.puts.map((put) => put.key),
    [`assets/${sha256}`],
    "the tool stores one content-addressed object",
  );
  assert.deepEqual(state.references, [{ artifactId: ARTIFACT_ID, assetSha256: sha256 }], "the artifact references it");
  assert.equal(state.inserts[0]?.table, assets, "the tool writes the assets row, not a parallel record");

  const delivered = await appOf(state, OWNER_ID).request(`/artifact/${ARTIFACT_ID}/asset/${sha256}`);
  assert.deepEqual(
    [delivered.status, Buffer.from(await delivered.arrayBuffer())],
    [200, bytes],
    "delivery serves exactly the uploaded bytes",
  );

  const repeated = await upload(state, { body: bytes });
  assert.deepEqual(
    [repeated.status, await json(repeated)],
    [201, { id: sha256, sizeBytes: bytes.length, contentType: "image/png" }],
    "the same bytes through HTTP answer the same id",
  );
  assert.deepEqual(
    [state.puts.length, state.assets.size, state.objects.size, state.references.length],
    [1, 1, 1, 1],
    "one object, one row and one reference, whichever surface uploaded first",
  );
});

test("the HTTP upload first and the tool second still store one object and answer one digest", async () => {
  const state = world();
  const bytes = png(140);
  const sha256 = digestOf(bytes);
  const overHttp = await upload(state, { body: bytes });
  assert.deepEqual([overHttp.status, (await json(overHttp)).id], [201, sha256]);
  const { uploadAsset } = await toolset(state);
  const uploaded = await uploadAsset({ bytes });
  assert.deepEqual(uploaded.structuredContent, { sha256, sizeBytes: bytes.length, contentType: "image/png" });
  assert.deepEqual([state.puts.length, state.assets.size, state.references.length], [1, 1, 1]);
});

test("the tool accepts the largest payload the MCP body carries and refuses one byte more by name", async () => {
  const accepted = world();
  const { uploadAsset } = await toolset(accepted);
  const atCeiling = Buffer.alloc(MAX_MCP_ASSET_BYTES, 9);
  const stored = await uploadAsset({ bytes: atCeiling });
  assert.equal(stored.isError ?? false, false, JSON.stringify(toolPayload(stored)));
  assert.deepEqual(
    [stored.structuredContent?.sha256, stored.structuredContent?.sizeBytes],
    [digestOf(atCeiling), MAX_MCP_ASSET_BYTES],
    "the ceiling is exactly what the tool stores",
  );

  const refused = world();
  const over = await (await toolset(refused)).uploadAsset({ bytes: Buffer.alloc(MAX_MCP_ASSET_BYTES + 1, 9) });
  assert.equal(over.isError, true);
  const payload = toolPayload(over);
  assert.deepEqual(
    [payload.error, payload.maxBytes, payload.maxEncodedChars],
    ["too_large", MAX_MCP_ASSET_BYTES, Math.ceil(MAX_MCP_ASSET_BYTES / 3) * 4],
    "the refusal names the transport ceiling it refused",
  );
  assert.deepEqual(wrote(refused), [0, 0], "nothing is stored above the ceiling");
  assert.equal(MAX_MCP_ASSET_BYTES, 1_569_792, "the ceiling is 1,569,792 raw bytes: 1,533 KiB");
});

test("the MCP asset ceiling stays inside the body limit the API wires for /mcp", async () => {
  const response = await createApiApp(apiDeps()).fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MCP_REQUEST_BODY_LIMIT_BYTES + 1) },
      body: "{}",
    }),
  );
  assert.deepEqual(
    [response.status, await response.json()],
    [413, { error: "too_large", maxBytes: MCP_REQUEST_BODY_LIMIT_BYTES }],
    "the derived limit is the limit the transport really enforces",
  );
  const encoded = Math.ceil(MAX_MCP_ASSET_BYTES / 3) * 4;
  const envelope = Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "asset_upload",
        arguments: { artifactId: ARTIFACT_ID, contentType: "image/png", contentBase64: "" },
      },
    }),
    "utf8",
  );
  assert.ok(envelope < MCP_REQUEST_ENVELOPE_HEADROOM_BYTES, `the envelope is ${envelope} bytes of headroom`);
  assert.ok(
    encoded + envelope <= MCP_REQUEST_BODY_LIMIT_BYTES,
    "a full-size asset plus its envelope fits the request body",
  );
});

test("a content type outside the raster set refuses through the tool and writes nothing", async () => {
  for (const contentType of ["image/svg+xml", "text/html", "application/octet-stream", "IMAGE/PNG2"]) {
    const state = world();
    const result = await (await toolset(state)).uploadAsset({ bytes: png(), contentType });
    assert.deepEqual(
      [contentType, result.isError, toolPayload(result).error],
      [contentType, true, "unsupported_content_type"],
      contentType,
    );
    assert.deepEqual(wrote(state), [0, 0], "no refused type reaches storage");
  }
  const state = world();
  const raster = await (await toolset(state)).uploadAsset({ bytes: png(), contentType: "image/webp" });
  assert.deepEqual(raster.structuredContent, {
    sha256: digestOf(png()),
    sizeBytes: png().length,
    contentType: "image/webp",
  });
});

test("the tool checks its own scope, the owner gate and the payload before any write", async () => {
  const unscoped = world();
  const noScope = await (await toolset(unscoped, [])).uploadAsset({ bytes: png() });
  assert.deepEqual([noScope.isError, toolPayload(noScope).error], [true, "insufficient_scope"]);
  assert.deepEqual(wrote(unscoped), [0, 0], "no scope means no write");

  const foreign = world({
    artifacts: {
      [ARTIFACT_ID]: { id: ARTIFACT_ID, ownerId: READER_ID },
      [OTHER_ARTIFACT_ID]: { id: OTHER_ARTIFACT_ID, ownerId: OWNER_ID },
    },
  });
  const notMine = await (await toolset(foreign)).uploadAsset({ bytes: png() });
  assert.deepEqual(
    [notMine.isError, toolPayload(notMine).error, toolPayload(notMine).message],
    [true, "not_found", "artifact_not_visible_to_owner"],
    "someone else's artifact is not found, exactly as the other tools answer",
  );
  assert.deepEqual(wrote(foreign), [0, 0], "no foreign artifact is written");

  const deleted = world({
    artifacts: { [ARTIFACT_ID]: { id: ARTIFACT_ID, ownerId: OWNER_ID, deletedAt: new Date() } },
  });
  const gone = await (await toolset(deleted)).uploadAsset({ bytes: png() });
  assert.deepEqual(
    [gone.isError, toolPayload(gone).error, toolPayload(gone).message],
    [true, "gone", "artifact_deleted"],
  );
  assert.deepEqual(wrote(deleted), [0, 0], "a deleted artifact stores nothing");

  const malformed = world();
  const { callTool } = await toolset(malformed);
  for (const contentBase64 of ["not base64!", "====", "  "]) {
    const refusalPayload = await callTool("asset_upload", {
      artifactId: ARTIFACT_ID,
      contentType: "image/png",
      contentBase64,
    });
    assert.equal(refusalPayload.isError, true, `${JSON.stringify(contentBase64)} is not a payload`);
  }
  const badId = await callTool("asset_upload", {
    artifactId: "not-a-uuid",
    contentType: "image/png",
    contentBase64: png().toString("base64"),
  });
  assert.equal(toolPayload(badId).error, "invalid_artifact_id");
  assert.deepEqual(wrote(malformed), [0, 0], "no malformed call reaches storage");
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
