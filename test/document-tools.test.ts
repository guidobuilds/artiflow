import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ARTIFACT_TOOL_NAMES, DOCUMENT_TOOL_NAMES } from "@artiflow/contracts/artifacts";
import { acceptsTextOperations } from "@artiflow/domain/kinds";
import type {
  McpBackend,
  McpDocumentApplied,
  McpDocumentApplyInput,
  McpDocumentCreateInput,
  McpDocumentCreated,
  McpDocumentState,
  McpDocumentText,
  McpResult,
} from "@artiflow/mcp-server/ports";

import { createArtifactTools } from "../apps/api/src/mcp/artifact-tools.ts";
import type { Storage } from "../apps/api/src/adapters/storage/client.ts";
import {
  applyOperations,
  applyOperationsAndFreeze,
  openDraft,
  publish,
  textAt,
  type ArtifactDocumentState,
  type DocumentStore,
  type DraftRecord,
  type OperationRecord,
  type SnapshotRecord,
} from "../apps/api/src/domain/documents/service.ts";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const OWNER = "user-1";
const WRITE_SCOPES = ["artifacts:write", "artifacts:read"];
const CAPS = {
  maxArtifactBytes: 16_777_216,
  maxChunkBytes: 1_048_576,
  maxCommentBody: 2000,
  maxCommentQuote: 500,
};

type FakeRevision = SnapshotRecord & { id: string; revision: number };
type FakeOperation = OperationRecord & { id: string };
type FakeArtifact = {
  ownerId: string;
  title: string;
  kind: string;
  publishedSeq: number;
  currentRevisionId: string | null;
};

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function fakeStorage(): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const providerError = (status: number): Error =>
    Object.assign(new Error(`provider ${status}`), { $metadata: { httpStatusCode: status } });
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      const stored = objects.get(key);
      if (name === "HeadObjectCommand") {
        if (!stored) throw providerError(404);
        return { ContentLength: stored.length };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Uint8Array.from(command.input.Body as Uint8Array));
        return {};
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
    objects,
  };
}

