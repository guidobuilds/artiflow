import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Associations, type AssociationEvent } from "@artiflow/plugin-core/associations";
import { ArtifactRefusal, type ArtifactApi } from "@artiflow/plugin-core/core";
import { executeArtifactTool } from "@artiflow/plugin-core/tools";
import { toolDefinitions } from "../plugins/opencode/src/tool-definitions.ts";

type Recorded = { operation: string; input: unknown };

function harness(
  overrides: Partial<Record<"write" | "get" | "getMarkdown" | "editLines" | "listComments", unknown>> = {},
) {
  const stored = new Map();
  const events: AssociationEvent[] = [];
  const calls: Recorded[] = [];
  const signals: (AbortSignal | undefined)[] = [];
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
    if (value instanceof Error) throw value;
    return value as T;
  };
  const api = {
    probe: async () => record("probe", undefined, undefined),
    metadata: async (input: unknown) => record("metadata", {}, input),
    get: async (input: unknown) => record("get", overrides.get ?? { artifactId: "a" }, input),
    getMarkdown: async (input: unknown) =>
      record(
        "getMarkdown",
        overrides.getMarkdown ?? {
          artifactId: "a",
          revisionId: "r1",
          lineCount: 2,
          from: 1,
          to: 2,
          lines: ["# A", ""],
        },
        input,
      ),
    editLines: async (input: unknown) =>
      record(
        "editLines",
        overrides.editLines ?? { artifactId: "a", revisionId: "r2", revisionNumber: 2, lineCount: 2, appliedOps: 1 },
        input,
      ),
    listComments: async (input: unknown) => record("listComments", overrides.listComments ?? { comments: [] }, input),
    write: async (input: unknown) =>
      record(
        "write",
        overrides.write ?? {
          artifactId: "a",
          revisionId: "r1",
          revisionNumber: 1,
          sizeBytes: 5,
          observedSizeBytes: 5,
          sha256: "0".repeat(64),
        },
        input,
      ),
  };
  const auth = {
    api: async <T>(operation: (client: ArtifactApi) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const pending = operation(api as unknown as ArtifactApi);
      signals.push(signal);
      return pending;
    },
  };
  const context = { sessionID: "s", signal: new AbortController().signal };
  return { associations, events, calls, signals, auth, api, context };
}

const ops = [
  { op: "replace", from: 1, to: 1, expect: ["# Draft"], text: ["# Title"] },
  { op: "insert", after: 2, text: ["Extra line"] },
  { op: "delete", from: 4, to: 4 },
];

test("edit_lines calls the v1 line-edit operation once, passes the reply through and records no association", async () => {
  const h = harness();
  const input = { artifactId: "a", expectedRevisionId: "r1", ops };
  assert.deepEqual(await executeArtifactTool("edit_lines", input, h.context, h.auth, h.associations), {
    content: JSON.stringify({
      artifactId: "a",
      revisionId: "r2",
      revisionNumber: 2,
      lineCount: 2,
      appliedOps: 1,
    }),
  });
  assert.deepEqual(h.calls, [{ operation: "editLines", input }]);
  assert.deepEqual(h.events, []);
  assert.deepEqual(await h.associations.list("s"), []);
});

test("list_comments is read-only: one v1 read, unchanged reply and no association", async () => {
  const h = harness({ listComments: { comments: [{ id: "c1", replies: [] }] } });
  const input = { artifactId: "a" };
  assert.deepEqual(await executeArtifactTool("list_comments", input, h.context, h.auth, h.associations), {
    content: JSON.stringify({ comments: [{ id: "c1", replies: [] }] }),
  });
  assert.deepEqual(h.calls, [{ operation: "listComments", input }]);
  assert.deepEqual(h.events, []);
  assert.deepEqual(await h.associations.list("s"), []);
});

test("get reads bytes through the v1 operation with the caller signal", async () => {
  const h = harness();
  const input = { artifactId: "a", revisionId: "r1" };
  await executeArtifactTool("get", input, h.context, h.auth, h.associations);
  assert.deepEqual(h.calls, [{ operation: "get", input }]);
  assert.equal(h.signals[0], h.context.signal);
});

test("get_markdown keeps its window reply and records nothing", async () => {
  const h = harness();
  const input = { artifactId: "a", from: 1, to: 2 };
  await executeArtifactTool("get_markdown", input, h.context, h.auth, h.associations);
  assert.deepEqual(h.calls, [{ operation: "getMarkdown", input }]);
  assert.deepEqual(h.events, []);
});

test("a concurrent_edit refusal is returned unchanged with exactly one call and no retry", async () => {
  const refusal = {
    error: "concurrent_edit",
    message: "document_changed_since_read",
    currentRevisionId: "r2",
  };
  const h = harness({ editLines: new ArtifactRefusal(refusal) });
  const input = { artifactId: "a", expectedRevisionId: "r1", ops: [{ op: "delete", from: 1, to: 1 }] };
  assert.deepEqual(await executeArtifactTool("edit_lines", input, h.context, h.auth, h.associations), {
    content: JSON.stringify(refusal),
  });
  assert.deepEqual(h.calls, [{ operation: "editLines", input }]);
  assert.deepEqual(h.events, []);
  assert.deepEqual(await h.associations.list("s"), []);
});

