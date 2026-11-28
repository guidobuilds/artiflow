import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Associations, type AssociationEvent } from "@artiflow/plugin-core/associations";
import { ArtifactRefusal, createArtifactApi, type ArtifactApi, type Refusal } from "@artiflow/plugin-core/core";
import {
  executeArtifactTool,
  sceneApplyInputSchema,
  sceneOutlineInputSchema,
  sceneReadInputSchema,
} from "@artiflow/plugin-core/tools";
import type { SceneOperation } from "@artiflow/domain/scene-operations";
import { toolDefinitions } from "../plugins/opencode/src/tool-definitions.ts";

const base = "https://artifacts.example";
const token = "access";
const artifactId = "a";
const sceneOps: SceneOperation[] = [{ op: "move_node", id: "n1", x: 10, y: 20 }];

type Sent = { method: string; url: string; body: unknown; authorization: string | null };

function transport(replies: ((sent: Sent) => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const request: typeof fetch = async (url, init) => {
    const entry = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    sent.push(entry);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    assert.ok(reply, "a reply must exist for every request");
    return reply(entry);
  };
  return { sent, request };
}

const apiOf = (request: typeof fetch) => createArtifactApi({ base, token, request });

const refusalOf = async (promise: Promise<unknown>): Promise<Refusal> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArtifactRefusal, `expected a typed refusal, got ${String(error)}`);
    return error.body;
  }
  assert.fail("expected a refusal");
};

const outline = {
  artifactId,
  revisionId: "r1",
  seq: 2,
  formatVersion: 1,
  frameCount: 1,
  looseNodeCount: 1,
  frames: [{ id: "frame-home", name: "Home", nodeCount: 1, bbox: { x: 0, y: 0, w: 400, h: 300 } }],
};
const frame = {
  artifactId,
  revisionId: "r1",
  seq: 2,
  frame: { id: "frame-home", name: "Home", x: 0, y: 0, w: 400, h: 300, nodeCount: 1, nodes: [] },
};
const canvas = { artifactId, revisionId: "r1", seq: 2, canvas: { nodeCount: 1, nodes: [] } };
const applied = {
  artifactId,
  baseSeq: 0,
  seq: 1,
  applied: 1,
  replayed: false,
  published: false,
  revisionId: null,
  boxes: [{ id: "n1", frameId: "frame-home", x: 10, y: 20, w: 100, h: 60 }],
  violations: [],
};

test("scene_outline issues one GET on the outline route and returns the reply verbatim", async () => {
  const { sent, request } = transport([() => Response.json(outline)]);
  assert.deepEqual(await apiOf(request).sceneOutline({ artifactId }), outline);
  assert.deepEqual(sent, [
    {
      method: "GET",
      url: `${base}/api/v1/artifacts/a/scene/outline`,
      body: undefined,
      authorization: `Bearer ${token}`,
    },
  ]);
});

test("scene_read sends frameId and the comma-joined nodeIds, and omits empty filters", async () => {
  const { sent, request } = transport([
    () => Response.json(frame),
    () => Response.json(frame),
    () => Response.json(canvas),
  ]);
  const api = apiOf(request);
  assert.deepEqual(await api.sceneRead({ artifactId, frameId: "frame-home", nodeIds: ["n1", "n2"] }), frame);
  assert.deepEqual(await api.sceneRead({ artifactId, frameId: "frame-home" }), frame);
  assert.deepEqual(await api.sceneRead({ artifactId, frameId: "", nodeIds: [] }), canvas);
  assert.deepEqual(
    sent.map(({ method, url }) => ({ method, url })),
    [
      { method: "GET", url: `${base}/api/v1/artifacts/a/scene/read?frameId=frame-home&nodeIds=n1,n2` },
      { method: "GET", url: `${base}/api/v1/artifacts/a/scene/read?frameId=frame-home` },
      { method: "GET", url: `${base}/api/v1/artifacts/a/scene/read` },
    ],
  );
});