function fakeWorkspace() {
  const storage = fakeStorage();
  const artifacts = new Map<string, FakeArtifact>();
  const drafts = new Map<string, DraftRecord>();
  const operations: FakeOperation[] = [];
  const revisions: FakeRevision[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const store: DocumentStore = {
    async readArtifact(artifactId: string): Promise<ArtifactDocumentState | null> {
      const artifact = artifacts.get(artifactId);
      if (!artifact) return null;
      const mine = revisions.filter((row) => row.artifactId === artifactId);
      const current = mine.find((row) => row.id === artifact.currentRevisionId);
      return {
        artifactId,
        publishedSeq: artifact.publishedSeq,
        currentRevisionId: artifact.currentRevisionId,
        revisionCount: mine.length,
        latestSnapshot: current
          ? {
              storageKey: current.storageKey,
              sha256: current.sha256,
              formatVersion: current.formatVersion,
              createdAt: current.createdAt,
            }
          : null,
      };
    },
    async readDraft(artifactId: string): Promise<DraftRecord | null> {
      return drafts.get(artifactId) ?? null;
    },
    async insertDraftIfAbsent(record: DraftRecord): Promise<DraftRecord> {
      if (!drafts.has(record.artifactId)) drafts.set(record.artifactId, record);
      return drafts.get(record.artifactId) as DraftRecord;
    },
    async readOperation(artifactId: string, idempotencyKey: string): Promise<OperationRecord | null> {
      return operations.find((row) => row.artifactId === artifactId && row.idempotencyKey === idempotencyKey) ?? null;
    },
    async readSnapshotAtOrBefore(artifactId: string, seq: number) {
      const candidates = revisions
        .filter((row) => row.artifactId === artifactId && row.seqTo <= seq)
        .sort((left, right) => right.seqTo - left.seqTo || right.revision - left.revision);
      const row = candidates[0];
      return row
        ? { seqTo: row.seqTo, storageKey: row.storageKey, sha256: row.sha256, formatVersion: row.formatVersion }
        : null;
    },
    async readAppliedOperations(artifactId: string, afterSeq: number, toSeq: number): Promise<OperationRecord[]> {
      return operations
        .filter((row) => row.artifactId === artifactId && row.result === "applied")
        .filter((row) => row.seq > afterSeq && row.seq <= toSeq)
        .sort((left, right) => left.seq - right.seq);
    },
    commitOperation: (input) =>
      serial(async () => {
        if (operations.some((row) => row.idempotencyKey === input.operation.idempotencyKey))
          return { committed: false };
        if (
          input.draft &&
          operations.some(
            (row) =>
              row.artifactId === input.operation.artifactId &&
              row.result === "applied" &&
              row.seq === input.operation.seq,
          )
        )
          return { committed: false };
        operations.push({ ...input.operation, id: `op-${operations.length + 1}` });
        if (input.draft) drafts.set(input.draft.artifactId, input.draft);
        return { committed: true };
      }),
    commitSnapshot: (input) =>
      serial(async () => {
        const artifact = artifacts.get(input.revision.artifactId);
        if (!artifact) return { committed: false, revisionId: null, revisionNumber: null };
        if (
          artifact.publishedSeq !== input.expectedPublishedSeq ||
          (drafts.get(input.revision.artifactId)?.seq ?? 0) !== input.expectedDraftSeq
        )
          return { committed: false, revisionId: null, revisionNumber: null };
        const revisionNumber = revisions.filter((row) => row.artifactId === input.revision.artifactId).length + 1;
        const id = `revision-${revisions.length + 1}`;
        revisions.push({ ...input.revision, id, revision: revisionNumber });
        artifact.publishedSeq = input.revision.seqTo;
        artifact.currentRevisionId = id;
        return { committed: true, revisionId: id, revisionNumber };
      }),
  };
  const seed = (input: { ownerId: string; title: string; kind: string; text: string }): McpDocumentCreated => {
    const artifactId = `artifact-${artifacts.size + 1}`;
    const bytes = new TextEncoder().encode(input.text);
    const storageKey = `artifacts/${artifactId}-1`;
    storage.objects.set(storageKey, bytes);
    const revisionId = `revision-${revisions.length + 1}`;
    revisions.push({
      id: revisionId,
      revision: 1,
      artifactId,
      formatVersion: 1,
      seqFrom: 0,
      seqTo: 0,
      sizeBytes: bytes.length,
      sha256: digestOf(bytes),
      storageKey,
      blockIndex: null,
      createdAt: NOW,
    });
    artifacts.set(artifactId, {
      ownerId: input.ownerId,
      title: input.title,
      kind: input.kind,
      publishedSeq: 0,
      currentRevisionId: revisionId,
    });
    return {
      artifactId,
      revisionId,
      revisionNumber: 1,
      sizeBytes: bytes.length,
      observedSizeBytes: bytes.length,
      sha256: digestOf(bytes),
      seq: 0,
    };
  };
  const gate = async (ownerId: string, artifactId: string): Promise<McpResult<{ kind: string }>> => {
    const artifact = artifacts.get(artifactId);
    if (!artifact || artifact.ownerId !== ownerId)
      return { ok: false, kind: "not_found", reason: "artifact_not_visible_to_owner" };
    if (!acceptsTextOperations(artifact.kind))
      return {
        ok: false,
        kind: "wrong_kind",
        reason: "artifact_is_not_a_markdown_document",
        artifactKind: artifact.kind,
      };
    return { ok: true, value: { kind: artifact.kind } };
  };
  const backend: McpBackend = {
    caps: CAPS,
    documentCreate: async ({
      ownerId,
      title,
      kind,
      text,
    }: McpDocumentCreateInput): Promise<McpResult<McpDocumentCreated>> => {
      const body = text !== undefined && text.trim().length > 0 ? text : `# ${title}\n`;
      const created = seed({ ownerId, title, kind: kind ?? "markdown", text: body });
      const opened = await openDraft({ store, storage, artifactId: created.artifactId });
      if (!opened.ok) return { ok: false, kind: opened.kind, reason: opened.reason };
      return { ok: true, value: { ...created, seq: opened.value.seq } };
    },
    documentOpen: async (ownerId: string, artifactId: string): Promise<McpResult<McpDocumentState>> => {
      const gated = await gate(ownerId, artifactId);
      if (!gated.ok) return gated;
      const opened = await openDraft({ store, storage, artifactId });
      if (!opened.ok) return { ok: false, kind: opened.kind, reason: opened.reason };
      return {
        ok: true,
        value: { artifactId, kind: gated.value.kind, seq: opened.value.seq, text: opened.value.text },
      };
    },
    documentTextAt: async (ownerId: string, artifactId: string, seq: number): Promise<McpResult<McpDocumentText>> => {
      const gated = await gate(ownerId, artifactId);
      if (!gated.ok) return gated;
      const resolved = await textAt({ store, storage, artifactId, seq });
      if (!resolved.ok) return { ok: false, kind: resolved.kind, reason: resolved.reason };
      return { ok: true, value: { artifactId, seq: resolved.value.seq, text: resolved.value.text } };
    },
    documentApply: async (input: McpDocumentApplyInput): Promise<McpResult<McpDocumentApplied>> => {
      const gated = await gate(input.ownerId, input.artifactId);
      if (!gated.ok) return gated;
      const applied = await applyOperationsAndFreeze({
        store,
        storage,
        artifactId: input.artifactId,
        authorKind: input.authorKind,
        authorId: input.authorId,
        baseSeq: input.baseSeq,
        idempotencyKey: input.idempotencyKey,
        ops: input.ops,
        now: NOW,
      });
      if (!applied.ok)
        return {
          ok: false,
          kind: applied.kind,
          reason: applied.reason,
          currentSeq: applied.currentSeq,
          opIndex: applied.opIndex,
        };
      return {
        ok: true,
        value: {
          artifactId: input.artifactId,
          seq: applied.value.seq,
          applied: applied.value.applied,
          replayed: applied.value.replayed,
          published: applied.value.published,
          revisionId: applied.value.revisionId,
        },
      };
    },
    documentPublish: async (ownerId: string, artifactId: string) => {
      const gated = await gate(ownerId, artifactId);
      if (!gated.ok) return gated;
      const frozen = await publish({ store, storage, artifactId, now: NOW });
      if (!frozen.ok) return { ok: false, kind: frozen.kind, reason: frozen.reason };
      const value = frozen.value;
      if (value.revisionId === null || value.revisionNumber === null || value.seqFrom === null)
        return { ok: false, kind: "nothing_to_publish", reason: "no_pending_operations" };
      return {
        ok: true,
        value: {
          artifactId,
          revisionId: value.revisionId,
          revisionNumber: value.revisionNumber,
          seqFrom: value.seqFrom,
          seqTo: value.publishedSeq,
        },
      };
    },
  } as unknown as McpBackend;
  return { backend, store, storage, artifacts, drafts, operations, revisions, seed };
}

type ToolPayload = Record<string, unknown>;
type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown };

const connect = async (
  workspace: ReturnType<typeof fakeWorkspace>,
  scopes: string[] = WRITE_SCOPES,
): Promise<{
  callTool: (name: string, args: ToolPayload) => Promise<ToolResult>;
  names: string[];
  tools: { name: string; _meta?: { ui?: unknown } }[];
}> => {
  const server = createArtifactTools({
    backend: workspace.backend,
    requireScope: "artifacts:write",
    readScope: "artifacts:read",
  })({ userId: OWNER, scopes });
  const client = new Client({ name: "document-tools-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const tools = (await client.listTools()).tools as unknown as { name: string; _meta?: { ui?: unknown } }[];
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
const textOf = (workspace: ReturnType<typeof fakeWorkspace>, artifactId: string): string => {
  const draft = workspace.drafts.get(artifactId);
  if (!draft) return "";
  return (draft.state as { text: string }).text;
};
const seqOf = (workspace: ReturnType<typeof fakeWorkspace>, artifactId: string): number | undefined =>
  workspace.drafts.get(artifactId)?.seq;

const BIG_DOCUMENT = (): string => {
  const section = (index: number): string =>
    `## Section ${index}\n\n${Array.from({ length: 1000 }, (_, word) => `w${index}-${word}`).join(" ")}`;
  return ["# Big document", ...Array.from({ length: 20 }, (_, index) => section(index + 1))].join("\n\n");
};

test("document_create creates a document inside the product with no upload step", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes" }));
  assert.deepEqual(Object.keys(created).sort(), [
    "artifactId",
    "observedSizeBytes",
    "revisionId",
    "revisionNumber",
    "seq",
    "sha256",
    "sizeBytes",
  ]);
  assert.equal(created.seq, 0);
  assert.equal(created.revisionNumber, 1);
  assert.equal("createUpload" in workspace.backend, false, "the created document needs no staging upload");
  assert.equal(workspace.revisions.length, 1, "the initial text is the first published snapshot");
  assert.equal(workspace.operations.length, 0, "creation writes no operation row");
  assert.equal(textOf(workspace, String(created.artifactId)), "# Notes\n", "the title seeds the first heading");
  const outline = ok(await callTool("document_outline", { artifactId: created.artifactId }));
  const blocks = outline.blocks as ToolPayload[];
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.line, block.level]),
    [["heading", 1, 1]],
    "the seeded document is one level-one heading",
  );
});

