import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ARTIFACT_TOOL_NAMES, DOCUMENT_TOOL_NAMES, SCENE_TOOL_NAMES } from "@artiflow/contracts/artifacts";
import { SCENE_FORMAT_VERSION, canonicalScene, type Scene } from "@artiflow/domain/scene";
import { MAX_SCENE_READ_BYTES, MAX_SCENE_READ_NODES } from "@artiflow/mcp-server/constants";
import type { McpBackend } from "@artiflow/mcp-server/ports";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";

const OWNER = "user-1";
const OTHER = "user-2";
const SCOPES = ["artifacts:write", "artifacts:read"];
const ARTIFACT = "artifact-1";
const noopDatabase = {} as unknown as Database;

type ToolPayload = Record<string, unknown>;
type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown };
type Advertised = { name: string; annotations?: { readOnlyHint?: boolean }; _meta?: { ui?: unknown } };

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const rectNode = (id: string): Record<string, unknown> => ({
  id,
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: "#eeeeee",
});
const textNode = (id: string, body: string, y = 0): Record<string, unknown> => ({
  id,
  type: "text",
  x: 0,
  y,
  w: 100,
  h: 20,
  text: body,
});
const frameOf = (id: string, name: string, nodes: Record<string, unknown>[], x = 0): Record<string, unknown> => ({
  id,
  name,
  x,
  y: 0,
  w: 100,
  h: 100,
  nodes,
});
const sceneOf = (frames: Record<string, unknown>[]): Scene =>
  ({ formatVersion: SCENE_FORMAT_VERSION, frames }) as unknown as Scene;
const canvasText = (frames: Record<string, unknown>[]): string => canonicalScene(sceneOf(frames));

type Canvas = { ownerId: string; kind: string; text: string; deletedAt?: Date | null };

const canvasBackend = (canvas: Canvas): McpBackend => {
  const bytes = new TextEncoder().encode(canvas.text);
  return {
    ...createMcpBackend(noopDatabase, {} as never),
    selectReadRevision: async (_executor: unknown, ownerId: string) =>
      ownerId !== canvas.ownerId
        ? null
        : {
            id: "rev-1",
            revisionNumber: 1,
            storageKey: "revisions/rev-1",
            sha256: digestOf(bytes),
            sizeBytes: bytes.length,
            deletedAt: canvas.deletedAt ?? null,
            kind: canvas.kind,
            title: "Canvas",
          },
    getRevisionBytes: async () => ({ ok: true, value: { bytes, sizeBytes: bytes.length } }),
  };
};

const connect = async (
  backend: McpBackend,
  scopes: string[] = SCOPES,
): Promise<{
  callTool: (name: string, args: ToolPayload) => Promise<ToolResult>;
  names: string[];
  tools: Advertised[];
}> => {
  const server = createArtifactTools({
    backend,
    requireScope: "artifacts:write",
    readScope: "artifacts:read",
  })({ userId: OWNER, scopes });
  const client = new Client({ name: "scene-tools-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const tools = (await client.listTools()).tools as unknown as Advertised[];
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }) as Promise<ToolResult>,
    names: tools.map((tool) => tool.name),
    tools,
  };
};

const payloadOf = (result: ToolResult): ToolPayload =>
  JSON.parse(((result.content ?? []) as { text?: string }[])[0]?.text ?? "{}") as ToolPayload;
const ok = (result: ToolResult): ToolPayload => {
  assert.equal(result.isError ?? false, false, JSON.stringify(payloadOf(result)));
  return payloadOf(result);
};
const refused = (result: ToolResult, error: string): ToolPayload => {
  assert.equal(result.isError, true, `expected a typed refusal, got ${JSON.stringify(payloadOf(result))}`);
  const payload = payloadOf(result);
  assert.equal(payload.error, error, JSON.stringify(payload));
  return payload;
};

test("scene_outline answers one entry per frame and never a node body", async () => {
  const frames = Array.from({ length: 12 }, (_, index) =>
    frameOf(`frame-${index + 1}`, `Screen ${index + 1}`, [
      rectNode(`node-alpha-${index + 1}`),
      textNode(`text-${index + 1}`, "secret-node-body"),
    ]),
  );
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText(frames) }));
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  assert.equal(outline.artifactId, ARTIFACT);
  assert.equal(outline.revisionId, "rev-1");
  assert.equal(outline.formatVersion, SCENE_FORMAT_VERSION);
  assert.equal(outline.frameCount, 12);
  const listed = outline.frames as ToolPayload[];
  assert.equal(listed.length, 12, "twelve frames are twelve entries");
  for (const entry of listed)
    assert.deepEqual(Object.keys(entry).sort(), ["bbox", "id", "name", "nodeCount"], "an entry is a frame header");
  assert.deepEqual(
    listed.map((entry) => entry.id),
    frames.map((frame) => frame.id),
    "the outline keeps the scene order",
  );
  assert.equal(listed[0]?.nodeCount, 2);
  const serialized = JSON.stringify(outline);
  assert.equal(serialized.includes("secret-node-body"), false, "no node body reaches the wire");
  assert.equal(serialized.includes("node-alpha"), false, "no node id reaches the wire");
});

