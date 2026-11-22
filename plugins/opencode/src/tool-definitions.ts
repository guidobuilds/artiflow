import { ARTIFACT_KINDS } from "@artiflow/domain/kinds";

export interface ToolDefinition {
  name: string;
  description: string;
  properties: Record<string, { type: string }>;
  required: string[];
}

const string = { type: "string" };
const lines = { type: "array", items: { type: "string" } };
const newLines = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1000 };
const writeKind = { type: "string", enum: [...ARTIFACT_KINDS] };

const lineOps = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    oneOf: [
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["replace"] },
          from: { type: "number", minimum: 1 },
          to: { type: "number", minimum: 1 },
          expect: lines,
          text: newLines,
        },
        required: ["op", "from", "to", "text"],
      },
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["insert"] },
          after: { type: "number", minimum: 0 },
          text: newLines,
        },
        required: ["op", "after", "text"],
      },
      {
        type: "object",
        properties: {
          op: { type: "string", enum: ["delete"] },
          from: { type: "number", minimum: 1 },
          to: { type: "number", minimum: 1 },
          expect: lines,
        },
        required: ["op", "from", "to"],
      },
    ],
  },
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "get",
    description: "Read one Artiflow revision as base64 (current or pinned).",
    properties: { artifactId: string, revisionId: string },
    required: ["artifactId"],
  },
  {
    name: "get_markdown",
    description: "Read an Artiflow markdown document as numbered lines, optionally from/to.",
    properties: { artifactId: string, from: { type: "number" }, to: { type: "number" } },
    required: ["artifactId"],
  },
  {
    name: "edit_lines",
    description:
      "Bounded line edits on one owned markdown artifact: ops replace/insert/delete with 1-indexed inclusive ranges, applied in order and committed as one new revision. expectedRevisionId is required; each op may carry expect (the exact current lines) or the call refuses with the live window. A stale pointer returns concurrent_edit with currentRevisionId — re-read with get_markdown and retry once with that fresh pointer, never blind-retry or overwrite.",
    properties: { artifactId: string, expectedRevisionId: string, ops: lineOps },
    required: ["artifactId", "expectedRevisionId", "ops"],
  },
  {
    name: "list_comments",
    description:
      "Read-only listing of an owned markdown document's comment threads: roots with ordered nested replies, plus source anchors, quotes and resolution timestamps. Creates no revisions. Results reflect the latest document state, so anchors and quotes can be stale after edits — treat ambiguity as uncertainty, do not guess.",
    properties: { artifactId: string },
    required: ["artifactId"],
  },
  {
    name: "write",
    description:
      "Inline write for small payloads; use write_file for large HTML/markdown (model output-token limit). Optional kind html/markdown and title. To update an existing artifact pass artifactId together with expectedRevisionId; a stale expectedRevisionId refuses with concurrent_commit or concurrent_edit and currentRevisionId instead of overwriting. Instance validation and typed errors are returned unchanged.",
    properties: { text: string, kind: string, title: string, artifactId: string, expectedRevisionId: string },
    required: ["text"],
  },
  {
    name: "write_file",
    description:
      "Inline `write` for small payloads; write large HTML/markdown to a file with normal file tools first, then call write_file — tool arguments cannot carry very large payloads (model output-token limit). Reads a local UTF-8 file; relative paths resolve against process.cwd(). .md/.markdown default to markdown, otherwise html; kind overrides. artifactId is only used together with expectedRevisionId, which must be the current revision. File-not-found and invalid-UTF-8 errors do not submit a write.",
    properties: { path: string, kind: writeKind, title: string, artifactId: string, expectedRevisionId: string },
    required: ["path"],
  },
];