test("scene_apply posts one batch to the apply route and returns the applied reply verbatim", async () => {
  const { sent, request } = transport([() => Response.json(applied)]);
  assert.deepEqual(
    await apiOf(request).sceneApply({ artifactId, baseSeq: 0, idempotencyKey: "batch-1", ops: sceneOps }),
    applied,
  );
  assert.deepEqual(sent, [
    {
      method: "POST",
      url: `${base}/api/v1/artifacts/a/scene/apply`,
      body: { baseSeq: 0, idempotencyKey: "batch-1", ops: sceneOps },
      authorization: `Bearer ${token}`,
    },
  ]);
});

test("a stale baseSeq is a concurrent_edit refusal that keeps the live sequence, with no retry", async () => {
  const stale = {
    error: "concurrent_edit",
    message: "base_sequence_is_stale",
    artifactId,
    currentSeq: 7,
  };
  const { sent, request } = transport([() => Response.json(stale, { status: 409 })]);
  assert.deepEqual(
    await refusalOf(apiOf(request).sceneApply({ artifactId, baseSeq: 0, idempotencyKey: "batch-1", ops: sceneOps })),
    stale,
  );
  assert.equal(sent.length, 1);
});

test("a rejected batch keeps the op index an agent needs to recover", async () => {
  const rejected = {
    error: "invalid_operation",
    message: "unknown_node",
    artifactId,
    currentSeq: 0,
    opIndex: 1,
  };
  const { sent, request } = transport([() => Response.json(rejected, { status: 400 })]);
  assert.deepEqual(
    await refusalOf(apiOf(request).sceneApply({ artifactId, baseSeq: 0, idempotencyKey: "batch-1", ops: sceneOps })),
    rejected,
  );
  assert.equal(sent.length, 1);
});

test("a read refusal keeps the frame, cap and kind details the route answered", async () => {
  const oversized = {
    error: "too_large",
    message: "read_window_exceeds_the_node_cap",
    artifactId,
    frameId: "frame-home",
    maxNodes: 200,
    requestedNodes: 201,
  };
  const wrongKind = { error: "wrong_kind", message: "artifact_is_not_a_canvas", artifactId, kind: "markdown" };
  const { sent, request } = transport([
    () => Response.json(oversized, { status: 413 }),
    () => Response.json(wrongKind, { status: 409 }),
  ]);
  const api = apiOf(request);
  assert.deepEqual(await refusalOf(api.sceneRead({ artifactId, frameId: "frame-home" })), oversized);
  assert.deepEqual(await refusalOf(api.sceneRead({ artifactId })), wrongKind);
  assert.equal(sent.length, 2);
});

type Recorded = { operation: string; input: unknown };

function harness() {
  const stored = new Map<string, unknown>();
  const events: AssociationEvent[] = [];
  const calls: Recorded[] = [];
  const associations = new Associations(
    {
      get: async (key) => stored.get(key),
      set: async (key, value) => {
        stored.set(key, value);
      },
    },
    async (event) => {
      events.push(event);
    },
  );
  const record = <T>(operation: string, value: unknown, input: unknown): T => {
    calls.push({ operation, input });
    return value as T;
  };
  const api = {
    sceneOutline: async (input: unknown) => record("sceneOutline", outline, input),
    sceneRead: async (input: unknown) => record("sceneRead", canvas, input),
    sceneApply: async (input: unknown) => record("sceneApply", applied, input),
  };
  const auth = {
    api: async <T>(operation: (client: ArtifactApi) => Promise<T>): Promise<T> =>
      operation(api as unknown as ArtifactApi),
  };
  const context = { sessionID: "s", signal: new AbortController().signal };
  return { associations, events, calls, auth, context };
}

const dispatchCases = [
  ["scene_outline", "sceneOutline", { artifactId }, outline],
  ["scene_read", "sceneRead", { artifactId, frameId: "frame-home", nodeIds: ["n1"] }, canvas],
  ["scene_apply", "sceneApply", { artifactId, baseSeq: 0, idempotencyKey: "batch-1", ops: sceneOps }, applied],
] as const;