test("scene_outline costs one line per frame on a 200-node scene", async () => {
  const frames = Array.from({ length: 4 }, (_, frameIndex) =>
    frameOf(
      `frame-${frameIndex + 1}`,
      `Screen ${frameIndex + 1}`,
      Array.from({ length: 50 }, (_, nodeIndex) => rectNode(`node-${frameIndex + 1}-${nodeIndex + 1}`)),
      frameIndex * 100,
    ),
  );
  const text = canvasText(frames);
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text }));
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  const observedBytes = Buffer.byteLength(JSON.stringify(outline), "utf8");
  assert.equal(
    (outline.frames as ToolPayload[]).reduce((sum, entry) => sum + Number(entry.nodeCount), 0),
    200,
    "the scene really holds two hundred nodes",
  );
  assert.ok(observedBytes < 2048, `the outline of a 200-node scene is ${observedBytes} bytes`);
  assert.ok(
    observedBytes * 10 < Buffer.byteLength(text, "utf8"),
    "the outline is an order of magnitude smaller than the scene document it summarises",
  );
});

test("the acceptance budget: a 200-node scene is inspected without reading it in full", async () => {
  const frames = Array.from({ length: 10 }, (_, frameIndex) =>
    frameOf(
      `frame-${frameIndex + 1}`,
      `Screen ${frameIndex + 1}`,
      Array.from({ length: 20 }, (_, nodeIndex) => rectNode(`node-${frameIndex + 1}-${nodeIndex + 1}`)),
      frameIndex * 100,
    ),
  );
  const text = canvasText(frames);
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text }));
  const outline = ok(await callTool("scene_outline", { artifactId: ARTIFACT }));
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "frame-1" }));
  const storedBytes = Buffer.byteLength(text, "utf8");
  const outlineBytes = Buffer.byteLength(JSON.stringify(outline), "utf8");
  const readBytes = Buffer.byteLength(JSON.stringify(read), "utf8");
  const inspectedBytes = outlineBytes + readBytes;
  assert.equal(
    (outline.frames as ToolPayload[]).reduce((sum, entry) => sum + Number(entry.nodeCount), 0),
    200,
    "the scene holds two hundred nodes",
  );
  assert.equal((read.frame as ToolPayload).nodeCount, 20, "one frame, not the whole scene");
  assert.ok(inspectedBytes <= 3072, `outline plus one read costs ${inspectedBytes} bytes, under the 3072 ceiling`);
  assert.ok(
    inspectedBytes * 5 <= storedBytes,
    `${inspectedBytes} inspected bytes stay at least five times below the ${storedBytes} stored bytes`,
  );
});

test("scene_read returns exactly one frame with its own nodes", async () => {
  const frames = [
    frameOf("home", "Home", [rectNode("home-node"), textNode("home-text", "Home body")]),
    frameOf("checkout", "Checkout", [rectNode("checkout-node"), textNode("checkout-text", "Pay now")]),
  ];
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText(frames) }));
  const read = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "checkout" }));
  assert.equal(read.artifactId, ARTIFACT);
  assert.equal(read.revisionId, "rev-1");
  const frame = read.frame as ToolPayload;
  assert.equal(frame.id, "checkout");
  assert.equal(frame.name, "Checkout");
  assert.equal(frame.nodeCount, 2);
  assert.deepEqual(
    (frame.nodes as ToolPayload[]).map((node) => node.id),
    ["checkout-node", "checkout-text"],
    "the frame carries its own nodes and nothing from the sibling frame",
  );
  assert.deepEqual(frame.bbox, { x: 0, y: 0, w: 100, h: 20 });
  assert.equal(JSON.stringify(read).includes("home-node"), false, "the other frame is absent");
});

test("scene_read narrows to the requested nodeIds and refuses an id the frame does not hold", async () => {
  const frames = [
    frameOf("home", "Home", [rectNode("a"), rectNode("b"), rectNode("c")]),
    frameOf("checkout", "Checkout", [rectNode("other")]),
  ];
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText(frames) }));
  const narrowed = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "home", nodeIds: ["c", "a"] }));
  const frame = narrowed.frame as ToolPayload;
  assert.deepEqual(
    (frame.nodes as ToolPayload[]).map((node) => node.id),
    ["a", "c"],
    "only the requested nodes come back, in frame order",
  );
  assert.equal(frame.nodeCount, 2);
  const refusedNode = refused(
    await callTool("scene_read", { artifactId: ARTIFACT, frameId: "home", nodeIds: ["a", "missing"] }),
    "unknown_node",
  );
  assert.equal(refusedNode.message, "node_not_in_frame");
  assert.equal(refusedNode.nodeId, "missing");
});