test("an instance refusal on write is returned verbatim and records no association", async () => {
  const refusal = { error: "wrong_kind", message: "artifact_kind_mismatch" };
  const h = harness({ write: new ArtifactRefusal(refusal) });
  assert.deepEqual(
    await executeArtifactTool(
      "write",
      { text: "<p>x</p>", artifactId: "a", expectedRevisionId: "r1" },
      h.context,
      h.auth,
      h.associations,
    ),
    { content: JSON.stringify(refusal) },
  );
  assert.deepEqual(h.events, []);
});

test("a created artifact records its association from the flat v1 reply", async () => {
  const h = harness();
  const input = { text: "# Title", kind: "markdown" };
  await executeArtifactTool("write", input, h.context, h.auth, h.associations);
  assert.deepEqual(h.events, [
    { sessionID: "s", artifactId: "a", title: "Title", kind: "markdown", action: "created" },
  ]);
});

interface OpSchema {
  properties: Record<
    string,
    { type?: string; enum?: string[]; minimum?: number; maxItems?: number; minItems?: number } | undefined
  >;
  required: string[];
}

const byName = new Map(toolDefinitions.map((definition) => [definition.name, definition] as const));

test("edit_lines declares the line-op union the v1 document save accepts", () => {
  const definition = byName.get("edit_lines");
  assert.ok(definition);
  assert.deepEqual(definition.required, ["artifactId", "expectedRevisionId", "ops"]);
  assert.deepEqual(Object.keys(definition.properties), ["artifactId", "expectedRevisionId", "ops"]);
  const schema = definition.properties.ops as unknown as {
    type: string;
    minItems: number;
    maxItems: number;
    items: { oneOf: OpSchema[] };
  };
  assert.equal(schema.type, "array");
  assert.equal(schema.minItems, 1);
  assert.equal(schema.maxItems, 50);
  const [replace, insert, remove] = schema.items.oneOf;
  assert.deepEqual(replace?.properties.op?.enum, ["replace"]);
  assert.deepEqual(insert?.properties.op?.enum, ["insert"]);
  assert.deepEqual(remove?.properties.op?.enum, ["delete"]);
  assert.deepEqual(replace?.required, ["op", "from", "to", "text"]);
  assert.deepEqual(insert?.required, ["op", "after", "text"]);
  assert.deepEqual(remove?.required, ["op", "from", "to"]);
  assert.equal(replace?.properties.text?.type, "array");
  assert.equal(replace?.properties.text?.minItems, 1);
  assert.equal(replace?.properties.text?.maxItems, 1000);
  assert.equal(insert?.properties.text?.type, "array");
  assert.equal(insert?.properties.text?.minItems, 1);
  assert.equal(insert?.properties.text?.maxItems, 1000);
  assert.equal(replace?.properties.from?.minimum, 1);
  assert.equal(replace?.properties.to?.minimum, 1);
  assert.equal(insert?.properties.after?.minimum, 0);
  assert.equal(replace?.properties.expect?.type, "array");
  assert.equal(remove?.properties.expect?.type, "array");
  assert.equal(insert?.properties.expect, undefined);
});

test("list_comments declares only artifactId", () => {
  const definition = byName.get("list_comments");
  assert.ok(definition);
  assert.deepEqual(definition.required, ["artifactId"]);
  assert.deepEqual(Object.keys(definition.properties), ["artifactId"]);
});

test("the server entry registers every definition in the artiflow namespace through the shared executor", async () => {
  const source = await readFile(new URL("../plugins/opencode/src/index.ts", import.meta.url), "utf8");
  assert.match(source, /editor\.namespace\(\{ name: "artiflow"/);
  assert.match(source, /for \(const definition of toolDefinitions\)/);
  assert.match(source, /options: \{ namespace: "artiflow" \}/);
  assert.match(source, /executeArtifactTool\(definition\.name, input, context, auth, associations\)/);
});

test("descriptions surface conflict recovery, preconditions and comment read-only semantics", () => {
  const edit = byName.get("edit_lines");
  const list = byName.get("list_comments");
  const write = byName.get("write");
  assert.ok(edit && list && write);
  assert.match(edit.description, /expectedRevisionId is required/);
  assert.match(edit.description, /concurrent_edit/);
  assert.match(edit.description, /currentRevisionId/);
  assert.match(edit.description, /get_markdown/);
  assert.match(edit.description, /never blind-retry or overwrite/);
  assert.match(list.description, /read-only/i);
  assert.match(list.description, /creates no revisions/i);
  assert.match(write.description, /artifactId together with expectedRevisionId/);
});