for (const [name, operation, input, reply] of dispatchCases)
  test(`dispatch routes ${name} to ${operation} and records no artifact association`, async () => {
    const h = harness();
    assert.deepEqual(await executeArtifactTool(name, input, h.context, h.auth, h.associations), {
      content: JSON.stringify(reply),
    });
    assert.deepEqual(h.calls, [{ operation, input }]);
    assert.deepEqual(h.events, []);
    assert.deepEqual(await h.associations.list("s"), []);
  });

const byName = new Map(toolDefinitions.map((definition) => [definition.name, definition] as const));

test("the plugin declares the three scene tools with the shared input fragments", () => {
  const outlineDefinition = byName.get("scene_outline");
  const readDefinition = byName.get("scene_read");
  const applyDefinition = byName.get("scene_apply");
  assert.ok(outlineDefinition && readDefinition && applyDefinition);
  assert.deepEqual(outlineDefinition.properties, sceneOutlineInputSchema.properties);
  assert.deepEqual(outlineDefinition.required, sceneOutlineInputSchema.required);
  assert.deepEqual(outlineDefinition.required, ["artifactId"]);
  assert.deepEqual(readDefinition.properties, sceneReadInputSchema.properties);
  assert.deepEqual(readDefinition.required, sceneReadInputSchema.required);
  assert.deepEqual(readDefinition.required, ["artifactId"]);
  assert.deepEqual(applyDefinition.properties, sceneApplyInputSchema.properties);
  assert.deepEqual(applyDefinition.required, sceneApplyInputSchema.required);
  assert.deepEqual(applyDefinition.required, ["artifactId", "baseSeq", "idempotencyKey", "ops"]);
});

type OpFragment = { items?: { oneOf?: { properties?: { op?: { const?: string } } }[] } };

const opNamesOf = (fragment: unknown): string[] => {
  const items = (fragment as OpFragment).items;
  return (items?.oneOf ?? []).map((entry) => entry.properties?.op?.const ?? "");
};

test("scene_apply declares exactly the operations of the shared fragment", () => {
  const definition = byName.get("scene_apply");
  assert.ok(definition);
  const declared = opNamesOf(definition.properties.ops);
  assert.deepEqual(declared, opNamesOf(sceneApplyInputSchema.properties.ops));
  assert.ok(declared.length > 0, "the batch schema declares no operation");
  for (const name of declared) assert.ok(name.length > 0, "an operation carries no name");
  assert.equal(new Set(declared).size, declared.length, "an operation is declared twice");
});

test("the scene descriptions carry the operating rules the model must follow", () => {
  const outlineDefinition = byName.get("scene_outline");
  const readDefinition = byName.get("scene_read");
  const applyDefinition = byName.get("scene_apply");
  assert.ok(outlineDefinition && readDefinition && applyDefinition);
  assert.match(outlineDefinition.description, /frame/i);
  assert.match(outlineDefinition.description, /node count/i);
  assert.match(outlineDefinition.description, /creates no revision/i);
  assert.match(readDefinition.description, /frameId/);
  assert.match(readDefinition.description, /nodeIds/);
  assert.match(readDefinition.description, /too_large/);
  assert.match(readDefinition.description, /unknown_frame/);
  assert.match(readDefinition.description, /unknown_node/);
  assert.match(applyDefinition.description, /baseSeq/);
  assert.match(applyDefinition.description, /idempotencyKey/);
  assert.match(applyDefinition.description, /concurrent_edit/);
  assert.match(applyDefinition.description, /currentSeq/);
  assert.match(applyDefinition.description, /scene_outline/);
  assert.match(applyDefinition.description, /never blind-retry/);
  assert.match(applyDefinition.description, /violations/);
});

test("the shared scene core carries no MCP transport into the plugin bundle", async () => {
  const source = await readFile(new URL("../packages/mcp-server/src/scene-tools.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
  assert.ok(specifiers.length > 0, "the module has imports to inspect");
  for (const specifier of specifiers) {
    assert.ok(!specifier.startsWith("@modelcontextprotocol/"), `${specifier} would bundle the MCP SDK`);
    assert.notEqual(specifier, "./server.ts", "the shared core must not import the registrations");
  }
});