test("scene_read refuses an unknown frame id by name", async () => {
  const { callTool } = await connect(
    canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText([frameOf("home", "Home", [])]) }),
  );
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "missing" }), "unknown_frame");
  assert.equal(payload.message, "frame_not_in_scene");
  assert.equal(payload.frameId, "missing");
});

test("both scene tools refuse every kind that is not canvas with wrong_kind", async () => {
  const markdown = canvasText([frameOf("home", "Home", [rectNode("a")])]);
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "markdown", text: markdown }));
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "wrong_kind");
    assert.equal(payload.message, "artifact_is_not_a_canvas", `${name} names the reason`);
    assert.equal(payload.kind, "markdown", `${name} names the refused kind`);
    assert.equal(payload.artifactId, ARTIFACT);
  }
});

test("both scene tools refuse an artifact the caller does not own", async () => {
  const { callTool } = await connect(
    canvasBackend({ ownerId: OTHER, kind: "canvas", text: canvasText([frameOf("home", "Home", [])]) }),
  );
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "not_found");
    assert.equal(payload.message, "artifact_not_visible_to_owner", `${name} reports the ownership gate`);
  }
});

test("both scene tools refuse a canvas whose stored bytes are not a scene", async () => {
  const { callTool } = await connect(canvasBackend({ ownerId: OWNER, kind: "canvas", text: "not a scene" }));
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "invalid_scene");
    assert.equal(payload.message, "malformed_scene", `${name} names the scene refusal`);
  }
});

test("scene_read refuses a frame past the node cap and still serves a narrow read of it", async () => {
  const nodes = Array.from({ length: MAX_SCENE_READ_NODES + 1 }, (_, index) => rectNode(`node-${index + 1}`));
  const { callTool } = await connect(
    canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText([frameOf("big", "Big", nodes)]) }),
  );
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "big" }), "too_large");
  assert.equal(payload.message, "read_window_exceeds_the_node_cap");
  assert.equal(payload.maxNodes, MAX_SCENE_READ_NODES);
  assert.equal(payload.requestedNodes, MAX_SCENE_READ_NODES + 1);
  const narrowed = ok(
    await callTool("scene_read", { artifactId: ARTIFACT, frameId: "big", nodeIds: ["node-1", "node-2"] }),
  );
  assert.equal((narrowed.frame as ToolPayload).nodeCount, 2, "the cap bounds one read, not the scene");
});

test("scene_read refuses a frame past the byte cap instead of truncating it", async () => {
  const nodes = Array.from({ length: 5 }, (_, index) => textNode(`text-${index + 1}`, "x".repeat(20_000), index * 20));
  const { callTool } = await connect(
    canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText([frameOf("heavy", "Heavy", nodes)]) }),
  );
  const payload = refused(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "heavy" }), "too_large");
  assert.equal(payload.message, "read_window_exceeds_the_byte_cap");
  assert.equal(payload.maxBytes, MAX_SCENE_READ_BYTES);
  assert.ok(Number(payload.observedBytes) > MAX_SCENE_READ_BYTES, "the observed size is reported, not hidden");
  const narrowed = ok(await callTool("scene_read", { artifactId: ARTIFACT, frameId: "heavy", nodeIds: ["text-1"] }));
  assert.equal((narrowed.frame as ToolPayload).nodeCount, 1);
});

test("the scene tools are registered as reads next to the artifact and document tools", async () => {
  const { names, tools } = await connect(createMcpBackend(noopDatabase, {} as never));
  assert.deepEqual(names.slice().sort(), [...ARTIFACT_TOOL_NAMES].sort());
  for (const name of SCENE_TOOL_NAMES) {
    assert.ok(names.includes(name), `${name} is advertised`);
    assert.equal(DOCUMENT_TOOL_NAMES.includes(name as never), false, `${name} is not a document tool`);
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, true, `${name} reads and says so`);
    assert.equal(tool?._meta?.ui, undefined, `${name} binds no UI resource`);
  }
});

test("both scene tools check the scope of their own call", async () => {
  const { callTool } = await connect(
    canvasBackend({ ownerId: OWNER, kind: "canvas", text: canvasText([frameOf("home", "Home", [])]) }),
    ["artifacts:write"],
  );
  for (const [name, args] of [
    ["scene_outline", { artifactId: ARTIFACT }],
    ["scene_read", { artifactId: ARTIFACT, frameId: "home" }],
  ] as [string, ToolPayload][]) {
    const payload = refused(await callTool(name, args), "insufficient_scope");
    assert.equal(payload.scope, "artifacts:read", `${name} requires the read scope`);
  }
});