test("one replace_text on a twenty-thousand-word document appends one operation row and no snapshot object", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const text = BIG_DOCUMENT();
  assert.equal(text.split(" ").length > 20_000, true, "the fixture is over twenty thousand words");
  const created = ok(await callTool("document_create", { title: "Big", text }));
  const revisionsBefore = workspace.revisions.length;
  const objectsBefore = workspace.storage.objects.size;
  const applied = ok(
    await callTool("document_apply", {
      artifactId: created.artifactId,
      baseSeq: 0,
      idempotencyKey: "edit-1",
      ops: [{ op: "replace_text", find: "w1-1 ", replace: "w1-1 edited " }],
    }),
  );
  assert.deepEqual(applied, {
    artifactId: created.artifactId,
    baseSeq: 0,
    seq: 1,
    applied: 1,
    replayed: false,
    published: false,
    revisionId: null,
  });
  assert.equal(workspace.operations.length, 1, "exactly one operation row");
  assert.equal(workspace.operations[0]?.seq, 1);
  assert.equal(workspace.revisions.length, revisionsBefore, "no new snapshot object");
  assert.equal(workspace.storage.objects.size, objectsBefore, "nothing reached storage again");
  assert.match(textOf(workspace, String(created.artifactId)), /w1-1 edited w1-2/);
});

test("document_apply below the threshold reports published false and writes no snapshot", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Notes\n" }));
  const artifactId = String(created.artifactId);
  const before = workspace.storage.objects.size;
  const first = ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 0,
      idempotencyKey: "edit-1",
      ops: [{ op: "append_blocks", text: "first" }],
    }),
  );
  const second = ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 1,
      idempotencyKey: "edit-2",
      ops: [{ op: "append_blocks", text: "second" }],
    }),
  );
  assert.deepEqual([first.published, first.revisionId], [false, null]);
  assert.deepEqual([second.published, second.revisionId], [false, null]);
  assert.equal(workspace.operations.length, 2, "one operation row per accepted write");
  assert.equal(workspace.revisions.length, 1, "no snapshot below the threshold");
  assert.equal(workspace.storage.objects.size, before, "no snapshot object is written");
  assert.equal(workspace.artifacts.get(artifactId)?.publishedSeq, 0, "the published pointer stays where it was");
});

