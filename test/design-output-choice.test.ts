import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import { createArtifactTools as createPackageTools } from "@artiflow/mcp-server/server";
import { createMcpBackend } from "../apps/api/src/mcp/backend.ts";
import type { Database } from "../apps/api/src/adapters/postgres/db/client.ts";
import { renderSceneDocument } from "../apps/api/src/viewer/views/scene.ts";
import { labelFor, pluralFor } from "@artiflow/domain/kinds";

const INSTANCE_ORIGIN = "https://artifacts.example.com";
const noopDatabase = { db: {} } as unknown as Database;
const noopStorage = {} as never;
const EMPTY_DESIGN = JSON.stringify({ formatVersion: 1, frames: [] });

type Backend = Parameters<typeof createArtifactTools>[0]["backend"];

const artifactIdFrom = (input: { artifactId?: string }): string => input.artifactId ?? "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const recordingBackend = (written: { kind?: string; title?: string; text?: string }[]): Backend => {
  const base = createMcpBackend(noopDatabase, noopStorage);
  return {
    ...base,
    writeArtifact: async (input: Parameters<Backend["writeArtifact"]>[0]) => {
      written.push({ kind: input.kind, title: input.title ?? undefined, text: new TextDecoder().decode(input.bytes) });
      const artifactId = artifactIdFrom(input);
      return {
        ok: true,
        value: {
          artifactId,
          revisionId: "rev-1",
          revisionNumber: 1,
          sizeBytes: input.bytes.length,
          observedSizeBytes: input.bytes.length,
        },
      };
    },
  } as unknown as Backend;
};

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text?: string }[];
  structuredContent?: Record<string, unknown>;
}>;

const connect = async (
  backend: Backend,
  options: { publicOrigin?: string; packageOnly?: boolean } = {},
): Promise<{ callTool: ToolCall; tools: { name: string; description?: string }[] }> => {
  const claims = { userId: "user-1", scopes: ["artifacts:write", "artifacts:read"] };
  const server = options.packageOnly
    ? createPackageTools({ backend, viewerHtml: () => "<!DOCTYPE html><html></html>" })(claims)
    : createArtifactTools({ backend, publicOrigin: options.publicOrigin ?? INSTANCE_ORIGIN })(claims);
  const client = new Client({ name: "design-output-choice-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }) as ReturnType<ToolCall>,
    tools: (await client.listTools()).tools as { name: string; description?: string }[],
  };
};

const payloadOf = (result: Awaited<ReturnType<ToolCall>>): Record<string, unknown> => {
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
};

test("a created Page replies with the link that opens its own viewer", async () => {
  const written: { kind?: string; title?: string; text?: string }[] = [];
  const { callTool } = await connect(recordingBackend(written));
  const result = await callTool("artifact_write", {
    text: "<!DOCTYPE html><title>Quarterly report</title>",
    title: "Quarterly report",
  });
  const payload = payloadOf(result);
  const artifactId = String(payload.artifactId);
  assert.equal(written[0]?.kind, undefined, "an omitted kind still creates the default Page");
  assert.equal(payload.url, `${INSTANCE_ORIGIN}/artifact/${artifactId}`, "the reply carries an absolute link");
  assert.equal(String(payload.url).includes("/artifact/"), true, "the link names the artifact viewer route");
  assert.equal(String(payload.url).includes("/canvas/"), false, "a Page never opens in the design space");
  assert.equal(result.structuredContent?.url, payload.url, "the structured result names the same link the text does");
});

test("a created Design replies with the link that opens its own space", async () => {
  const written: { kind?: string; title?: string; text?: string }[] = [];
  const { callTool } = await connect(recordingBackend(written));
  const payload = payloadOf(
    await callTool("artifact_write", { text: EMPTY_DESIGN, kind: "canvas", title: "Checkout options" }),
  );
  const artifactId = String(payload.artifactId);
  assert.equal(written[0]?.kind, "canvas", "the explicit choice reaches the store unchanged");
  assert.equal(written[0]?.title, "Checkout options", "a Design keeps the name it was given");
  assert.equal(payload.url, `${INSTANCE_ORIGIN}/artifact/${artifactId}`, "the reply carries an absolute link");
});

test("a Design with no artboards still names itself and opens a space", async () => {
  const { callTool } = await connect(recordingBackend([]));
  const payload = payloadOf(
    await callTool("artifact_write", { text: EMPTY_DESIGN, kind: "canvas", title: "Checkout options" }),
  );
  assert.equal(typeof payload.url, "string", "an empty Design is still openable");
  const page = renderSceneDocument({ formatVersion: 1, frames: [] }, undefined, undefined, [], "canvas");
  assert.match(page, /<title>Design<\/title>/, "the empty Design names its own space instead of shipping a blank page");
  assert.match(page, /class="scene-empty"/, "the space renders a state, not an error");
});

test("the reply omits the link when the instance origin is unknown", async () => {
  const { callTool } = await connect(recordingBackend([]), { packageOnly: true });
  const payload = payloadOf(await callTool("artifact_write", { text: "<p>page</p>" }));
  assert.equal(typeof payload.artifactId, "string");
  assert.equal("url" in payload, false, "no origin, no invented link");
});

test("a person reads Page and Design as two different outputs", () => {
  assert.equal(labelFor("html"), "Page");
  assert.equal(labelFor("canvas"), "Design");
  assert.equal(pluralFor("canvas"), "Designs");
  assert.notEqual(labelFor("html"), labelFor("canvas"));
});

test("the creation tools name both outputs so an agent can choose and say which it opened", async () => {
  const { tools } = await connect(recordingBackend([]));
  for (const name of ["artifact_write", "artifact_commit"]) {
    const description = tools.find((tool) => tool.name === name)?.description ?? "";
    assert.match(description, /Page/, `${name} names the Page output`);
    assert.match(description, /Design/, `${name} names the Design output`);
    assert.match(description, /url/, `${name} says the reply carries the viewer link`);
  }
});

test("an existing artifact keeps the same viewer link when it is revised", async () => {
  const written: { kind?: string; title?: string; text?: string }[] = [];
  const { callTool } = await connect(recordingBackend(written));
  const given = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
  const created = payloadOf(
    await callTool("artifact_write", { text: "<p>v1</p>", artifactId: given, title: "Living report" }),
  );
  const revised = payloadOf(
    await callTool("artifact_write", {
      text: "<p>v2</p>",
      artifactId: given,
      expectedRevisionId: "rev-1",
      title: "Living report",
    }),
  );
  assert.equal(created.url, `${INSTANCE_ORIGIN}/artifact/${given}`);
  assert.equal(revised.url, created.url, "a revision never moves an existing Page to another link");
});
