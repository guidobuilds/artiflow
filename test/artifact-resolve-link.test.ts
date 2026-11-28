import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpBackend } from "@artiflow/mcp-server/ports";
import { ARTIFACT_TOOL_NAMES } from "@artiflow/contracts/artifacts";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";

const OWNER = "user-owner";
const DESIGN = "8f0e2b7a-4c1d-4f6e-9a3b-1c5d7e9f0a12";
const PAGE = "d41c9a3e-6f2b-4d8c-a1b0-3e5f7a9c2d64";
const REVISION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const sceneText = JSON.stringify({
  formatVersion: 1,
  frames: [
    {
      id: "variant-a",
      name: "A · stacked",
      x: 0,
      y: 0,
      w: 390,
      h: 844,
      nodes: [],
      source: { artifactId: PAGE, revisionId: REVISION, mode: "fluid" },
    },
  ],
  pages: [{ id: "review", name: "Review" }],
});

type Row = {
  id: string | null;
  revisionNumber: number | null;
  storageKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  deletedAt: Date | null;
  kind: string;
  title: string | null;
};

const rowOf = (kind: string, overrides: Partial<Row> = {}): Row => ({
  id: REVISION,
  revisionNumber: 3,
  storageKey: "revisions/three",
  sha256: "a".repeat(64),
  sizeBytes: sceneText.length,
  deletedAt: null,
  kind,
  title: kind === "canvas" ? "Sharing a Design · variants" : "Sharing a Design",
  ...overrides,
});

const backendOf = (rows: { canvas?: Row | null; page?: Row | null }, seen: { revisionId?: string } = {}) =>
  ({
    caps: { maxArtifactBytes: 1024, maxChunkBytes: 512, maxCommentBody: 100, maxCommentQuote: 100 },
    selectReadRevision: async (_executor: unknown, ownerId: string, artifactId: string, revisionId?: string) => {
      if (ownerId !== OWNER) return null;
      seen.revisionId = revisionId;
      if (revisionId !== undefined && revisionId !== REVISION) return null;
      if (artifactId === DESIGN) return rows.canvas ?? null;
      if (artifactId === PAGE) return rows.page ?? null;
      return null;
    },
    getRevisionBytes: async () => ({
      ok: true,
      value: { bytes: new TextEncoder().encode(sceneText), sizeBytes: sceneText.length },
    }),
  }) as unknown as McpBackend;

type ToolResult = { isError?: boolean; content?: { text?: string }[] };
const payload = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;

const toolset = async (rows: { canvas?: Row | null; page?: Row | null }, scopes = ["artifacts:read"]) => {
  const seen: { revisionId?: string } = {};
  const server = createArtifactTools({
    backend: backendOf(rows, seen),
    publicOrigin: "https://artiflow.example",
    readScope: "artifacts:read",
  })({ userId: OWNER, scopes });
  const client = new Client({ name: "resolve-link-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  return {
    names,
    seen,
    resolve: async (link: string): Promise<ToolResult> =>
      (await client.callTool({ name: "artifact_resolve_link", arguments: { link } })) as ToolResult,
  };
};

test("the link tool is advertised next to the other artifact tools and only reads", async () => {
  const { names } = await toolset({});
  assert.deepEqual(names.slice().sort(), [...ARTIFACT_TOOL_NAMES].sort());
  assert.equal(names.includes("artifact_resolve_link"), true);
});

test("a textual client resumes the same Design, artboard, page and pinned version from the link", async () => {
  const { resolve, seen } = await toolset({ canvas: rowOf("canvas") });
  const link = `https://artiflow.example/artifact/${DESIGN}?revision=${REVISION}&view=focus&frame=variant-a&width=390&page=review`;
  const result = await resolve(link);
  assert.equal(result.isError, undefined);
  const body = payload(result);
  assert.equal(body.artifactId, DESIGN);
  assert.equal(body.kind, "canvas");
  assert.equal(body.title, "Sharing a Design · variants");
  assert.equal(body.revisionId, REVISION);
  assert.equal(body.pinnedRevision, true);
  assert.equal(body.url, `https://artiflow.example/artifact/${DESIGN}`);
  assert.equal(
    body.link,
    `/artifact/${DESIGN}?revision=${REVISION}&frame=variant-a&view=focus&width=390&page=review`,
    "the reply names the same point, so the reference can be pasted back",
  );
  assert.deepEqual(body.target, {
    view: "focus",
    width: 390,
    frame: { id: "variant-a", name: "A · stacked" },
    page: { id: "review", name: "Review" },
  });
  assert.equal(body.missing, null);
  assert.equal(seen.revisionId, REVISION, "the pinned version is the one read");
});

test("the whole canvas is usable without a frame, and no pinned version reads the current one", async () => {
  const { resolve, seen } = await toolset({ canvas: rowOf("canvas") });
  const body = payload(await resolve(`/artifact/${DESIGN}`));
  assert.equal(body.pinnedRevision, false);
  assert.deepEqual(body.target, { view: "canvas", width: null, frame: null, page: null });
  assert.equal(body.missing, null);
  assert.equal(seen.revisionId, undefined);
});

test("a link whose artboard or page is gone answers with what is missing, never another content", async () => {
  const { resolve } = await toolset({ canvas: rowOf("canvas") });
  const goneFrame = payload(await resolve(`/artifact/${DESIGN}?frame=variant-gone`));
  assert.equal(goneFrame.missing, "artboard");
  assert.deepEqual(goneFrame.target, { view: "canvas", width: null, frame: null, page: null });
  const gonePage = payload(await resolve(`/artifact/${DESIGN}?page=approved`));
  assert.equal(gonePage.missing, "page");
  const goneRevision = await resolve(`/artifact/${DESIGN}?revision=${randomUUID()}`);
  assert.equal(goneRevision.isError, true);
  assert.equal(payload(goneRevision).error, "not_found");
});

test("a Page link is usable as a reference and never claims an artboard", async () => {
  const { resolve } = await toolset({ page: rowOf("html") });
  const body = payload(await resolve(`/artifact/${PAGE}`));
  assert.equal(body.kind, "html");
  assert.deepEqual(body.target, null);
  assert.equal(body.missing, null);
  const withFrame = payload(await resolve(`/artifact/${PAGE}?frame=variant-a`));
  assert.equal(withFrame.missing, "artboard");
});

test("a link this build cannot read is refused with its reason, and the tool needs the read scope", async () => {
  const { resolve } = await toolset({ canvas: rowOf("canvas") });
  for (const [link, reason] of [
    ["https://artiflow.example/s/token", "not_an_artifact_link"],
    ["/artifact/not-a-uuid", "invalid_artifact_id"],
    [`/artifact/${DESIGN}?revision=nope`, "invalid_revision_id"],
  ] as const) {
    const refused = await resolve(link);
    assert.equal(refused.isError, true, link);
    assert.equal(payload(refused).error, "invalid_link");
    assert.equal(payload(refused).message, reason);
  }
  const notMine = payload(await resolve(`/artifact/22222222-2222-4222-8222-222222222222`));
  assert.equal(notMine.error, "not_found");
  const scoped = await toolset({ canvas: rowOf("canvas") }, ["artifacts:write"]);
  const denied = await scoped.resolve(`/artifact/${DESIGN}`);
  assert.equal(denied.isError, true);
  assert.equal(payload(denied).error, "insufficient_scope");
});