test("the operation that crosses the freeze threshold publishes the edited text", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Notes\n" }));
  const artifactId = String(created.artifactId);
  for (let index = 1; index <= 99; index += 1) {
    const applied = ok(
      await callTool("document_apply", {
        artifactId,
        baseSeq: index - 1,
        idempotencyKey: `op-${index}`,
        ops: [{ op: "append_blocks", text: `- block ${index}` }],
      }),
    );
    assert.deepEqual([applied.published, applied.revisionId], [false, null], `operation ${index} is below`);
  }
  assert.equal(workspace.revisions.length, 1, "ninety-nine operations create no snapshot");
  const crossing = ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 99,
      idempotencyKey: "op-100",
      ops: [{ op: "replace_text", find: "# Notes", replace: "# Notes edited" }],
    }),
  );
  assert.equal(crossing.published, true, "the hundredth operation freezes");
  assert.equal(typeof crossing.revisionId, "string");
  assert.equal(workspace.revisions.length, 2, "exactly one new snapshot");
  const snapshot = workspace.revisions[1] as FakeRevision;
  assert.equal(snapshot.id, crossing.revisionId);
  assert.deepEqual([snapshot.seqFrom, snapshot.seqTo, snapshot.formatVersion], [1, 100, 1]);
  assert.equal(snapshot.revision, 2);
  const bytes = workspace.storage.objects.get(snapshot.storageKey);
  assert.ok(bytes, "the snapshot reaches storage");
  const published = new TextDecoder().decode(bytes);
  assert.equal(published, textOf(workspace, artifactId), "the snapshot bytes are the canonical text");
  assert.match(published, /# Notes edited/, "the snapshot a viewer reads carries the edit");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.sha256);
  assert.equal(workspace.artifacts.get(artifactId)?.publishedSeq, 100, "publishedSeq moves with the snapshot");
  assert.equal(workspace.artifacts.get(artifactId)?.currentRevisionId, snapshot.id);
  assert.equal(workspace.operations.length, 100, "every operation still has its own row");
});

test("document_publish freezes below the threshold and refuses when nothing is pending", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Notes\n" }));
  const artifactId = String(created.artifactId);
  ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 0,
      idempotencyKey: "edit-1",
      ops: [{ op: "replace_text", find: "# Notes", replace: "# Published" }],
    }),
  );
  ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 1,
      idempotencyKey: "edit-2",
      ops: [{ op: "append_blocks", text: "tail" }],
    }),
  );
  assert.equal(workspace.revisions.length, 1, "two operations alone publish nothing");
  const published = ok(await callTool("document_publish", { artifactId }));
  assert.deepEqual(published, {
    artifactId,
    revisionId: (workspace.revisions[1] as FakeRevision).id,
    revisionNumber: 2,
    seqFrom: 1,
    seqTo: 2,
  });
  const bytes = workspace.storage.objects.get((workspace.revisions[1] as FakeRevision).storageKey);
  assert.ok(bytes, "the published snapshot reaches storage");
  assert.equal(new TextDecoder().decode(bytes), textOf(workspace, artifactId));
  assert.match(new TextDecoder().decode(bytes), /# Published/);
  assert.equal(workspace.artifacts.get(artifactId)?.publishedSeq, 2);
  const again = refused(await callTool("document_publish", { artifactId }), "nothing_to_publish");
  assert.equal(again.message, "no_pending_operations", "the empty publish names its reason");
  assert.equal(workspace.revisions.length, 2, "a refused publish writes no snapshot");
  assert.equal(workspace.operations.length, 2);
  assert.equal(workspace.storage.objects.size, 2, "a refused publish writes no object");
});

test("the six previously registered document tools keep the answers they already had", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const shape = (payload: ToolPayload): string[] => Object.keys(payload).sort();
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Title\n\nparagraph\n" }));
  assert.deepEqual(shape(created), [
    "artifactId",
    "observedSizeBytes",
    "revisionId",
    "revisionNumber",
    "seq",
    "sha256",
    "sizeBytes",
  ]);
  const projection = ["artifactId", "blockCount", "blocks", "kind", "lineCount", "seq"];
  assert.deepEqual(shape(ok(await callTool("document_outline", { artifactId: created.artifactId }))), projection);
  assert.deepEqual(shape(ok(await callTool("document_read", { artifactId: created.artifactId }))), projection);
  assert.deepEqual(shape(ok(await callTool("document_query", { artifactId: created.artifactId, kind: "heading" }))), [
    "artifactId",
    "matchCount",
    "matches",
    "seq",
    "truncated",
  ]);
  assert.deepEqual(shape(ok(await callTool("document_diff", { artifactId: created.artifactId, fromSeq: 0 }))), [
    "artifactId",
    "changeCount",
    "changes",
    "fromSeq",
    "toSeq",
    "truncated",
  ]);
  assert.deepEqual(
    shape(
      ok(
        await callTool("document_apply", {
          artifactId: created.artifactId,
          baseSeq: 0,
          idempotencyKey: "shape",
          ops: [{ op: "append_blocks", text: "tail" }],
        }),
      ),
    ),
    ["applied", "artifactId", "baseSeq", "published", "replayed", "revisionId", "seq"],
    "document_apply keeps its six fields and adds only the freeze report",
  );
});

