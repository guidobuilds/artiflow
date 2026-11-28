import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  McpRollback,
  type McpBackend,
  type McpCommentDocument,
  type McpCommentInsert,
} from "@artiflow/mcp-server/ports";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";

const DESIGN = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const OWNER = "44444444-4444-4444-8444-444444444444";
const DESIGN_REVISION = "55555555-5555-4555-8555-555555555555";
const SOURCE_REVISION = "33333333-3333-4333-8333-333333333333";
const OTHER_REVISION = "66666666-6666-4666-8666-666666666666";
const OLD_REVISION = "77777777-7777-4777-8777-777777777777";

const scene: Scene = {
  formatVersion: SCENE_FORMAT_VERSION,
  frames: [
    {
      id: "frame-a",
      name: "Variant A",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      nodes: [],
      source: { artifactId: SOURCE, revisionId: SOURCE_REVISION, mode: "fixed" },
    },
    { id: "frame-plain", name: "Plain", x: 0, y: 600, w: 200, h: 200, nodes: [] },
  ],
};

const anchor = {
  kind: "artboard-point",
  boardId: "frame-a",
  revisionId: SOURCE_REVISION,
  selector: 'button[data-testid="cta"]',
  textHint: "Start free",
  x: 0.4,
  y: 0.6,
  viewportWidth: 1280,
};

type SourceKind = "html" | "markdown" | null;

const sourceDocument = (kind: SourceKind): McpCommentDocument | null =>
  kind === null ? null : { id: SOURCE, kind, ownerId: "another-owner", access: "reader", deletedAt: null };

function backendFor(source: SourceKind) {
  const inserted: McpCommentInsert[] = [];
  let byteReads = 0;
  const backend = {
    caps: { maxArtifactBytes: 1_000_000, maxChunkBytes: 262_144, maxCommentBody: 4000, maxCommentQuote: 2000 },
    commentDocument: async (_executor: unknown, _userId: string, artifactId: string, access: string) =>
      artifactId === DESIGN
        ? { id: DESIGN, kind: "canvas", ownerId: OWNER, access: "owner", deletedAt: null }
        : artifactId === SOURCE && access === "shared"
          ? sourceDocument(source)
          : null,
    currentRevision: async () => ({ id: DESIGN_REVISION, storageKey: "design/key", sha256: "a".repeat(64) }),
    getRevisionBytes: async () => {
      byteReads += 1;
      return { ok: false, kind: "conflict", reason: "not_expected" };
    },
    insertComment: async (_executor: unknown, input: McpCommentInsert) => {
      inserted.push(input);
      return { id: `comment-${inserted.length}` };
    },
    commentTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
      try {
        return await run(undefined);
      } catch (error) {
        if (error instanceof McpRollback) return error.carried;
        throw error;
      }
    },
    selectReadRevision: async () => ({
      id: DESIGN_REVISION,
      revisionNumber: 1,
      storageKey: "design/key",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      deletedAt: null,
      kind: "canvas",
      title: null,
    }),
    documentDraft: async () => ({
      ok: true,
      value: { artifactId: DESIGN, kind: "canvas", seq: 1, text: canonicalScene(scene) },
    }),
  } as unknown as McpBackend;
  return { backend, inserted, byteReads: () => byteReads };
}

type ToolResult = { isError?: boolean; content?: unknown };
const payloadOf = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(((result.content ?? []) as { text?: string }[])[0]?.text ?? "{}") as Record<string, unknown>;

const call = async (source: SourceKind, anchorValue: unknown = anchor) => {
  const world = backendFor(source);
  const server = createArtifactTools({
    backend: world.backend,
    requireScope: "artifacts:write",
    readScope: "artifacts:read",
  })({
    userId: OWNER,
    scopes: ["artifacts:write", "artifacts:read"],
  });
  const client = new Client({ name: "design-request-mcp", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const result = (await client.callTool({
    name: "artifact_add_comment",
    arguments: { artifactId: DESIGN, anchor: anchorValue, body: "Change the label" },
  })) as ToolResult;
  return { result, world };
};

test("the agent surface accepts an artboard request anchored to the pinned revision", async () => {
  const { result, world } = await call("html");
  assert.equal(result.isError, undefined);
  assert.deepEqual(world.inserted[0]?.anchor, anchor);
  assert.equal(world.inserted[0]?.revisionId, DESIGN_REVISION);
  assert.equal(world.byteReads(), 0, "validating the request never reads the source bytes");
});

test("a frame the scene does not hold refuses by name", async () => {
  const { result } = await call("html", { ...anchor, boardId: "frame-missing" });
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, "unknown_frame");
});

test("a frame without an artboard refuses by name", async () => {
  const { result } = await call("html", { ...anchor, boardId: "frame-plain" });
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, "unknown_source");
});

test("a request pinned to another revision refuses by name", async () => {
  const { result } = await call("html", { ...anchor, revisionId: OLD_REVISION });
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, "revision_mismatch");
});

test("a source the caller cannot read refuses without revealing whether it exists", async () => {
  const { result, world } = await call(null);
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, "source_unavailable");
  assert.deepEqual(world.inserted, []);
  assert.equal(JSON.stringify(payloadOf(result)).includes("Start free"), false);
  assert.equal(world.byteReads(), 0);
});

test("a source that is not an HTML page refuses as unavailable", async () => {
  const { result, world } = await call("markdown");
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).error, "source_unavailable");
  assert.deepEqual(world.inserted, []);
});
