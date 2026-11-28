import { ARTIFACT_KINDS } from "@artiflow/domain/kinds";
import { sceneApplyInputSchema, sceneOutlineInputSchema, sceneReadInputSchema } from "@artiflow/plugin-core/tools";

export interface ToolDefinition {
  name: string;
  description: string;
  properties: Record<string, unknown>;
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
  {
    name: "scene_outline",
    description:
      "Frame index of one owned canvas artifact: frame ids, names, geometry and node counts, plus the loose canvas-level node count. Read-only; it creates no revision and no scene state.",
    properties: sceneOutlineInputSchema.properties,
    required: sceneOutlineInputSchema.required,
  },
  {
    name: "scene_read",
    description:
      "Read one frame of an owned canvas by frameId, or the canvas-level nodes when no frame is given; optional nodeIds narrows the reply to those nodes. Read-only; it creates no revision. A window over the read caps refuses with too_large; an id the scene does not hold refuses with unknown_frame or unknown_node.",
    properties: sceneReadInputSchema.properties,
    required: sceneReadInputSchema.required,
  },
  {
    name: "scene_apply",
    description:
      "One atomic batch of canvas operations against baseSeq: add/update/move/reorder/remove frames, nodes, canvas nodes, design pages, the guides spec and the per-frame lock, or replace_scene. idempotencyKey makes a retried batch replay instead of applying twice. A stale baseSeq refuses with concurrent_edit carrying currentSeq — re-read with scene_outline or scene_read and retry once with that fresh sequence, never blind-retry. The reply carries the new sequence with the computed boxes and violations.",
    properties: sceneApplyInputSchema.properties,
    required: sceneApplyInputSchema.required,
  },
];