test("a windowed read returns only the requested blocks or range and a far smaller payload", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const text = BIG_DOCUMENT();
  const created = ok(await callTool("document_create", { title: "Big", text }));
  const outline = ok(await callTool("document_outline", { artifactId: created.artifactId }));
  const blocks = outline.blocks as ToolPayload[];
  assert.equal(outline.lineCount, text.split("\n").length);
  assert.equal(JSON.stringify(outline).includes("w1-1"), false, "the outline never carries the text");
  const target = blocks[4] as ToolPayload;
  const window = ok(await callTool("document_read", { artifactId: created.artifactId, blockIds: [target.id] }));
  const readBlocks = window.blocks as ToolPayload[];
  assert.equal(readBlocks.length, 1);
  assert.equal(readBlocks[0]?.id, target.id);
  assert.equal(readBlocks[0]?.line, target.line);
  assert.equal(text.includes(String(readBlocks[0]?.text)), true, "the read text is the run of source lines");
  assert.equal(JSON.stringify(window).length * 10 < text.length, true, "the payload is far smaller than the document");
  const range = ok(await callTool("document_read", { artifactId: created.artifactId, from: 1, to: 3 }));
  assert.deepEqual(range.lines, text.split("\n").slice(0, 3));
  assert.equal(range.from, 1);
  assert.equal(range.to, 3);
  const projection = ok(await callTool("document_read", { artifactId: created.artifactId }));
  assert.equal(projection.blocks instanceof Array, true, "the default answer is the outline projection");
  assert.equal(Object.keys(projection).includes("lines"), false);
  assert.equal(JSON.stringify(projection).length * 10 < text.length, true);
});

test("document_outline and document_query return ids that document_read accepts", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(
    await callTool("document_create", {
      title: "Notes",
      text: "# Title\n\nintro paragraph\n\n- first\n- second\n\n```\ncode()\n```\n\n| a | b |\n| --- | --- |",
    }),
  );
  const outline = ok(await callTool("document_outline", { artifactId: created.artifactId }));
  const blocks = outline.blocks as ToolPayload[];
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "list-item", "list-item", "code-fence", "table"],
  );
  assert.equal(blocks[0]?.level, 1, "headings carry their level");
  assert.equal(blocks[1]?.level, undefined, "paragraphs carry no level");
  const byText = ok(await callTool("document_query", { artifactId: created.artifactId, text: "second" }));
  const byKind = ok(await callTool("document_query", { artifactId: created.artifactId, kind: "heading" }));
  assert.deepEqual(
    (byText.matches as ToolPayload[]).map((match) => Object.keys(match).sort()),
    [["id", "kind", "line"]],
    "query answers with ids and line numbers only",
  );
  for (const id of [
    ...blocks.map((block) => block.id),
    ...(byText.matches as ToolPayload[]).map((m) => m.id),
    ...(byKind.matches as ToolPayload[]).map((m) => m.id),
  ]) {
    const read = ok(await callTool("document_read", { artifactId: created.artifactId, blockIds: [id] }));
    assert.equal((read.blocks as ToolPayload[])[0]?.id, id, `document_read accepts ${String(id)}`);
  }
});

test("a stale baseSeq is refused with the current sequence", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes" }));
  ok(
    await callTool("document_apply", {
      artifactId: created.artifactId,
      baseSeq: 0,
      idempotencyKey: "edit-1",
      ops: [{ op: "append_blocks", text: "## More" }],
    }),
  );
  const stale = refused(
    await callTool("document_apply", {
      artifactId: created.artifactId,
      baseSeq: 0,
      idempotencyKey: "edit-2",
      ops: [{ op: "append_blocks", text: "## Later" }],
    }),
    "concurrent_edit",
  );
  assert.equal(stale.currentSeq, 1);
  assert.equal(workspace.operations.length, 1, "a stale write appends no row");
  assert.equal(seqOf(workspace, String(created.artifactId)), 1);
});

test("replaying the same idempotencyKey applies exactly once", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes" }));
  const args = {
    artifactId: created.artifactId,
    baseSeq: 0,
    idempotencyKey: "same-key",
    ops: [{ op: "append_blocks", text: "## Once" }],
  };
  const first = ok(await callTool("document_apply", args));
  const replay = ok(await callTool("document_apply", args));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.seq, 1);
  assert.equal(workspace.operations.length, 1, "the replay appends no row");
  assert.equal(textOf(workspace, String(created.artifactId)).match(/## Once/g)?.length, 1, "applied exactly once");
});

test("a batch with a failing operation reports its index and leaves the text and sequence unchanged", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Title\n\nkept\n" }));
  const before = textOf(workspace, String(created.artifactId));
  const failure = refused(
    await callTool("document_apply", {
      artifactId: created.artifactId,
      baseSeq: 0,
      idempotencyKey: "bad-batch",
      ops: [
        { op: "append_blocks", text: "## Extra" },
        { op: "replace_text", find: "absent", replace: "nothing" },
      ],
    }),
    "invalid_operation",
  );
  assert.equal(failure.opIndex, 1, "the failing operation index is reported");
  assert.equal(failure.message, "text_not_found", "the named reason travels");
  assert.equal(textOf(workspace, String(created.artifactId)), before, "the text is unchanged");
  assert.equal(seqOf(workspace, String(created.artifactId)), 0, "the sequence is unchanged");
  assert.equal(workspace.operations.length, 1, "the refused batch appends its rejected row");
  assert.equal(workspace.operations[0]?.result, "rejected");
  const outline = ok(await callTool("document_outline", { artifactId: created.artifactId }));
  assert.equal(outline.seq, 0, "the tool still reports the unchanged sequence");
  assert.equal((outline.blocks as ToolPayload[]).length, 2, "no partial application");
});

test("document_diff reports a change made through the service by another author", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const created = ok(
    await callTool("document_create", { title: "Notes", text: "# Title\n\nfirst paragraph\n\nsecond paragraph\n" }),
  );
  const artifactId = String(created.artifactId);
  ok(
    await callTool("document_apply", {
      artifactId,
      baseSeq: 0,
      idempotencyKey: "agent-1",
      ops: [{ op: "replace_text", find: "second paragraph", replace: "second paragraph edited" }],
    }),
  );
  const human = await applyOperations({
    store: workspace.store,
    storage: workspace.storage,
    artifactId,
    authorKind: "person",
    authorId: "human-1",
    baseSeq: 1,
    idempotencyKey: "human-edit",
    ops: [{ op: "replace_text", find: "# Title", replace: "# Renamed" }],
    now: NOW,
  });
  assert.equal(human.ok, true, human.ok ? "" : human.reason);
  const diff = ok(await callTool("document_diff", { artifactId, fromSeq: 1 }));
  assert.equal(diff.fromSeq, 1);
  assert.equal(diff.toSeq, 2, "the current sequence is the default right side");
  const changes = diff.changes as ToolPayload[];
  assert.equal(changes.length, 1, "only the block the other author changed is reported");
  assert.equal(changes[0]?.status, "changed");
  assert.equal(changes[0]?.line, 1);
  assert.equal(changes[0]?.fromLine, 1);
  assert.equal(typeof changes[0]?.id, "string");
  assert.equal(typeof changes[0]?.fromId, "string");
  assert.notEqual(changes[0]?.id, changes[0]?.fromId, "a changed block keeps its previous identity as fromId");
  const fromCreation = ok(await callTool("document_diff", { artifactId, fromSeq: 0, toSeq: 2 }));
  assert.deepEqual(
    (fromCreation.changes as ToolPayload[]).map((change) => change.status),
    ["changed", "changed"],
    "both edits are reported against the created document",
  );
});

test("every document_* tool refuses a kind whose write mode is not text operations", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace);
  const html = workspace.seed({ ownerId: OWNER, title: "Page", kind: "html", text: "<p>page</p>" });
  const refusals: [string, ToolPayload][] = [
    ["document_outline", { artifactId: html.artifactId }],
    ["document_read", { artifactId: html.artifactId }],
    ["document_query", { artifactId: html.artifactId, text: "page" }],
    ["document_diff", { artifactId: html.artifactId, fromSeq: 0 }],
    [
      "document_apply",
      { artifactId: html.artifactId, baseSeq: 0, idempotencyKey: "html", ops: [{ op: "append_blocks", text: "x" }] },
    ],
    ["document_publish", { artifactId: html.artifactId }],
    ["document_create", { title: "Page", kind: "html" }],
  ];
  for (const [name, args] of refusals) {
    const payload = refused(await callTool(name, args), "wrong_kind");
    if (name !== "document_create") assert.equal(payload.kind, "html", `${name} names the refused kind`);
  }
  assert.equal(workspace.drafts.has(html.artifactId), false, "a refused kind materialises no draft");
  assert.equal(workspace.operations.length, 0, "a refused kind writes no operation");
  assert.equal(workspace.revisions.length, 1, "a refused create adds no snapshot");
});

test("every document_* tool checks the scope of its own call", async () => {
  const workspace = fakeWorkspace();
  const { callTool } = await connect(workspace, []);
  const calls: [string, ToolPayload][] = [
    ["document_create", { title: "Notes" }],
    ["document_outline", { artifactId: "artifact-1" }],
    ["document_read", { artifactId: "artifact-1" }],
    ["document_query", { artifactId: "artifact-1", text: "x" }],
    ["document_diff", { artifactId: "artifact-1", fromSeq: 0 }],
    [
      "document_apply",
      { artifactId: "artifact-1", baseSeq: 0, idempotencyKey: "k", ops: [{ op: "append_blocks", text: "x" }] },
    ],
    ["document_publish", { artifactId: "artifact-1" }],
  ];
  for (const [name, args] of calls) refused(await callTool(name, args), "insufficient_scope");
  assert.equal(workspace.revisions.length, 0, "no scope means no write");
});

test("the document tools register alongside every artifact tool", async () => {
  const workspace = fakeWorkspace();
  const { names } = await connect(workspace);
  assert.deepEqual(names.slice().sort(), [...ARTIFACT_TOOL_NAMES].sort());
  for (const name of [
    "artifact_write",
    "artifact_edit_lines",
    "artifact_get_markdown",
    "artifact_commit",
    "artifact_start_upload",
  ])
    assert.equal(names.includes(name), true, `${name} stays registered`);
});

test("the document tools answer in JSON only: no UI binding, no HTML and no URLs", async () => {
  const workspace = fakeWorkspace();
  const { callTool, tools } = await connect(workspace);
  for (const name of DOCUMENT_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is advertised`);
    assert.equal(tool._meta?.ui, undefined, `${name} binds no UI resource`);
  }
  const created = ok(await callTool("document_create", { title: "Notes", text: "# Title\n\nparagraph\n" }));
  const responses = [
    created,
    ok(await callTool("document_outline", { artifactId: created.artifactId })),
    ok(await callTool("document_read", { artifactId: created.artifactId })),
    ok(await callTool("document_query", { artifactId: created.artifactId, kind: "heading" })),
    ok(await callTool("document_diff", { artifactId: created.artifactId, fromSeq: 0 })),
    ok(
      await callTool("document_apply", {
        artifactId: created.artifactId,
        baseSeq: 0,
        idempotencyKey: "json-only",
        ops: [{ op: "append_blocks", text: "tail" }],
      }),
    ),
    ok(await callTool("document_publish", { artifactId: created.artifactId })),
  ];
  for (const response of responses) {
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes("<"), false, "no HTML reaches the wire");
    assert.equal(/https?:\/\//.test(serialized), false, "no URL reaches the wire");
  }
});
